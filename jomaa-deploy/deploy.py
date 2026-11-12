#!/usr/bin/env python3
"""Deploy verified repository releases on the home server: signed receiver, releases and module activation."""
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

import engine
import native
import settings
from cloudflare_api import CloudflareError
from modules import VERIFY_JOB, Context, DeployError
from modules import ingress
from modules.base import quote
from settings import load_env

CONFIG = settings.CONFIG
SOURCE = Path(__file__).resolve().parent.parent
UNIT_DIR = settings.path(CONFIG["unitDirectory"])
WEBHOOK_PATH = settings.WEBHOOK_PATH
ERRORS = (DeployError, CloudflareError, OSError, ValueError, subprocess.SubprocessError, urllib.error.URLError)


def run(*args: str, cwd: Path | None = None, capture: bool = False) -> str:
    r = subprocess.run(args, cwd=cwd, check=True, text=True, stdout=subprocess.PIPE if capture else None,
                       timeout=CONFIG["commandTimeoutSeconds"])
    return r.stdout.strip() if capture else ""


def github_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json",
                                                  "User-Agent": CONFIG["userAgent"]})
    with urllib.request.urlopen(request, timeout=CONFIG["github"]["timeoutSeconds"]) as response:
        return json.load(response)


def run_api(repo: str, run_id: int) -> str:
    owner, name = repo.split("/", 1)
    return (f"{CONFIG['github']['api']}/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(name)}"
            f"/actions/runs/{run_id}")


def github_jobs(repo: str, run_id: int, attempt: int) -> dict[str, str | None]:
    """The conclusion of every job of one run attempt, by job name."""
    jobs: dict[str, str | None] = {}
    per_page = CONFIG["github"]["jobsPerPage"]
    page = 1
    while True:
        batch = github_json(f"{run_api(repo, run_id)}/attempts/{attempt}/jobs?per_page={per_page}&page={page}"
                            ).get("jobs", [])
        for job in batch:
            jobs[job.get("name")] = job.get("conclusion")
        if len(batch) < per_page:
            return jobs
        page += 1


def verify_run(repo: str, sha: str, run_id: int, attempt: int) -> None:
    """Check the requested push and the completed verify job on GitHub."""
    info = github_json(run_api(repo, run_id))
    if (info.get("event") != "push" or info.get("head_branch") != "main" or info.get("head_sha") != sha
            or info.get("path") != ".github/workflows/deploy.yml"
            or info.get("run_attempt") != attempt or info.get("repository", {}).get("full_name") != repo
            or info.get("status") not in ("in_progress", "completed")
            or info.get("conclusion") not in (None, "success")):
        raise DeployError("request does not match a main-branch deployment workflow run")
    if github_jobs(repo, run_id, attempt).get(VERIFY_JOB) != "success":
        raise DeployError("GitHub has not reported a successful verification job")


def is_ancestor(repo: Path, ancestor: str, descendant: str) -> bool:
    result = subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor", ancestor, descendant],
                            timeout=CONFIG["gitTimeoutSeconds"])
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
                           stdout=out, check=True, timeout=CONFIG["gitTimeoutSeconds"])
        content = folder / "release"
        with tarfile.open(archive, "r:") as tar:
            tar.extractall(content, filter="data")
        if not (content / "jomaa-deploy/deploy.py").is_file():
            raise DeployError("release does not contain the deployment receiver")
        (content / ".revision").write_text(sha + "\n")
        content.rename(target)
    return target


def prune_releases(deploy_dir: Path, keep: int) -> None:
    """Delete old releases, keeping the newest, the current one and every module's current and previous one."""
    releases = deploy_dir / "releases"
    pointers = [deploy_dir / "current", *deploy_dir.glob("modules/*/current"), *deploy_dir.glob("modules/*/previous")]
    used = {pointer.resolve() for pointer in pointers if pointer.exists()}
    built = sorted((r for r in releases.iterdir() if (r / ".revision").is_file()),
                   key=lambda r: r.stat().st_mtime, reverse=True)
    for old in built[keep:]:
        if old.resolve() not in used:
            try:
                shutil.rmtree(old)
            except OSError as error:
                print(f"Could not remove release {old.name}: {error}", file=sys.stderr)


def context(source: Path, deploy_dir: Path, release: Path, sha: str) -> Context:
    """The activation context; fingerprints read the receiver's git cache when it has the revision."""
    cache = deploy_dir / "git-cache"
    cached = cache.exists() and subprocess.run(
        ["git", "-C", str(cache), "cat-file", "-e", f"{sha}^{{commit}}"], capture_output=True,
        timeout=CONFIG["gitTimeoutSeconds"]).returncode == 0
    return Context(source, deploy_dir, release, sha, cache if cached else source, unit_dir=UNIT_DIR)


def activate_revision(source: Path, deploy_dir: Path, repo_name: str, sha: str, run_id: int, attempt: int) -> dict:
    """Deploy the modules of an extracted release whose checks succeeded in the given run attempt."""
    release = deploy_dir / "releases" / sha
    if (release / ".revision").read_text().strip() != sha:
        raise DeployError(f"release {release} has the wrong revision")
    try:
        jobs = github_jobs(repo_name, run_id, attempt)
    except (OSError, ValueError, urllib.error.URLError) as error:
        print(f"could not read the workflow's jobs; modules with checks are ineligible: {error}",
              file=sys.stderr, flush=True)
        jobs = {}
    result = engine.activate(context(source, deploy_dir, release, sha), jobs)
    prune_releases(deploy_dir, CONFIG["releasesKept"])
    return result


def install(source: Path, deploy_dir: Path, repo: str, tunnel_name: str) -> None:
    sha = run("git", "-C", str(source), "rev-parse", "HEAD", capture=True)
    if run("git", "-C", str(source), "status", "--porcelain", "--untracked-files=no", capture=True):
        raise DeployError("commit tracked changes before installing the deployment receiver")
    modules, failures = engine.discover(source)
    if failures:
        raise DeployError("modules failed to load: " + "; ".join(f"{d}: {e}" for d, e in failures.items()))
    native.init_config(source / "jomaa-home-hub")
    native.provision(source, load_env(source / CONFIG["cloudflare"]["env"]), tunnel_name)
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
        for name in (path for module in modules for path in module.state):
            link = current / name
            if (link.exists() or link.is_symlink()) and link.resolve() != (source / name).resolve():
                raise DeployError("existing deployment points to another server's runtime state")
    release = extract_release(source, sha, deploy_dir)
    if not current.exists() or (current / ".revision").read_text().strip() != sha:
        print(json.dumps(engine.activate(context(source, deploy_dir, release, sha), None), indent=2))
    unit = CONFIG["receiverUnit"] + ".service"
    receiver = ("[Unit]\nDescription=Jomaa signed deployment receiver\nAfter=network-online.target\n"
                "[Service]\nType=simple\n"
                f"Environment={quote('JOMAA_DEPLOY_SOURCE=' + str(source))}\n"
                f"Environment={quote('JOMAA_DEPLOY_REPO=' + repo)}\n"
                f"Environment={quote('JOMAA_DEPLOY_HOME=' + str(deploy_dir))}\n"
                f"ExecStart={quote(sys.executable)} {quote(str(current / 'jomaa-deploy/deploy.py'))} serve\n"
                "Restart=always\nRestartSec=2\n[Install]\nWantedBy=default.target\n")
    UNIT_DIR.mkdir(parents=True, exist_ok=True)
    (UNIT_DIR / unit).write_text(receiver)
    run("systemctl", "--user", "daemon-reload")
    run("systemctl", "--user", "enable", unit)
    run("systemctl", "--user", "restart", unit)
    prune_releases(deploy_dir, CONFIG["releasesKept"])
    print(f"Deployment receiver installed for {repo} main; secret file: {secret}")


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
    run("git", "-C", str(cache), "fetch", "--no-tags", f"{CONFIG['github']['remote']}/{repo_name}.git", "main")
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
            except ERRORS as e:
                print(f"deployment failed: {e}", file=sys.stderr, flush=True)
                self.respond(500, {"error": "deployment failed; see server logs"})
            if current.resolve() != before:
                self.server.reload_after_response = True

        def log_message(self, fmt, *args) -> None:
            # Do not log signatures, request bodies, or credentials.
            print("deployment request handled", flush=True)

    port = CONFIG["webhook"]["port"]
    server = HTTPServer(("127.0.0.1", port), Handler)
    server.reload_after_response = False
    print(f"Deployment receiver listening on 127.0.0.1:{port}", flush=True)
    try:
        while not server.reload_after_response:
            server.handle_request()
    finally:
        server.server_close()
    # The systemd service uses Restart=always, loading the new release on exit.


def matrix(modules: list) -> list[str]:
    """Modules whose checks run in their own check (<name>) job."""
    return sorted(m.name for m in modules if m.check_job() == f"check ({m.name})")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("install", "serve", "plan", "modules", "activate"))
    parser.add_argument("--tunnel-name", default=CONFIG["tunnel"]["name"],
                        help="locally managed Cloudflare tunnel for installation")
    parser.add_argument("--repo", default=os.environ.get("JOMAA_DEPLOY_REPO", CONFIG["repo"]))
    parser.add_argument("--json", action="store_true", help="modules: print the check matrix as JSON")
    parser.add_argument("--sha", help="revision to activate")
    parser.add_argument("--run-id", type=int, help="GitHub Actions run that verified the revision")
    parser.add_argument("--attempt", type=int, help="attempt of the GitHub Actions run")
    parser.add_argument("--result", type=Path, help="file that receives the activation result as JSON")
    args = parser.parse_args(argv)
    if args.command == "activate" and None in (args.sha, args.run_id, args.attempt, args.result):
        parser.error("activate requires --sha, --run-id, --attempt and --result")
    source = Path(os.environ.get("JOMAA_DEPLOY_SOURCE", str(SOURCE))).resolve()
    deploy_dir = settings.deploy_dir()
    try:
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repo):
            raise DeployError("repo must be OWNER/REPOSITORY")
        if args.command in ("plan", "modules"):
            modules, failures = engine.discover(source)
            for directory, error in failures.items():
                print(f"{directory} failed to load: {error}", file=sys.stderr)
            if args.command == "modules":
                if args.json:
                    print(json.dumps(matrix(modules)))
                else:
                    for module in sorted(modules, key=lambda m: (m.phase, m.name)):
                        print(f"{module.name}\t{module.kind}\t{module.directory}\t{module.check_job() or '-'}")
                return 0
            routes, conflicts = ingress.ordered_routes(modules, CONFIG)
            print(json.dumps({
                "modules": {m.name: {"kind": m.kind, "directory": m.directory, "job": m.check_job()}
                            for m in sorted(modules, key=lambda m: (m.phase, m.name))},
                "ingress": ingress.rules(routes, CONFIG)[0], "conflicts": conflicts,
                "state": sorted(p for m in modules for p in m.state)}, indent=2))
            return 1 if failures or conflicts else 0
        deploy_dir.mkdir(parents=True, exist_ok=True)
        if args.command == "activate":
            # The receiver holds deploy.lock while this runs.
            result = activate_revision(source, deploy_dir, args.repo, args.sha, args.run_id, args.attempt)
            args.result.write_text(json.dumps(result))
        elif args.command == "install":
            with (deploy_dir / "deploy.lock").open("w") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                install(source, deploy_dir, args.repo, args.tunnel_name)
        else:
            serve(source, deploy_dir, args.repo)
        return 0
    except ERRORS as e:
        print(f"deployment failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
