#!/usr/bin/env python3
"""Confirm new Pico reports are accepted and persisted by the configured HTTPS hub."""
from __future__ import annotations

import argparse
from pathlib import Path
import sys

from common import BenchError, HubClient, private_json, verify_reports


def progress(done, count):
    print("Accepted new health reports: %d/%d" % (done, count), flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepared", type=Path, required=True)
    parser.add_argument("--hub-password-file", help="private file with only the administrator password")
    parser.add_argument("--reports", type=int, default=3)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--report", type=Path, help="new private JSON result file")
    args = parser.parse_args(argv)
    try:
        if not 2 <= args.reports <= 20 or not 10 <= args.timeout <= 3600:
            raise BenchError("reports must be 2–20 and timeout must be 10–3600 seconds")
        client = HubClient(args.prepared, args.hub_password_file)
        result = verify_reports(client, client.config["id"], args.reports, args.timeout, progress)
        if args.report:
            private_json(args.report, result)
        print("PASS: %s is %s at %s" % (result["deviceId"], result["status"], result["latest"]["ip"]))
        return 0
    except Exception as error:
        print("Health test failed: " + (str(error) if isinstance(error, BenchError) else type(error).__name__), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
