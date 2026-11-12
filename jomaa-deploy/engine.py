"""Discover the modules of a release and deploy each one on its own.

Phases run in a fixed order: checks and external origins, services, static
sites, ingress, then commands. A module is built and activated only when its
fingerprint changed or its last attempt failed; commands run every time. A
failure is contained in its module, which keeps its previous version.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import shutil
import sys
from collections import defaultdict
from pathlib import Path

from modules import KINDS, Module
from modules import ingress
from modules.base import Context, DeployError, atomic_write, switch_link

ENTRY = "deploy_module.py"
RECORD = "record.json"
SUCCESS = ("deployed", "unchanged", "removed")
PHASES = (0, 1, 2, "ingress", 4)


def import_classes(root: Path, directory: str) -> list[type[Module]]:
    """Import <directory>/deploy_module.py and return the module classes it defines."""
    path = root / directory / ENTRY
    name = "deploy_module_" + hashlib.sha256(str(path).encode()).hexdigest()[:16]
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, path)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
        except BaseException:
            del sys.modules[name]
            raise
    return [cls for cls in Module.registry if cls.__module__ == name]


def discover(root: Path) -> tuple[list[Module], dict[str, str]]:
    """Every module and child declared by a top-level deploy_module.py, and the folders that failed to load."""
    modules: list[Module] = []
    failures: dict[str, str] = {}
    for folder in sorted(root.iterdir()):
        if folder.name.startswith(".") or not (folder / ENTRY).is_file():
            continue
        try:
            classes = import_classes(root, folder.name)
            if not classes:
                raise DeployError(f"{ENTRY} defines no module class")
            found = []
            for cls in classes:
                module = cls.load(root, folder.name)
                found += [module, *module.children()]
        except (Exception, SystemExit) as error:
            failures[folder.name] = f"{type(error).__name__}: {error}"
            continue
        modules.extend(found)
    for field in ("name", "unit"):
        owners: dict[str, list[str]] = defaultdict(list)
        for module in modules:
            value = getattr(module, field, None)
            if value is not None:
                owners[value].append(module.directory)
        for value, directories in owners.items():
            if len(directories) > 1:
                for directory in directories:
                    failures[directory] = f"{field} {value} is declared more than once"
        modules = [m for m in modules if m.directory not in failures]
    return modules, failures


def link_state(release: Path, source: Path, paths: list[str]) -> None:
    """Link runtime state paths of the local checkout into the release."""
    for name in paths:
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


def records(deploy_dir: Path) -> dict[str, dict]:
    found = {}
    for path in sorted((deploy_dir / "modules").glob(f"*/{RECORD}")):
        record = json.loads(path.read_text())
        found[record["name"]] = record
    return found


def save(ctx: Context, record: dict) -> None:
    atomic_write(ctx.deploy_dir / "modules" / record["name"] / RECORD, json.dumps(record, indent=2) + "\n")


def instance(record: dict) -> Module | None:
    """The module as recorded, or None when no version of it is live or the record no longer loads."""
    if record["declaration"] is None:
        return None
    try:
        return KINDS[record["kind"]].from_record(record)
    except (KeyError, TypeError, ValueError) as error:
        print(f"the record of {record['name']} does not load: {error}", file=sys.stderr, flush=True)
        return None


def deploy(ctx: Context, module: Module, record: dict | None, jobs: dict[str, str | None] | None) -> str:
    """Build, activate and verify one module, restoring its previous version on failure."""
    module.record = record
    job = module.check_job()
    if jobs is not None and job is not None and jobs.get(job) != "success":
        print(f"{module.name}: {job} did not succeed; keeping the deployed version", flush=True)
        return "ineligible"
    failed = {"name": module.name, "kind": module.kind, "directory": module.directory, "revision": None,
              "fingerprint": None, "declaration": None, **(record or {}), "failed": True}
    pointer = ctx.pointer(module.name)
    before = pointer.resolve() if pointer.exists() else None
    activated = False
    try:
        ctx.begin()
        fingerprint = module.fingerprint(ctx.repo, ctx.sha)
        if not module.always and record is not None and not record["failed"] and record["fingerprint"] == fingerprint:
            return "unchanged"
        print(f"Deploying {module.name}", flush=True)
        module.build(ctx, ctx.release)
        activated = True
        module.activate(ctx, ctx.release)
        if not module.verify(ctx):
            raise DeployError(f"{module.name} did not pass its health check")
    except Exception as error:
        print(f"{module.name} failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
        status = "failed"
        if activated:
            ctx.begin()
            try:
                status = module.rollback(ctx)
            except Exception as problem:
                print(f"{module.name} could not be restored: {problem}", file=sys.stderr, flush=True)
                status = "failed-unrestored"
        save(ctx, failed)
        return status
    if before is not None and before != ctx.release:
        switch_link(pointer.with_name("previous"), before)
    switch_link(pointer, ctx.release)
    save(ctx, {"name": module.name, "kind": module.kind, "directory": module.directory, "revision": ctx.sha,
               "fingerprint": fingerprint, "declaration": module.declaration, "failed": False})
    return "deployed"


def remove(ctx: Context, record: dict) -> str:
    try:
        ctx.begin()
        module = instance(record)
        if module is not None:
            module.remove(ctx, record)
        shutil.rmtree(ctx.deploy_dir / "modules" / record["name"])
        return "removed"
    except Exception as error:
        print(f"{record['name']} could not be removed: {error}", file=sys.stderr, flush=True)
        return "failed"


def activate(ctx: Context, jobs: dict[str, str | None] | None) -> dict:
    """Deploy every module of ctx.release, switch the current pointer to it and report each module."""
    known = records(ctx.deploy_dir)
    modules, failures = discover(ctx.release)
    results: dict[str, str] = {}
    live: dict[str, Module] = {}
    for directory, error in failures.items():
        print(f"{directory} failed to load: {error}", file=sys.stderr, flush=True)
        recorded = [r for r in known.values() if r["directory"] == directory]
        for record in recorded:
            results[record["name"]] = "failed"
            module = instance(record)
            if module is not None:
                live[record["name"]] = module
        if not recorded:
            results[directory] = "failed"
    state_errors = {}
    unloaded = list(live.values())
    for name, paths in [(m.name, m.state) for m in [*modules, *unloaded]]:
        try:
            link_state(ctx.release, ctx.source, paths)
        except (DeployError, OSError) as error:
            state_errors[name] = str(error)
    names = {m.name for m in modules}
    removed = [r for name, r in known.items() if name not in names and r["directory"] not in failures]

    ingress_result: dict = {}
    for phase in PHASES:
        if phase == "ingress":
            ctx.begin()
            ingress_result = ingress.apply(ctx, list(live.values()))
            ctx.inventory = ingress.inventory(list(live.values()), ctx.config)
            continue
        for module in sorted((m for m in modules if m.phase == phase), key=lambda m: m.name):
            record = known.get(module.name)
            if module.name in state_errors:
                print(f"{module.name} failed: {state_errors[module.name]}", file=sys.stderr, flush=True)
                status = "failed"
            else:
                status = deploy(ctx, module, record, jobs)
            results[module.name] = status
            previous = instance(record) if record is not None else None
            if status == "deployed":
                live[module.name] = module
            elif previous is not None:
                live[module.name] = previous
        for record in removed:
            if KINDS[record["kind"]].phase == phase:
                results[record["name"]] = remove(ctx, record)
    switch_link(ctx.deploy_dir / "current", ctx.release)
    ok = all(status in SUCCESS for status in results.values()) and not ingress.failed(ingress_result)
    return {"status": "deployed" if ok else "partial", "modules": dict(sorted(results.items())),
            "ingress": ingress_result}
