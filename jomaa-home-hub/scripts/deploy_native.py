#!/usr/bin/env python3
"""Deploy a GitHub-verified main revision to the native hub (no inbound ports)."""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SOURCE = Path(__file__).resolve().parent.parent
DEPLOY_DIR = Path.home() / ".local/share/jomaa-home-deploy"
UNIT_DIR = Path.home() / ".config/systemd/user"


class DeployError(Exception):
    pass


def run(*args: str, cwd: Path | None = None, capture: bool = False, env: dict | None = None) -> str:
    r = subprocess.run(args, cwd=cwd, check=True, text=True, stdout=subprocess.PIPE if capture else None,
                       env=env, timeout=300)
    return r.stdout.strip() if capture else ""


def quote(value: str) -> str:
    return json.dumps(value.replace("%", "%%"))


def latest_success(repo: str) -> str | None:
    owner, name = repo.split("/", 1)
    url = (f"https://api.github.com/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(name)}"
           "/actions/workflows/hub-deploy-native.yml/runs?branch=main&event=push&status=success&per_page=1")
    request = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json",
                                                  "User-Agent": "jomaa-home-hub-deployer/1.0"})
    with urllib.request.urlopen(request, timeout=20) as response:
        runs = json.load(response).get("workflow_runs", [])
    if not runs:
        return None
    if (runs[0].get("conclusion") != "success" or runs[0].get("event") != "push"
            or runs[0].get("head_branch") != "main"):
        raise DeployError("GitHub returned a run that is not a successful main push")
    sha = runs[0].get("head_sha", "")
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise DeployError("GitHub returned an invalid commit SHA")
    return sha


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


def build_release(release: Path, source: Path) -> None:
    """Build the binary from the exact source recorded in the release."""
    go = source / "data/native/go/bin/go"
    if not go.is_file():
        found = shutil.which("go")
        if not found:
            raise DeployError("Go is not installed")
        go = Path(found)
    binary_dir = release / "bin"
    binary_dir.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".deploy-", dir=binary_dir) as tmp:
        tmpdir = Path(tmp)
        candidate = tmpdir / "hub"
        run(str(go), "build", "-trimpath", "-o", str(candidate), "./cmd/hub", cwd=release,
            env={**os.environ, "CGO_ENABLED": "0"})
        os.replace(candidate, binary_dir / "hub")


def activate(release: Path, source: Path, deploy_dir: Path) -> None:
    """Build an isolated release, then switch its single current pointer."""
    current = deploy_dir / "current"
    previous = current.resolve(strict=True)
    build_release(release, source)
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


def install(source: Path, deploy_dir: Path, repo: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise DeployError("repo must be OWNER/REPOSITORY")
    for name in ("jomaa-setup", "jomaa-matter", "jomaa-hub"):
        if not (UNIT_DIR / (name + ".service")).is_file():
            raise DeployError(f"missing {name}.service; run setup_native.py first")
    root = source.parent
    current = deploy_dir / "current"
    if current.exists():
        release = current.resolve(strict=True)
        for name in (".env", "config.json", "data"):
            if (release / name).resolve() != (source / name).resolve():
                raise DeployError("existing deployment points to another hub's runtime state")
        sha = (release / ".revision").read_text().strip()
    else:
        sha = run("git", "-C", str(root), "rev-parse", "HEAD", capture=True)
        # Bootstrap must include the installer currently being run, not an uncommitted copy.
        if run("git", "-C", str(root), "status", "--porcelain", "--untracked-files=no", capture=True):
            raise DeployError("commit tracked changes before installing the deployment timer")
        release = make_release(root, sha, source, deploy_dir)
        if not (release / "scripts/deploy_native.py").is_file():
            raise DeployError("commit the deployment script before installing the timer")
        build_release(release, source)
        switch_link(current, release)
    UNIT_DIR.mkdir(parents=True, exist_ok=True)
    script = deploy_dir / "current/scripts/deploy_native.py"
    unit = (f"[Unit]\nDescription=Deploy verified Jomaa hub changes\n[Service]\nType=oneshot\n"
            f"Environment={quote('JOMAA_DEPLOY_SOURCE=' + str(source))}\n"
            f"Environment={quote('JOMAA_DEPLOY_REPO=' + repo)}\n"
            f"Environment={quote('JOMAA_DEPLOY_HOME=' + str(deploy_dir))}\n"
            f"ExecStart={quote(sys.executable)} {quote(str(script))} poll\n")
    timer = ("[Unit]\nDescription=Check for verified Jomaa hub deployments\n[Timer]\n"
             "OnBootSec=2min\nOnUnitActiveSec=5min\nPersistent=true\n"
             "[Install]\nWantedBy=timers.target\n")
    (UNIT_DIR / "jomaa-deploy.service").write_text(unit)
    (UNIT_DIR / "jomaa-deploy.timer").write_text(timer)
    for name, args in (("jomaa-setup", "setup_native.py --boot"), ("jomaa-matter", "boot_native.py matter"),
                       ("jomaa-hub", "boot_native.py hub"), ("jomaa-cloudflared", "boot_native.py tunnel")):
        unit_path = UNIT_DIR / (name + ".service")
        if not unit_path.exists():
            if name == "jomaa-cloudflared":
                continue
            raise DeployError(f"missing service {unit_path}; run setup_native.py first")
        script_name, arg = args.split()
        directory = UNIT_DIR / (name + ".service.d")
        directory.mkdir(parents=True, exist_ok=True)
        binary_env = (f"Environment={quote('JOMAA_HUB_BINARY=' + str(deploy_dir / 'current/bin/hub'))}\n"
                      if name == "jomaa-hub" else "")
        (directory / "deployment.conf").write_text(
            f"[Service]\n{binary_env}ExecStart=\nExecStart={quote(sys.executable)} "
            f"{quote(str(deploy_dir / 'current/scripts' / script_name))} {arg}\n")
    run("systemctl", "--user", "daemon-reload")
    run("systemctl", "--user", "enable", "--now", "jomaa-deploy.timer")
    print(f"Deployment timer installed for {repo} main, current revision {sha[:12]}")


def poll(source: Path, deploy_dir: Path, repo_name: str) -> None:
    candidate = latest_success(repo_name)
    if not candidate:
        print("No successful main-branch deployment workflow yet")
        return
    current = (deploy_dir / "current").resolve(strict=True)
    deployed = (current / ".revision").read_text().strip()
    if candidate == deployed:
        print(f"Already deployed {deployed[:12]}")
        return
    cache = deploy_dir / "git-cache"
    if not cache.exists():
        run("git", "init", "--bare", str(cache))
    run("git", "-C", str(cache), "fetch", "--no-tags", f"https://github.com/{repo_name}.git", "main")
    if not is_ancestor(cache, candidate, "FETCH_HEAD"):
        raise DeployError("successful workflow commit is not on the current main branch")
    if is_ancestor(cache, candidate, deployed):
        print("The most recent successful workflow is older than the deployed revision")
        return
    if not is_ancestor(cache, deployed, candidate):
        raise DeployError("main does not descend from the deployed revision; manual intervention required")
    release = make_release(cache, candidate, source, deploy_dir)
    activate(release, source, deploy_dir)
    print(f"Deployed {candidate[:12]}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("install", "poll"))
    parser.add_argument("--repo", default=os.environ.get("JOMAA_DEPLOY_REPO", "jomaa-daniel/jomaa-everything"))
    args = parser.parse_args(argv)
    source = Path(os.environ.get("JOMAA_DEPLOY_SOURCE", str(SOURCE))).resolve()
    deploy_dir = Path(os.environ.get("JOMAA_DEPLOY_HOME", str(DEPLOY_DIR))).resolve()
    try:
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repo):
            raise DeployError("repo must be OWNER/REPOSITORY")
        deploy_dir.mkdir(parents=True, exist_ok=True)
        with (deploy_dir / "deploy.lock").open("w") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print("Another deployment check is running")
                return 0
            if args.command == "install":
                install(source, deploy_dir, args.repo)
            else:
                poll(source, deploy_dir, args.repo)
        return 0
    except (DeployError, OSError, ValueError, subprocess.SubprocessError, urllib.error.URLError) as e:
        print(f"deployment failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
