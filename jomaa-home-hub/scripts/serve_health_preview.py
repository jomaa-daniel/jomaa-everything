#!/usr/bin/env python3
"""Serve the local health worktree through SSH and the hub's existing Cloudflare tunnel.

The live hub continues serving its existing API and login. The preview uses the same
session credentials and keeps its database in this worktree's ignored data directory.
No USB devices or Matter/Govee devices are accessed.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
MARKER = "jomaa-health-preview"
HEALTH_PATH = r"^/(?:devices(?:/.*)?|api/devices(?:/.*)?)?$"


class PreviewError(Exception):
    pass


def ssh_args(host: str) -> list[str]:
    return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", host]


def remote_python(host: str, script: str) -> str:
    result = subprocess.run(ssh_args(host) + ["python3 -"], input=script, capture_output=True, text=True, timeout=40)
    if result.returncode:
        # Remote errors may include private paths or credential-related output.
        raise PreviewError("remote operation failed; check SSH access and the hub tunnel configuration")
    return result.stdout


def hub_password(host: str, remote_root: str) -> str:
    script = f"""from pathlib import Path
import json, shlex
env = {{}}
for line in (Path({remote_root!r}) / '.env').read_text().splitlines():
    line = line.strip()
    if not line or line.startswith('#') or '=' not in line:
        continue
    key, value = line.split('=', 1)
    values = shlex.split(value, comments=True)
    env[key.strip().removeprefix('export ')] = values[0] if values else ''
print(json.dumps({{'password': env.get('HUB_PASSWORD', '')}}))
"""
    password = json.loads(remote_python(host, script))["password"]
    if not isinstance(password, str) or not password:
        raise PreviewError("the remote hub password is missing")
    return password


def configure_tunnel(host: str, remote_root: str, hostname: str, port: int, enabled: bool) -> None:
    # Preserve the existing deployment webhook and hub routes. Validate before replacing.
    script = f"""from pathlib import Path
import json, os, subprocess, tempfile
root = Path({remote_root!r})
config = root / 'data/native/tunnel.yml'
original = config.read_text()
begin = '  # {MARKER}\\n'
end = '  # /{MARKER}\\n'
rule = (begin + '  - hostname: ' + json.dumps({hostname!r}) + '\\n'
        + '    path: {HEALTH_PATH}\\n'
        + '    service: http://127.0.0.1:{port}\\n' + end)
enabled = {enabled!r}
if begin in original:
    assert original.count(begin) == 1 and original.count(end) == 1
    start = original.index(begin)
    finish = original.index(end, start) + len(end)
    assert original[start:finish] == rule, 'another preview route is active'
    updated = original if enabled else original[:start] + original[finish:]
else:
    assert end not in original
    assert original.count('ingress:\\n') == 1
    assert ('hostname: ' + json.dumps({hostname!r})) in original, 'hostname must already exist'
    updated = original.replace('ingress:\\n', 'ingress:\\n' + rule, 1) if enabled else original
if updated != original:
    with tempfile.NamedTemporaryFile(mode='w', dir=config.parent, prefix='.health-tunnel-', delete=False) as f:
        temp = Path(f.name)
        f.write(updated)
    try:
        subprocess.run([str(root / 'data/native/cloudflared'), '--config', str(temp), 'tunnel', 'ingress', 'validate'],
                       check=True, capture_output=True)
        backup = config.with_name('tunnel.yml.pre-health-preview')
        if enabled and not backup.exists():
            fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as f: f.write(original)
        os.replace(temp, config)
        try:
            subprocess.run(['systemctl', '--user', 'restart', 'jomaa-cloudflared.service'], check=True, capture_output=True)
        except Exception:
            config.write_text(original)
            subprocess.run(['systemctl', '--user', 'restart', 'jomaa-cloudflared.service'], check=True, capture_output=True)
            raise
    finally:
        temp.unlink(missing_ok=True)
print('preview route enabled' if enabled else 'preview route removed')
"""
    remote_python(host, script)


def probe(url: str) -> bool:
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(url, timeout=1) as response:
            return response.status == 200 and json.load(response).get("ok") is True
    except (OSError, ValueError):
        return False


def wait_ready(process: subprocess.Popen, url: str) -> None:
    deadline = time.monotonic() + 15
    while process.poll() is None and time.monotonic() < deadline:
        if probe(url):
            return
        time.sleep(0.2)
    raise PreviewError("preview process did not become ready")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="jerry@192.168.1.239")
    parser.add_argument("--remote-root", default="/home/jerry/jomaa-everything/jomaa-home-hub")
    parser.add_argument("--hostname", default="hub.jomaa.org")
    parser.add_argument("--local-port", type=int, default=8085)
    parser.add_argument("--remote-health-port", type=int, default=8082)
    parser.add_argument("--hub-forward-port", type=int, default=18080)
    parser.add_argument("--expose", action="store_true", help="add health routes to the existing Cloudflare hostname")
    parser.add_argument("--remove-exposure", action="store_true", help="remove the preview's Cloudflare routes and exit")
    args = parser.parse_args(argv)
    for port in (args.local_port, args.remote_health_port, args.hub_forward_port):
        if not 1024 <= port <= 65535:
            parser.error("ports must be from 1024 to 65535")
    if args.expose and args.remove_exposure:
        parser.error("choose --expose or --remove-exposure")
    if args.local_port == args.hub_forward_port:
        parser.error("local preview and hub forward ports must differ")
    processes = []
    exposed = False
    try:
        if args.remove_exposure:
            configure_tunnel(args.host, args.remote_root, args.hostname, args.remote_health_port, False)
            print("Removed the health preview's public routes.")
            return 0
        subprocess.run(["npm", "run", "build"], cwd=ROOT, check=True)
        password = hub_password(args.host, args.remote_root)
        folder = ROOT / "data/health-preview"
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        config = folder / "config.json"
        config.write_text(json.dumps({"listen": f"127.0.0.1:{args.local_port}", "devices": [], "rooms": []}) + "\n")
        config.chmod(0o600)
        env = {**os.environ, "HUB_PASSWORD": password, "GOVEE_API_KEY": "", "HUB_TLS_CERT": "", "HUB_TLS_KEY": "",
               "HEALTH_DB_PATH": str(folder / "health.sqlite")}
        hub = subprocess.Popen(["node", "dist/main.js", "--no-matter", "--config", str(config)], cwd=ROOT, env=env,
                               stdin=subprocess.DEVNULL)
        processes.append(hub)
        wait_ready(hub, f"http://127.0.0.1:{args.local_port}/healthz")
        forward = ["ssh", "-N", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ExitOnForwardFailure=yes",
                   "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
                   "-R", f"127.0.0.1:{args.remote_health_port}:127.0.0.1:{args.local_port}",
                   "-L", f"127.0.0.1:{args.hub_forward_port}:127.0.0.1:8080", "--", args.host]
        tunnel = subprocess.Popen(forward, stdin=subprocess.DEVNULL)
        processes.append(tunnel)
        wait_ready(tunnel, f"http://127.0.0.1:{args.hub_forward_port}/healthz")
        if args.expose:
            configure_tunnel(args.host, args.remote_root, args.hostname, args.remote_health_port, True)
            exposed = True
        print(f"Health preview: http://127.0.0.1:{args.local_port}/devices", flush=True)
        print(f"Hub SSH forward: http://127.0.0.1:{args.hub_forward_port}", flush=True)
        if exposed:
            print(f"Public health UI: https://{args.hostname}/devices", flush=True)
        print("Preview active. Keep this terminal and Mac running; Ctrl+C removes public preview routes and stops it.", flush=True)
        while all(process.poll() is None for process in processes):
            time.sleep(1)
        raise PreviewError("a preview process exited")
    except KeyboardInterrupt:
        return 0
    except (PreviewError, OSError, ValueError, KeyError, subprocess.SubprocessError):
        print("Health preview failed. Check SSH access, available ports, and the existing tunnel configuration.", file=sys.stderr)
        return 1
    finally:
        if exposed:
            try:
                configure_tunnel(args.host, args.remote_root, args.hostname, args.remote_health_port, False)
            except Exception:
                print("Could not remove public preview routes; run --remove-exposure after reconnecting.", file=sys.stderr)
        for process in reversed(processes):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


if __name__ == "__main__":
    def stop(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    sys.exit(main())
