"""Exit-node access: syncs the tailnet policy with the accounts that have access.

The hub stores which account is linked to which Tailscale user and which of
them have exit-node access (access.sql). sync() builds group:family from those
accounts, writes the policy when it differs, reads it back, and records the
result for the hub's page. The hub runs it after every change, periodically,
and when it starts; deployments run it too. A lock in the deployment directory
keeps two syncs from overlapping.
"""
from __future__ import annotations

import fcntl
import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Iterator, Protocol

FAMILY = "group:family"

# Sync outcomes reported to the hub and in deployment output.
APPLIED = "applied"
CURRENT = "current"
OFF = "off"
FAILED = "failed"


class AccessError(Exception):
    """A sync could not complete; the message is safe to show."""


class Rejected(AccessError):
    """The provider definitively refused a request."""


class Uncertain(AccessError):
    """The provider gave no definitive answer: unreachable, timed out, or malformed."""


class Provider(Protocol):
    def policy(self) -> dict: ...

    def set_policy(self, policy: dict) -> None: ...

    def users(self) -> list[dict]: ...


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def family_members(policy: object) -> list[str]:
    """The members of group:family in a policy read from the provider; malformed is an error, not empty."""
    groups = policy.get("groups") if isinstance(policy, dict) else None
    if not isinstance(groups, dict):
        raise Uncertain("Tailscale returned a policy without groups")
    members = groups.get(FAMILY, [])
    if not isinstance(members, list) or not all(isinstance(m, str) for m in members):
        raise Uncertain(f"Tailscale returned a policy whose {FAMILY} is not a list of logins")
    return members


def render(template: dict, members: list[str]) -> dict:
    """The filled template with group:family; its tests apply only when the group has members."""
    return {**template, "groups": {**template["groups"], FAMILY: members},
            "tests": template["tests"] if members else []}


@contextmanager
def locked(path: Path, timeout: float, poll: float) -> Iterator[None]:
    """Holds an exclusive lock on path; released on exit, exceptions and process death."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as lock:
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise AccessError("Another sync is still running; the next sync tries again.")
                time.sleep(poll)
        yield


def connect(path: Path, timeout: float) -> sqlite3.Connection:
    """Opens the hub's account database, which must already hold the access tables."""
    if not path.is_file():
        raise AccessError(f"{path} does not exist; the hub creates it when it starts")
    db = sqlite3.connect(path, timeout=timeout, isolation_level=None)
    if db.execute("SELECT 1 FROM sqlite_master WHERE name='tailscale_sync'").fetchone() is None:
        db.close()
        raise AccessError(f"{path} has no access tables; start the current hub release first")
    return db


def record(db: sqlite3.Connection, now: int, error: str | None, family: list[str] | None) -> None:
    if family is None:
        db.execute("UPDATE tailscale_sync SET synced_at=?, error=? WHERE id=1", (now, error))
    else:
        db.execute("UPDATE tailscale_sync SET synced_at=?, error=?, family=?, family_read_at=? WHERE id=1",
                   (now, error, json.dumps(family), now))


def members(db: sqlite3.Connection, users: list[dict]) -> tuple[list[str], list[str]]:
    """Current logins of linked accounts with access, looked up by the provider's stable user ID.

    A changed login is saved; an account whose Tailscale user is gone is left
    out and returned separately.
    """
    by_id = {user["id"]: user for user in users if user["type"] == "member"}
    logins, missing = set(), []
    rows = db.execute("SELECT username, provider_user_id, login FROM tailscale_links WHERE access=1 ORDER BY username")
    for username, provider_user_id, login in rows.fetchall():
        user = by_id.get(provider_user_id)
        if user is None:
            missing.append(username)
            continue
        if user["loginName"] != login:
            db.execute("UPDATE tailscale_links SET login=? WHERE provider_user_id=?",
                       (user["loginName"], provider_user_id))
        logins.add(user["loginName"])
    return sorted(logins), missing


def sync(database: Path, provider: Provider, template: dict, lock: Path, lock_timeout: float, lock_poll: float,
         db_timeout: float, clock: Callable[[], float] = time.time) -> dict:
    """Makes the policy's group:family the logins of the accounts with access, confirmed by reading it back."""
    db = connect(database, db_timeout)
    try:
        now = int(clock() * 1000)
        try:
            with locked(lock, lock_timeout, lock_poll):
                if db.execute("SELECT enabled_at FROM tailscale_sync WHERE id=1").fetchone()[0] is None:
                    return {"status": OFF, "message": "Managed access is off; the tailnet policy was left as it is. "
                            "Turn it on at /tailscale."}
                logins, missing = members(db, provider.users())
                remote = provider.policy()
                family_members(remote)
                desired = render(template, logins)
                status = CURRENT
                if canonical(remote) != canonical(desired):
                    try:
                        provider.set_policy(desired)
                    except Uncertain:
                        pass  # The read below shows whether the write took effect.
                    remote = provider.policy()
                    if canonical(remote) != canonical(desired):
                        raise AccessError("Tailscale didn't keep the policy change; the next sync tries again.")
                    status = APPLIED
                error = f"Tailscale has no user for {', '.join(missing)}; link them again." if missing else None
                record(db, now, error, family_members(remote))
        except AccessError as e:
            record(db, now, str(e), None)
            return {"status": FAILED, "message": str(e)}
        message = "Updated the tailnet policy." if status == APPLIED else "The tailnet policy is current."
        return {"status": status, "message": message if error is None else f"{message} {error}"}
    finally:
        db.close()
