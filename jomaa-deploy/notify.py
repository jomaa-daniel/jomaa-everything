#!/usr/bin/env python3
"""Request deployment of this verified GitHub Actions run."""

import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import settings

SUCCESS = ("deployed", "older-revision-ignored")
PARTIAL = "partial"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main() -> int:
    config = settings.CONFIG
    retry = config["notify"]
    try:
        key = os.environ.get("JOMAA_DEPLOY_SECRET", "")
        if len(key) < 32:
            raise ValueError("JOMAA_DEPLOY_SECRET is not configured")
        url = os.environ.get("JOMAA_DEPLOY_URL") or f"https://{config['webhook']['hostname']}{settings.WEBHOOK_PATH}"
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
            raise ValueError("deployment URL must be HTTPS without credentials or fragment")
        payload = {"repo": os.environ["GITHUB_REPOSITORY"], "sha": os.environ["GITHUB_SHA"],
                   "run_id": int(os.environ["GITHUB_RUN_ID"]), "attempt": int(os.environ["GITHUB_RUN_ATTEMPT"]),
                   "timestamp": int(time.time())}
        opener = urllib.request.build_opener(NoRedirect())
        deadline = time.monotonic() + retry["deadlineSeconds"]
        while True:
            payload["timestamp"] = int(time.time())
            body = json.dumps(payload, separators=(",", ":")).encode()
            signature = "sha256=" + hmac.new(key.encode(), body, hashlib.sha256).hexdigest()
            request = urllib.request.Request(url, data=body, method="POST", headers={
                "Content-Type": "application/json", "X-Jomaa-Signature": signature,
                "User-Agent": config["userAgent"]})
            try:
                with opener.open(request, timeout=retry["requestTimeoutSeconds"]) as response:
                    result = json.load(response)
                break
            except urllib.error.HTTPError as error:
                error.close()
                if error.code not in retry["retryStatuses"] or time.monotonic() >= deadline:
                    raise
            except (OSError, urllib.error.URLError):
                if time.monotonic() >= deadline:
                    raise
            print("Waiting for the deployment receiver to reconnect...", flush=True)
            time.sleep(retry["retryDelaySeconds"])
        if result.get("sha") != payload["sha"] or result.get("status") not in (*SUCCESS, PARTIAL):
            raise ValueError("unexpected response from deployment receiver")
        print(f"Deployment result: {result['status']} ({payload['sha'][:12]})")
        if result["status"] == PARTIAL:
            for name, status in sorted(result.get("modules", {}).items()):
                print(f"  {name}: {status}")
            print(f"  ingress: {json.dumps(result.get('ingress', {}))}")
            return 1
        return 0
    except (KeyError, ValueError, OSError, urllib.error.URLError) as e:
        print(f"deployment request failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
