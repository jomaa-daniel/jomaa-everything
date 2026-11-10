#!/usr/bin/env python3
"""Deploy a GitHub-verified main revision to the native hub (no inbound ports)."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import hubctl

SOURCE = Path(__file__).resolve().parent.parent
DEPLOY_DIR = Path.home() / ".local/share/jomaa-home-deploy"
UNIT_DIR = Path.home() / ".config/systemd/user"
WEBHOOK_PATH = "/deploy"
WEBHOOK_PORT = 8091


class DeployError(Exception):
    pass


def run(*args: str, cwd: Path | None = None, capture: bool = False, env: dict | None = None) -> str:
    r = subprocess.run(args, cwd=cwd, check=True, text=True, stdout=subprocess.PIPE if capture else None,
                       env=env, timeout=300)
    return r.stdout.strip() if capture else ""


def quote(value: str) -> str:
    return json.dumps(value.replace("%", "%%"))


def github_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json",
                                                  "User-Agent": "jomaa-home-hub-deployer/1.0"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def verify_run(repo: str, sha: str, run_id: int, attempt: int) -> None:
    """Check the requested push and the completed verify job on GitHub."""
    owner, name = repo.split("/", 1)
    base = f"https://api.github.com/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(name)}"
    info = github_json(f"{base}/actions/runs/{run_id}")
    if (info.get("event") != "push" or info.get("head_branch") != "main" or info.get("head_sha") != sha
            or info.get("path") != ".github/workflows/hub-deploy-native.yml"
            or info.get("run_attempt") != attempt or info.get("repository", {}).get("full_name") != repo
            or info.get("status") not in ("in_progress", "completed")
            or info.get("conclusion") not in (None, "success")):
        raise DeployError("request does not match a main-branch deployment workflow run")
    jobs = github_json(f"{base}/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100").get("jobs", [])
    if not any(job.get("name") == "verify" and job.get("conclusion") == "success" for job in jobs):
        raise DeployError("GitHub has not reported a successful verification job")


def is_ancestor(repo: Path, ancestor: str, descendant: str) -> bool:
    result = subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor", ancestor, descendant],
                            timeout=20)
    if result.returncode not in (0, 1):
        raise DeployError("could not compare deployment revisions")
    return result.returncode == 0


def make_release(repo: Path, sha: str, source: Path, deploy_dir: Path) -> Path:
    """Materialize tracked hub files; link all local runtime state outside the release."""
    releases = deploy_dir / "releases"
    releases.mkdir(parents=True, exist_ok=True)
    target = releases / sha
    if target.exists():
        if (target / ".revision").read_text().strip() != sha:
            raise DeployError(f"existing release {target} has the wrong revision")
        return target
    with tempfile.TemporaryDirectory(prefix="release-", dir=releases) as tmp:
        folder = Path(tmp)
        archive = folder / "source.tar"
        with archive.open("wb") as out:
            subprocess.run(["git", "-C", str(repo), "archive", "--format=tar", sha, "jomaa-home-hub/"],
                           stdout=out, check=True, timeout=60)
        with tarfile.open(archive, "r:") as tar:
            tar.extractall(folder, filter="data")
        release = folder / "jomaa-home-hub"
        if not (release / "scripts/boot_native.py").is_file():
            raise DeployError("release does not contain the native hub")
        for name in (".env", "config.json", "data"):
            original = source / name
            if not original.exists():
                raise DeployError(f"missing local runtime state: {original}")
            (release / name).symlink_to(original.resolve(), target_is_directory=original.is_dir())
        (release / ".revision").write_text(sha + "\n")
        release.rename(target)
    return target


def switch_link(link: Path, destination: Path) -> None:
    tmp = link.with_name(link.name + ".new")
    tmp.unlink(missing_ok=True)
    tmp.symlink_to(destination, target_is_directory=True)
    os.replace(tmp, link)


def health() -> bool:
    try:
        req = urllib.request.Request("http://127.0.0.1:8080/healthz", headers={"User-Agent": "jomaa-deploy/1.0"})
        # Never send the local probe through an HTTP proxy.
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=2) as response:
            result = json.load(response)
            return response.status == 200 and bool(result.get("ok")) and bool(result.get("matterConnected"))
    except (OSError, ValueError):
        return False


def wait_health(timeout: float = 60) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if health():
            return True
        time.sleep(1)
    return False


def build_release(release: Path) -> None:
    """Install the pinned dependencies and build the hub from the exact source in the release."""
    if not shutil.which("npm"):
        raise DeployError("npm is not installed")
    run("npm", "ci", "--no-audit", "--no-fund", cwd=release)
    run("npm", "run", "build", cwd=release)


def prune_releases(deploy_dir: Path, keep: int = 3) -> None:
    """Delete all but the newest releases, never the current one. Each holds its own node_modules."""
    releases = deploy_dir / "releases"
    current = (deploy_dir / "current").resolve()
    built = sorted((r for r in releases.iterdir() if (r / ".revision").is_file()),
                   key=lambda r: r.stat().st_mtime, reverse=True)
    for old in built[keep:]:
        if old.resolve() != current:
            shutil.rmtree(old, ignore_errors=True)


def activate(release: Path, deploy_dir: Path) -> None:
    """Build an isolated release, then switch its single current pointer."""
    current = deploy_dir / "current"
    previous = current.resolve(strict=True)
    build_release(release)
    try:
        switch_link(current, release)
        run("systemctl", "--user", "restart", "jomaa-hub.service")
        if not wait_health():
            raise DeployError("new hub did not become healthy")
    except Exception:
        switch_link(current, previous)
        try:
            run("systemctl", "--user", "restart", "jomaa-hub.service")
            if not wait_health():
                print("warning: restored hub is not healthy", file=sys.stderr)
        except (OSError, subprocess.SubprocessError) as e:
            print(f"warning: could not restart restored hub: {e}", file=sys.stderr)
        raise


def deploy_service(cloudflared: Path, config: Path, hostname: str) -> str:
    """Ask cloudflared which service a /deploy request reaches; this also validates the file."""
    output = run(str(cloudflared), "--config", str(config), "tunnel", "ingress", "rule",
                 f"https://{hostname}{WEBHOOK_PATH}", capture=True)
    match = re.search(r"^\s*service: (\S+)\s*$", output, re.MULTILINE)
    return match.group(1) if match else ""


def configure_tunnel(source: Path, hostname: str) -> None:
    """Make /deploy reach the receiver, adding a path-specific rule ahead of the hub route if needed."""
    from cloudflare import Settings

    settings = Settings.from_env({"CLOUDFLARE_HOSTNAME": hostname})
    settings.require_configured()
    config = source / "data/native/tunnel.yml"
    cloudflared = source / "data/native/cloudflared"
    receiver = f"http://127.0.0.1:{WEBHOOK_PORT}"
    # cloudflared uses the first matching rule, so only it can say whether the route is reachable.
    if deploy_service(cloudflared, config, settings.hostname) == receiver:
        return
    original = config.read_text()
    marker = "# jomaa-deployment-webhook"
    rule = (f"  {marker}\n  - hostname: {json.dumps(settings.hostname)}\n"
            f"    path: ^{WEBHOOK_PATH}$\n    service: {receiver}\n")
    if rule in original:
        raise DeployError("a tunnel rule above the deployment route catches /deploy first; move the route up")
    if marker in original or WEBHOOK_PATH in original or original.count("ingress:\n") != 1:
        raise DeployError("tunnel configuration needs manual review before adding the deployment route")
    updated = original.replace("ingress:\n", "ingress:\n" + rule, 1)
    with tempfile.NamedTemporaryFile(mode="w", dir=config.parent, prefix=".tunnel-", delete=False) as f:
        temp = Path(f.name)
        f.write(updated)
    try:
        if deploy_service(cloudflared, temp, settings.hostname) != receiver:
            raise DeployError("a tunnel rule above the deployment route catches /deploy first; move the route up")
        os.replace(temp, config)
        try:
            run("systemctl", "--user", "restart", "jomaa-cloudflared.service")
        except Exception:
            config.write_text(original)
            run("systemctl", "--user", "restart", "jomaa-cloudflared.service")
            raise
    finally:
        temp.unlink(missing_ok=True)


def install(source: Path, deploy_dir: Path, repo: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise DeployError("repo must be OWNER/REPOSITORY")
    for name in ("jomaa-setup", "jomaa-hub", "jomaa-cloudflared"):
        if not (UNIT_DIR / (name + ".service")).is_file():
            raise DeployError(f"missing {name}.service; run native tunnel setup first")
    root = source.parent
    sha = run("git", "-C", str(root), "rev-parse", "HEAD", capture=True)
    if run("git", "-C", str(root), "status", "--porcelain", "--untracked-files=no", capture=True):
        raise DeployError("commit tracked changes before installing the deployment receiver")
    hostname = hubctl.load_env(source / ".env").get("CLOUDFLARE_HOSTNAME", "")
    if not hostname:
        raise DeployError("set CLOUDFLARE_HOSTNAME in .env to the existing public hub hostname")
    secret = deploy_dir / "webhook-secret"
    if not secret.exists():
        fd = os.open(secret, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secrets.token_hex(32))
    current = deploy_dir / "current"
    fresh = not current.exists()
    if not fresh:
        previous = current.resolve(strict=True)
        for name in (".env", "config.json", "data"):
            if (previous / name).resolve() != (source / name).resolve():
                raise DeployError("existing deployment points to another hub's runtime state")
        deployed = (previous / ".revision").read_text().strip()
        if not is_ancestor(root, deployed, sha):
            raise DeployError("checkout does not descend from the deployed revision")
    release = make_release(root, sha, source, deploy_dir)
    if not (release / "scripts/deploy_native.py").is_file():
        raise DeployError("commit the deployment script before installing the receiver")
    if fresh:
        build_release(release)
        switch_link(current, release)
    UNIT_DIR.mkdir(parents=True, exist_ok=True)
    script = current / "scripts/deploy_native.py"
    unit = (f"[Unit]\nDescription=Jomaa signed deployment receiver\nAfter=network-online.target\n"
            f"[Service]\nType=simple\n"
            f"Environment={quote('JOMAA_DEPLOY_SOURCE=' + str(source))}\n"
            f"Environment={quote('JOMAA_DEPLOY_REPO=' + repo)}\n"
            f"Environment={quote('JOMAA_DEPLOY_HOME=' + str(deploy_dir))}\n"
            f"ExecStart={quote(sys.executable)} {quote(str(script))} serve\n"
            f"Restart=always\nRestartSec=2\n[Install]\nWantedBy=default.target\n")
    (UNIT_DIR / "jomaa-deploy.service").write_text(unit)
    # Each service runs the current release's scripts, so the hub starts from
    # that release's build.
    for name, args in (("jomaa-setup", "setup_native.py --boot"), ("jomaa-hub", "boot_native.py hub"),
                       ("jomaa-cloudflared", "boot_native.py tunnel")):
        script_name, arg = args.split()
        directory = UNIT_DIR / (name + ".service.d")
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "deployment.conf").write_text(
            f"[Service]\nExecStart=\nExecStart={quote(sys.executable)} "
            f"{quote(str(current / 'scripts' / script_name))} {arg}\n")
    if (UNIT_DIR / "jomaa-deploy.timer").exists():
        run("systemctl", "--user", "disable", "--now", "jomaa-deploy.timer")
        (UNIT_DIR / "jomaa-deploy.timer").unlink()
    run("systemctl", "--user", "daemon-reload")
    if not fresh and deployed != sha:
        activate(release, deploy_dir)
    elif fresh:
        run("systemctl", "--user", "restart", "jomaa-hub.service")
        if not wait_health():
            raise DeployError("hub did not become healthy after initial deployment setup")
    run("systemctl", "--user", "enable", "jomaa-deploy.service")
    run("systemctl", "--user", "restart", "jomaa-deploy.service")
    configure_tunnel(source, hostname)
    print(f"Deployment receiver installed for {repo} main; secret file: {secret}")


def deploy_revision(source: Path, deploy_dir: Path, repo_name: str, candidate: str) -> str:
    current = (deploy_dir / "current").resolve(strict=True)
    deployed = (current / ".revision").read_text().strip()
    if candidate == deployed:
        return "already-deployed"
    cache = deploy_dir / "git-cache"
    if not cache.exists():
        run("git", "init", "--bare", str(cache))
    run("git", "-C", str(cache), "fetch", "--no-tags", f"https://github.com/{repo_name}.git", "main")
    if not is_ancestor(cache, candidate, "FETCH_HEAD"):
        raise DeployError("successful workflow commit is not on the current main branch")
    if is_ancestor(cache, candidate, deployed):
        return "older-revision-ignored"
    if not is_ancestor(cache, deployed, candidate):
        raise DeployError("main does not descend from the deployed revision; manual intervention required")
    release = make_release(cache, candidate, source, deploy_dir)
    activate(release, deploy_dir)
    prune_releases(deploy_dir)
    return "deployed"


def authenticate(body: bytes, signature: str, key: bytes, repo: str, now: float) -> dict:
    expected = "sha256=" + hmac.new(key, body, hashlib.sha256).hexdigest()
    if not re.fullmatch(r"sha256=[0-9a-f]{64}", signature) or not hmac.compare_digest(signature, expected):
        raise DeployError("invalid signature")
    try:
        payload = json.loads(body)
        sha, run_id, attempt, timestamp = (payload[k] for k in ("sha", "run_id", "attempt", "timestamp"))
        if (payload.get("repo") != repo or not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha)
                or type(run_id) is not int or run_id <= 0 or type(attempt) is not int or attempt <= 0
                or type(timestamp) is not int or abs(now - timestamp) > 300):
            raise ValueError("invalid fields")
    except (KeyError, ValueError, TypeError, json.JSONDecodeError) as e:
        raise DeployError("invalid or expired deployment request") from e
    return payload


def serve(source: Path, deploy_dir: Path, repo: str) -> None:
    secret = (deploy_dir / "webhook-secret").read_bytes().strip()
    if len(secret) < 32:
        raise DeployError("deployment webhook secret is missing or too short")

    class Handler(BaseHTTPRequestHandler):
        def respond(self, status: int, value: dict) -> None:
            body = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:
            if self.path != WEBHOOK_PATH:
                self.respond(404, {"error": "not found"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > 4096:
                    raise DeployError("invalid request length")
                self.connection.settimeout(10)
                body = self.rfile.read(length)
                payload = authenticate(body, self.headers.get("X-Jomaa-Signature", ""), secret, repo, time.time())
            except (DeployError, ValueError, OSError):
                self.respond(403, {"error": "unauthorized"})
                return
            try:
                with (deploy_dir / "deploy.lock").open("w") as lock:
                    try:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        self.respond(409, {"error": "deployment already running"})
                        return
                    verify_run(repo, payload["sha"], payload["run_id"], payload["attempt"])
                    result = deploy_revision(source, deploy_dir, repo, payload["sha"])
                self.respond(200, {"status": result, "sha": payload["sha"]})
                if result == "deployed":
                    self.server.reload_after_response = True
            except (DeployError, OSError, ValueError, subprocess.SubprocessError, urllib.error.URLError) as e:
                print(f"deployment failed: {e}", file=sys.stderr, flush=True)
                self.respond(500, {"error": "deployment failed; see server logs"})

        def log_message(self, fmt, *args) -> None:
            # Do not log signatures, request bodies, or credentials.
            print("deployment request handled", flush=True)

    server = HTTPServer(("127.0.0.1", WEBHOOK_PORT), Handler)
    server.reload_after_response = False
    print(f"Deployment receiver listening on 127.0.0.1:{WEBHOOK_PORT}", flush=True)
    try:
        while not server.reload_after_response:
            server.handle_request()
    finally:
        server.server_close()
    # The systemd service uses Restart=always, loading the new release on exit.


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("install", "serve"))
    parser.add_argument("--repo", default=os.environ.get("JOMAA_DEPLOY_REPO", "jomaa-daniel/jomaa-everything"))
    args = parser.parse_args(argv)
    source = Path(os.environ.get("JOMAA_DEPLOY_SOURCE", str(SOURCE))).resolve()
    deploy_dir = Path(os.environ.get("JOMAA_DEPLOY_HOME", str(DEPLOY_DIR))).resolve()
    try:
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repo):
            raise DeployError("repo must be OWNER/REPOSITORY")
        deploy_dir.mkdir(parents=True, exist_ok=True)
        if args.command == "install":
            with (deploy_dir / "deploy.lock").open("w") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                install(source, deploy_dir, args.repo)
        else:
            serve(source, deploy_dir, args.repo)
        return 0
    except (DeployError, OSError, ValueError, subprocess.SubprocessError, urllib.error.URLError) as e:
        print(f"deployment failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
