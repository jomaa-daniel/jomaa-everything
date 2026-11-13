#!/usr/bin/env python3
"""Fake GitHub and Cloudflare APIs for the deployment e2e suite, with faults set through /_control.

GitHub: workflow runs, the jobs of each run attempt (paginated), and the cloudflared release with its
asset. Cloudflare: zones and DNS records under the configured API path. Every request is logged.

POST /_control merges a JSON object into the state:
  runs          {"<run id>": run object or null}
  jobs          {"<run id>/<attempt>": [{"name": ..., "conclusion": ...}] or null}
  github        {"run" | "jobs" | "release" | "asset": 500 | "hang" | null}
  release       {"digest": "wrong" | null, "missingAsset": true | false}
  dns           {"<hostname>": 500 | "hang" | "success-false" | null}
  missingZones  [zone names that do not exist]
  records       [DNS records added as they are, marked as seeded]
  token         Cloudflare API token that requests must carry
  clearFaults   true: clear github, release, dns, missingZones and seeded records, and end hanging requests
GET /_control returns the state and every logged request. POST /_control/reset clears everything but
the token and ends hanging requests.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

CONTROL = "/_control"
RESET = "/_control/reset"
ASSETS = "/_assets/"
ASSET_PREFIX = "cloudflared-linux-"
ARCHES = ("amd64", "arm64")
RUN = re.compile(r"^/repos/[^/]+/[^/]+/actions/runs/(\d+)$")
JOBS = re.compile(r"^/repos/[^/]+/[^/]+/actions/runs/(\d+)/attempts/(\d+)/jobs$")
RELEASE = re.compile(r"^/repos/[^/]+/[^/]+/releases/tags/([^/]+)$")
ZONES = "/zones"
RECORDS = re.compile(r"^/zones/([^/]+)/dns_records(?:/([^/]+))?$")
GITHUB_FAULTS = ("run", "jobs", "release", "asset")
DNS_FAULTS = (500, "hang", "success-false")


class State:
    def __init__(self, asset: Path, hang_seconds: float):
        self.lock = threading.Lock()
        self.asset = asset
        self.hang_seconds = hang_seconds
        self.token: str | None = None
        self.records: dict[str, dict] = {}
        self.released = threading.Event()
        self.clear()

    def clear(self) -> None:
        self.runs: dict[str, dict] = {}
        self.jobs: dict[str, list[dict]] = {}
        self.records: dict[str, dict] = {}
        self.requests = []
        self.clear_faults()

    def clear_faults(self) -> None:
        self.github: dict[str, object] = {}
        self.release: dict[str, object] = {"digest": None, "missingAsset": False}
        self.dns: dict[str, object] = {}
        self.missing_zones: set[str] = set()
        self.records = {k: r for k, r in self.records.items() if not r.get("_seeded")}
        self.released.set()
        self.released = threading.Event()

    def control(self, change: dict) -> None:
        if change.get("clearFaults"):
            self.clear_faults()
        for key, value in change.get("runs", {}).items():
            self.set_or_delete(self.runs, str(key), value)
        for key, value in change.get("jobs", {}).items():
            self.set_or_delete(self.jobs, str(key), value)
        for key, value in change.get("github", {}).items():
            if key not in GITHUB_FAULTS or value not in (500, "hang", None):
                raise ValueError(f"unknown GitHub fault {key}={value!r}")
            self.set_or_delete(self.github, key, value)
        if "release" in change:
            self.release.update(change["release"])
        for host, value in change.get("dns", {}).items():
            if value not in (*DNS_FAULTS, None):
                raise ValueError(f"unknown DNS fault {host}={value!r}")
            self.set_or_delete(self.dns, host, value)
        if "missingZones" in change:
            self.missing_zones = set(change["missingZones"])
        for record in change.get("records", []):
            record_id = record.get("id") or uuid.uuid4().hex
            self.records[record_id] = {**record, "id": record_id, "_seeded": True}
        if "token" in change:
            self.token = change["token"]

    @staticmethod
    def set_or_delete(target: dict, key: str, value: object) -> None:
        if value is None:
            target.pop(key, None)
        else:
            target[key] = value

    def snapshot(self) -> dict:
        return {"requests": self.requests, "records": [public(r) for r in self.records.values()],
                "runs": self.runs, "jobs": self.jobs, "github": self.github, "release": self.release,
                "dns": self.dns, "missingZones": sorted(self.missing_zones)}


def public(record: dict) -> dict:
    return {k: v for k, v in record.items() if not k.startswith("_")}


def zone_id(name: str) -> str:
    return hashlib.sha256(name.encode()).hexdigest()[:32]


def asset_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Handler(BaseHTTPRequestHandler):
    server_version = "jomaa-e2e-fakes"
    state: State
    cloudflare_path: str
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args) -> None:
        pass

    def send(self, status: int, value: object = None, raw: bytes | None = None,
             content_type: str = "application/json") -> None:
        body = raw if raw is not None else json.dumps(value).encode()
        self.entry["status"] = status
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def hang(self) -> None:
        self.entry["status"] = "hang"
        self.state.released.wait(self.state.hang_seconds)
        self.close_connection = True

    def handle_one_request(self) -> None:
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def do_GET(self) -> None:
        self.dispatch("GET")

    def do_POST(self) -> None:
        self.dispatch("POST")

    def do_PUT(self) -> None:
        self.dispatch("PUT")

    def do_DELETE(self) -> None:
        self.dispatch("DELETE")

    def dispatch(self, method: str) -> None:
        url = urlsplit(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            body = raw.decode(errors="replace")
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        self.entry = {"method": method, "path": url.path, "query": query, "host": self.headers.get("Host"),
                      "body": body, "status": None, "time": time.time()}
        if url.path.startswith(CONTROL):
            self.control(method, url.path, body)
            return
        with self.state.lock:
            self.state.requests.append(self.entry)
        try:
            if url.path.startswith(self.cloudflare_path + "/") or url.path == self.cloudflare_path:
                self.cloudflare(method, url.path[len(self.cloudflare_path):], query, body)
            else:
                self.github(method, url.path, query)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def control(self, method: str, path: str, body: object) -> None:
        state = self.state
        if method == "GET" and path == CONTROL:
            with state.lock:
                self.send(200, state.snapshot())
        elif method == "POST" and path == RESET:
            with state.lock:
                state.clear()
            self.send(200, {"ok": True})
        elif method == "POST" and path == CONTROL and isinstance(body, dict):
            try:
                with state.lock:
                    state.control(body)
            except (ValueError, TypeError, AttributeError) as error:
                self.send(400, {"error": str(error)})
                return
            self.send(200, {"ok": True})
        else:
            self.send(404, {"error": "unknown control request"})

    def fault(self, fault: object) -> bool:
        """Answer with the injected fault; False when there is none."""
        if fault == 500:
            self.send(500, raw=b"injected server error", content_type="text/plain")
        elif fault == "hang":
            self.hang()
        else:
            return False
        return True

    def github(self, method: str, path: str, query: dict) -> None:
        state = self.state
        if method != "GET":
            self.send(404, {"message": "Not Found"})
            return
        if match := RUN.match(path):
            if self.fault(state.github.get("run")):
                return
            with state.lock:
                run = state.runs.get(match[1])
            self.send(200, run) if run is not None else self.send(404, {"message": "Not Found"})
        elif match := JOBS.match(path):
            if self.fault(state.github.get("jobs")):
                return
            with state.lock:
                jobs = state.jobs.get(f"{match[1]}/{match[2]}")
            if jobs is None:
                self.send(404, {"message": "Not Found"})
                return
            per_page = int(query.get("per_page", 30))
            page = int(query.get("page", 1))
            listed = [{"id": i + 1, "name": job["name"], "conclusion": job.get("conclusion"),
                       "status": "completed" if job.get("conclusion") else "in_progress"}
                      for i, job in enumerate(jobs)]
            self.send(200, {"total_count": len(listed), "jobs": listed[(page - 1) * per_page:page * per_page]})
        elif match := RELEASE.match(path):
            if self.fault(state.github.get("release")):
                return
            digest = asset_digest(state.asset)
            if state.release.get("digest") == "wrong":
                digest = hashlib.sha256(digest.encode()).hexdigest()
            host = self.headers.get("Host")
            assets = [] if state.release.get("missingAsset") else [
                {"name": ASSET_PREFIX + arch, "digest": "sha256:" + digest,
                 "browser_download_url": f"http://{host}{ASSETS}{ASSET_PREFIX}{arch}"} for arch in ARCHES]
            self.send(200, {"tag_name": match[1], "assets": assets})
        elif path.startswith(ASSETS) and path[len(ASSETS):] in {ASSET_PREFIX + a for a in ARCHES}:
            if self.fault(state.github.get("asset")):
                return
            self.send(200, raw=state.asset.read_bytes(), content_type="application/octet-stream")
        else:
            self.send(404, {"message": "Not Found"})

    def cloudflare_reply(self, result: object, status: int = 200) -> None:
        self.send(status, {"success": status < 400, "errors": [] if status < 400 else [
            {"code": status, "message": "request failed"}], "messages": [], "result": result})

    def cloudflare(self, method: str, path: str, query: dict, body: object) -> None:
        state = self.state
        if state.token is None or self.headers.get("Authorization") != f"Bearer {state.token}":
            self.send(403, {"success": False, "errors": [{"code": 9109, "message": "Invalid access token"}],
                            "messages": [], "result": None})
            return
        if method == "GET" and path == ZONES:
            name = query.get("name", "")
            if self.dns_fault(name):
                return
            exists = len(name.split(".")) == 2 and name not in state.missing_zones
            self.cloudflare_reply([{"id": zone_id(name), "name": name, "status": "active"}] if exists else [])
            return
        match = RECORDS.match(path)
        if not match:
            self.cloudflare_reply(None, 404)
            return
        zone, record_id = match[1], match[2]
        with state.lock:
            target = state.records.get(record_id) if record_id else None
        host = (query.get("name") if method == "GET" else body.get("name") if isinstance(body, dict)
                else None) or (target or {}).get("name", "")
        if self.dns_fault(host):
            return
        with state.lock:
            if method == "GET" and record_id is None:
                found = [public(r) for r in state.records.values()
                         if r.get("zone_id", zone) == zone and r.get("name") == host]
                self.cloudflare_reply(found)
            elif method == "POST" and record_id is None and isinstance(body, dict):
                new_id = uuid.uuid4().hex
                state.records[new_id] = {**body, "id": new_id, "zone_id": zone}
                self.cloudflare_reply(public(state.records[new_id]))
            elif method == "PUT" and target is not None and isinstance(body, dict):
                state.records[record_id] = {**body, "id": record_id, "zone_id": zone}
                self.cloudflare_reply(public(state.records[record_id]))
            elif method == "DELETE" and target is not None:
                del state.records[record_id]
                self.cloudflare_reply({"id": record_id})
            else:
                self.cloudflare_reply(None, 404)

    def dns_fault(self, host: str) -> bool:
        fault = self.state.dns.get(host)
        if fault == "success-false":
            self.send(200, {"success": False, "errors": [{"code": 1000, "message": "injected failure"}],
                            "messages": [], "result": None})
            return True
        if fault == 500:
            self.send(500, {"success": False, "errors": [{"code": 500, "message": "injected server error"}],
                            "messages": [], "result": None})
            return True
        return self.fault(fault)


def main() -> int:
    port = int(os.environ["FAKES_PORT"])
    Handler.state = State(Path(os.environ["FAKES_ASSET"]), float(os.environ["FAKES_HANG_SECONDS"]))
    Handler.cloudflare_path = os.environ["FAKES_CLOUDFLARE_PATH"]
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.daemon_threads = True
    print(f"fakes listening on port {port}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
