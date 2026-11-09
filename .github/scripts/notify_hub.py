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


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main() -> int:
    try:
        key = os.environ.get("HUB_DEPLOY_SECRET", "")
        if len(key) < 32:
            raise ValueError("HUB_DEPLOY_SECRET is not configured")
        url = os.environ.get("HUB_DEPLOY_URL", "https://hub.jomaa.org/deploy")
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
            raise ValueError("deployment URL must be HTTPS without credentials or fragment")
        payload = {"repo": os.environ["GITHUB_REPOSITORY"], "sha": os.environ["GITHUB_SHA"],
                   "run_id": int(os.environ["GITHUB_RUN_ID"]), "attempt": int(os.environ["GITHUB_RUN_ATTEMPT"]),
                   "timestamp": int(time.time())}
        body = json.dumps(payload, separators=(",", ":")).encode()
        signature = "sha256=" + hmac.new(key.encode(), body, hashlib.sha256).hexdigest()
        request = urllib.request.Request(url, data=body, method="POST", headers={
            "Content-Type": "application/json", "X-Jomaa-Signature": signature,
            "User-Agent": "jomaa-home-hub-deployer/1.0"})
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=300) as response:
            result = json.load(response)
        if result.get("sha") != payload["sha"] or result.get("status") not in (
                "deployed", "already-deployed", "older-revision-ignored"):
            raise ValueError("unexpected response from deployment receiver")
        print(f"Deployment result: {result['status']} ({payload['sha'][:12]})")
        return 0
    except (KeyError, ValueError, OSError, urllib.error.URLError) as e:
        print(f"deployment request failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
