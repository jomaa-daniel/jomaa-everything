import json
import unittest
from pathlib import Path

import verify


def report(*advisories):
    return {"vulnerabilities": {"picomatch": {"via": list(advisories)}, "micromatch": {"via": ["picomatch"]}}}


def advisory(ghsa, severity):
    return {"name": "picomatch", "title": "ReDoS", "severity": severity,
            "url": f"https://github.com/advisories/{ghsa}"}


class AuditTest(unittest.TestCase):
    def test_audit_md_documents_every_setting(self):
        doc = (verify.HUB_DIR / "audit.md").read_text()
        for key in json.loads(verify.AUDIT_FILE.read_text()):
            self.assertIn(f"`{key}`", doc)

    def test_every_accepted_advisory_has_a_reason(self):
        doc = (verify.HUB_DIR / "audit.md").read_text()
        for advisory_id in json.loads(verify.AUDIT_FILE.read_text())["acceptedAdvisories"]:
            self.assertIn(f"- `{advisory_id}`:", doc)

    def test_only_unaccepted_advisories_at_or_above_the_level_fail(self):
        found = verify.unaccepted(report(advisory("GHSA-accepted", "critical"), advisory("GHSA-new", "high"),
                                         advisory("GHSA-minor", "moderate")), "high", ["GHSA-accepted"])
        self.assertEqual(found, ["GHSA-new (high): picomatch ReDoS"])
        self.assertEqual(verify.unaccepted(report(advisory("GHSA-accepted", "high")), "high", ["GHSA-accepted"]), [])


if __name__ == "__main__":
    unittest.main()
