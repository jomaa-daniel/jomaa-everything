#!/usr/bin/env python3
"""Deploy verified repository releases, services, routes and DNS on the home server."""
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

import manifest
import native
import routing
from cloudflare_api import Cloudflare, CloudflareError

SOURCE = Path(__file__).resolve().parent.parent
DEPLOY_DIR = Path.home() / ".local/share/jomaa-deploy"
UNIT_DIR = Path.home() / ".config/systemd/user"
WEBHOOK_PATH = manifest.WEBHOOK_PATH
WEBHOOK_PORT = manifest.WEBHOOK_PORT


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
                                                  "User-Agent": "jomaa-deploy/1.0"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def verify_run(repo: str, sha: str, run_id: int, attempt: int) -> None:
    """Check the requested push and the completed verify job on GitHub."""
    owner, name = repo.split("/", 1)
    base = f"https://api.github.com/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(name)}"
    info = github_json(f"{base}/actions/runs/{run_id}")
    if (info.get("event") != "push" or info.get("head_branch") != "main" or info.get("head_sha") != sha
            or info.get("path") != ".github/workflows/deploy.yml"
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


def extract_release(repo: Path, sha: str, deploy_dir: Path) -> Path:
    """Extract the repository revision into its release directory."""
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
            subprocess.run(["git", "-C", str(repo), "archive", "--format=tar", sha],
                           stdout=out, check=True, timeout=60)
        content = folder / "release"
        with tarfile.open(archive, "r:") as tar:
            tar.extractall(content, filter="data")
        if not (content / "jomaa-deploy/deploy.py").is_file():
            raise DeployError("release does not contain the deployment receiver")
        (content / ".revision").write_text(sha + "\n")
        content.rename(target)
    return target


def link_state(release: Path, source: Path) -> None:
    """Link the release's declared runtime state to the local checkout."""
    for name in manifest.load(release)["state"]:
        original = source / name
        if not original.exists():
            raise DeployError(f"missing local runtime state: {original}")
        destination = release / name
        if destination.is_symlink() and destination.resolve() == original.resolve():
            continue
        if destination.exists() or destination.is_symlink():
            raise DeployError(f"runtime state must not be tracked: {name}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.symlink_to(original.resolve(), target_is_directory=original.is_dir())


def make_release(repo: Path, sha: str, source: Path, deploy_dir: Path) -> Path:
    """Extract the repository revision and link declared runtime state into it."""
    release = extract_release(repo, sha, deploy_dir)
    link_state(release, source)
    return release


def switch_link(link: Path, destination: Path) -> None:
    tmp = link.with_name(link.name + ".new")
    tmp.unlink(missing_ok=True)
    tmp.symlink_to(destination, target_is_directory=True)
    os.replace(tmp, link)


def health(check: dict) -> bool:
    try:
        headers = {"User-Agent": "jomaa-deploy/1.0"}
        if "host" in check:
            headers["Host"] = check["host"]
        req = urllib.request.Request(check["url"], headers=headers)
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=2) as response:
            if response.status != 200:
                return False
            if "json" in check:
                result = json.load(response)
                return isinstance(result, dict) and all(result.get(k) == v for k, v in check["json"].items())
            return True
    except (OSError, ValueError):
        return False


def wait_health(check: dict, timeout: float = 90) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if health(check):
            return True
        time.sleep(1)
    return False


def build_release(release: Path, config: dict) -> None:
    for service in config["services"].values():
        if "unit" not in service:
            continue
        directory = release / service["directory"]
        for command in service.get("build", []):
            run(*manifest.expand(command, release), cwd=directory)


def unit(service: dict, current: Path) -> str:
    command = " ".join(quote(arg) for arg in manifest.expand(service["command"], current))
    working_directory = str(current / service["directory"]).replace("%", "%%")
    return ("[Unit]\nDescription=Jomaa deployed service\nAfter=network-online.target\n"
            "[Service]\nType=simple\n"
            f"WorkingDirectory={working_directory}\n"
            f"ExecStart={command}\nRestart=always\nRestartSec=2\n"
            "[Install]\nWantedBy=default.target\n")


def write_units(config: dict, current: Path) -> None:
    UNIT_DIR.mkdir(parents=True, exist_ok=True)
    for service in config["services"].values():
        if "unit" in service:
            name = service["unit"]
            (UNIT_DIR / (name + ".service")).write_text(unit(service, current))
            (UNIT_DIR / (name + ".service.d/deployment.conf")).unlink(missing_ok=True)

    tunnel = {"directory": "jomaa-deploy", "command": ["{python}", "{release}/jomaa-deploy/boot.py", "tunnel"]}
    (UNIT_DIR / "jomaa-cloudflared.service").write_text(unit(tunnel, current))
    (UNIT_DIR / "jomaa-cloudflared.service.d/deployment.conf").unlink(missing_ok=True)


def provision(config: dict, current: Path) -> None:
    for step in config["provision"]:
        run(*manifest.expand(step["command"], current), cwd=current / step["directory"])


def atomic_write(path: Path, content: str) -> None:
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".deploy-", delete=False) as file:
        temp = Path(file.name)
        file.write(content)
    try:
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def activate(release: Path, deploy_dir: Path, source: Path) -> None:
    """Build the release, activate its services and routes, and restore failures."""
    current = deploy_dir / "current"
    previous = current.resolve(strict=True) if current.exists() else None
    config = manifest.load(release)
    old = manifest.load(previous) if previous else {"services": {}, "routes": [], "webhook": config["webhook"]}
    changed = [name for name, service in config["services"].items() if "unit" in service]
    build_release(release, config)
    native = source / "jomaa-home-hub/data/native"
    tunnel = native / "tunnel.yml"
    content = routing.prepare(native / "cloudflared", tunnel, config)
    original = tunnel.read_text()
    dns = routing.DNS(Cloudflare(load_env(source / "jomaa-home-hub/.env").get("CLOUDFLARE_API_TOKEN", "")),
                      routing.tunnel_id(tunnel))
    services = {"jomaa-cloudflared", *(s["unit"] for c in (config, old) for s in c["services"].values() if "unit" in s)}
    saved = {}
    for name in services:
        for suffix in (".service", ".service.d/deployment.conf"):
            path = UNIT_DIR / (name + suffix)
            saved[path] = path.read_bytes() if path.exists() else None
    removed = {s["unit"] for s in old["services"].values() if "unit" in s} - {
        s["unit"] for s in config["services"].values() if "unit" in s}
    tunnel_changed = content != original
    switched = False
    tunnel_written = False
    try:
        dns.apply(routing.hosts(config), routing.hosts(old))
        switch_link(current, release)
        switched = True
        write_units(config, current)
        run("systemctl", "--user", "daemon-reload")
        for name in changed:
            service = config["services"][name]
            run("systemctl", "--user", "enable", service["unit"] + ".service")
            run("systemctl", "--user", "restart", service["unit"] + ".service")
        for service in config["services"].values():
            if "unit" in service and not wait_health(service["health"]):
                raise DeployError(f"{service['unit']} did not become healthy")
        for route in config["routes"]:
            if "site" in route and not health({"url": manifest.STATIC_ORIGIN + "/", "host": route["hostname"]}):
                raise DeployError(f"static site {route['hostname']} did not become healthy")
        if tunnel_changed:
            atomic_write(tunnel, content)
            tunnel_written = True
        tunnel_unit = UNIT_DIR / "jomaa-cloudflared.service"
        if (tunnel_changed or saved[tunnel_unit] != tunnel_unit.read_bytes()
                or saved[UNIT_DIR / "jomaa-cloudflared.service.d/deployment.conf"] is not None):
            run("systemctl", "--user", "enable", "jomaa-cloudflared.service")
            run("systemctl", "--user", "restart", "jomaa-cloudflared.service")
        for name in removed:
            run("systemctl", "--user", "disable", "--now", name + ".service")
            (UNIT_DIR / (name + ".service")).unlink(missing_ok=True)
            (UNIT_DIR / (name + ".service.d/deployment.conf")).unlink(missing_ok=True)
        if removed:
            run("systemctl", "--user", "daemon-reload")
        provision(config, current)
    except Exception:
        def restore_command(*command: str) -> None:
            try:
                run(*command)
            except Exception as error:
                print(f"service restoration failed: {error}", file=sys.stderr)

        if tunnel_written:
            atomic_write(tunnel, original)
        if switched:
            for name in services:
                path = UNIT_DIR / (name + ".service")
                if saved[path] is None and path.exists():
                    restore_command("systemctl", "--user", "disable", "--now", name + ".service")
            if previous:
                switch_link(current, previous)
            else:
                current.unlink(missing_ok=True)
            for path, data in saved.items():
                if data is None:
                    path.unlink(missing_ok=True)
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(data)
            restore_command("systemctl", "--user", "daemon-reload")
            for name in services:
                if saved[UNIT_DIR / (name + ".service")] is not None:
                    restore_command("systemctl", "--user", "enable", name + ".service")
                    restore_command("systemctl", "--user", "restart", name + ".service")
        try:
            dns.restore()
        except Exception as error:
            print(str(error), file=sys.stderr)
        raise


def load_env(path: Path) -> dict[str, str]:
    values = {}
    if path.exists():
        for raw in path.read_text().splitlines():
            line = raw.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip().strip("'\"")
    return {**values, **os.environ}


def prune_releases(deploy_dir: Path, keep: int = 3) -> None:
    releases = deploy_dir / "releases"
    current = (deploy_dir / "current").resolve()
    built = sorted((r for r in releases.iterdir() if (r / ".revision").is_file()),
                   key=lambda r: r.stat().st_mtime, reverse=True)
    for old in built[keep:]:
        if old.resolve() != current:
            try:
                shutil.rmtree(old)
            except OSError as error:
                print(f"Could not remove release {old.name}: {error}", file=sys.stderr)


def install(source: Path, deploy_dir: Path, repo: str, tunnel_name: str = "jomaa-home-hub") -> None:
    sha = run("git", "-C", str(source), "rev-parse", "HEAD", capture=True)
    if run("git", "-C", str(source), "status", "--porcelain", "--untracked-files=no", capture=True):
        raise DeployError("commit tracked changes before installing the deployment receiver")
    manifest.load(source)
    native.init_config(source / "jomaa-home-hub")
    native.provision(source, load_env(source / "jomaa-home-hub/.env"), tunnel_name)
    secret = deploy_dir / "webhook-secret"
    if not secret.exists():
        fd = os.open(secret, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as file:
            file.write(secrets.token_hex(32))
    current = deploy_dir / "current"
    if current.exists():
        deployed = (current / ".revision").read_text().strip()
        if not is_ancestor(source, deployed, sha):
            raise DeployError("checkout does not descend from the deployed revision")
        for name in manifest.load(current.resolve())["state"]:
            if (current / name).resolve() != (source / name).resolve():
                raise DeployError("existing deployment points to another server's runtime state")
    release = make_release(source, sha, source, deploy_dir)
    if not current.exists() or (current / ".revision").read_text().strip() != sha:
        activate(release, deploy_dir, source)
    receiver = ("[Unit]\nDescription=Jomaa signed deployment receiver\nAfter=network-online.target\n"
                "[Service]\nType=simple\n"
                f"Environment={quote('JOMAA_DEPLOY_SOURCE=' + str(source))}\n"
                f"Environment={quote('JOMAA_DEPLOY_REPO=' + repo)}\n"
                f"Environment={quote('JOMAA_DEPLOY_HOME=' + str(deploy_dir))}\n"
                f"ExecStart={quote(sys.executable)} {quote(str(current / 'jomaa-deploy/deploy.py'))} serve\n"
                "Restart=always\nRestartSec=2\n[Install]\nWantedBy=default.target\n")
    (UNIT_DIR / "jomaa-deploy.service").write_text(receiver)
    run("systemctl", "--user", "daemon-reload")
    run("systemctl", "--user", "enable", "jomaa-deploy.service")
    run("systemctl", "--user", "restart", "jomaa-deploy.service")
    prune_releases(deploy_dir)
    print(f"Deployment receiver installed for {repo} main; secret file: {secret}")


def activate_revision(source: Path, deploy_dir: Path, sha: str) -> str:
    """Activate the extracted release of a revision unless it is already current."""
    current = deploy_dir / "current"
    if current.exists() and (current / ".revision").read_text().strip() == sha:
        return "already-deployed"
    release = deploy_dir / "releases" / sha
    if (release / ".revision").read_text().strip() != sha:
        raise DeployError(f"release {release} has the wrong revision")
    link_state(release, source)
    activate(release, deploy_dir, source)
    prune_releases(deploy_dir)
    return "deployed"


def run_engine(release: Path, source: Path, deploy_dir: Path, repo_name: str, sha: str,
               run_id: int, attempt: int) -> dict:
    """Run the release's own activation and return the result it reports."""
    result = deploy_dir / "result.json"
    result.unlink(missing_ok=True)
    env = {**os.environ, "JOMAA_DEPLOY_SOURCE": str(source), "JOMAA_DEPLOY_HOME": str(deploy_dir),
           "JOMAA_DEPLOY_REPO": repo_name}
    subprocess.run([sys.executable, str(release / "jomaa-deploy/deploy.py"), "activate", "--sha", sha,
                    "--run-id", str(run_id), "--attempt", str(attempt), "--result", str(result)],
                   cwd=release / "jomaa-deploy", env=env, check=True)
    value = json.loads(result.read_text())
    if not isinstance(value, dict) or not isinstance(value.get("status"), str):
        raise DeployError("activation reported no status")
    return value


def deploy_revision(source: Path, deploy_dir: Path, repo_name: str, candidate: str,
                    run_id: int, attempt: int) -> dict:
    current = (deploy_dir / "current").resolve(strict=True)
    deployed = (current / ".revision").read_text().strip()
    cache = deploy_dir / "git-cache"
    if not cache.exists():
        run("git", "init", "--bare", str(cache))
    run("git", "-C", str(cache), "fetch", "--no-tags", f"https://github.com/{repo_name}.git", "main")
    if not is_ancestor(cache, candidate, "FETCH_HEAD"):
        raise DeployError("successful workflow commit is not on the current main branch")
    if candidate != deployed and is_ancestor(cache, candidate, deployed):
        return {"status": "older-revision-ignored"}
    if not is_ancestor(cache, deployed, candidate):
        raise DeployError("main does not descend from the deployed revision; manual intervention required")
    release = extract_release(cache, candidate, deploy_dir)
    return run_engine(release, source, deploy_dir, repo_name, candidate, run_id, attempt)


def authenticate(body: bytes, signature: str, key: bytes, repo: str, now: float) -> dict:
    expected = "sha256=" + hmac.new(key, body, hashlib.sha256).hexdigest()
    if not re.fullmatch(r"sha256=[0-9a-f]{64}", signature) or not hmac.compare_digest(signature, expected):
        raise DeployError("invalid signature")
    try:
        payload = json.loads(body)
        if not isinstance(payload, dict):
            raise ValueError("request must be an object")
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
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

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
            current = deploy_dir / "current"
            before = current.resolve()
            try:
                with (deploy_dir / "deploy.lock").open("w") as lock:
                    try:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        self.respond(409, {"error": "deployment already running"})
                        return
                    verify_run(repo, payload["sha"], payload["run_id"], payload["attempt"])
                    result = deploy_revision(source, deploy_dir, repo, payload["sha"],
                                             payload["run_id"], payload["attempt"])
                self.respond(200, {**result, "sha": payload["sha"]})
            except (DeployError, CloudflareError, OSError, ValueError, subprocess.SubprocessError, urllib.error.URLError) as e:
                print(f"deployment failed: {e}", file=sys.stderr, flush=True)
                self.respond(500, {"error": "deployment failed; see server logs"})
            if current.resolve() != before:
                self.server.reload_after_response = True

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
    parser.add_argument("command", choices=("install", "serve", "plan", "activate"))
    parser.add_argument("--tunnel-name", default="jomaa-home-hub", help="locally managed Cloudflare tunnel for installation")
    parser.add_argument("--repo", default=os.environ.get("JOMAA_DEPLOY_REPO", "jomaa-daniel/jomaa-everything"))
    parser.add_argument("--sha", help="revision to activate")
    parser.add_argument("--run-id", type=int, help="GitHub Actions run that verified the revision")
    parser.add_argument("--attempt", type=int, help="attempt of the GitHub Actions run")
    parser.add_argument("--result", type=Path, help="file that receives the activation result as JSON")
    args = parser.parse_args(argv)
    if args.command == "activate" and None in (args.sha, args.run_id, args.attempt, args.result):
        parser.error("activate requires --sha, --run-id, --attempt and --result")
    source = Path(os.environ.get("JOMAA_DEPLOY_SOURCE", str(SOURCE))).resolve()
    deploy_dir = Path(os.environ.get("JOMAA_DEPLOY_HOME", str(DEPLOY_DIR))).resolve()
    try:
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repo):
            raise DeployError("repo must be OWNER/REPOSITORY")
        if args.command == "plan":
            config = manifest.load(source)
            print(json.dumps({"services": config["services"], "ingress": manifest.ingress(config),
                              "provision": config["provision"], "state": config["state"]}, indent=2))
            return 0
        deploy_dir.mkdir(parents=True, exist_ok=True)
        if args.command == "activate":
            # The receiver holds deploy.lock while this runs.
            status = activate_revision(source, deploy_dir, args.sha)
            args.result.write_text(json.dumps({"status": status}))
        elif args.command == "install":
            with (deploy_dir / "deploy.lock").open("w") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                install(source, deploy_dir, args.repo, args.tunnel_name)
        else:
            serve(source, deploy_dir, args.repo)
        return 0
    except (DeployError, CloudflareError, OSError, ValueError, subprocess.SubprocessError, urllib.error.URLError) as e:
        print(f"deployment failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
