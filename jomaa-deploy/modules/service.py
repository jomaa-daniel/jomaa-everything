"""Services run as systemd user units; static sites are served by the static-pages service."""
from __future__ import annotations

import re
from pathlib import Path

import settings
from modules.base import (Context, Module, commands, command, declared_routes, expand, git_object, hostname,
                          local_url, routes, switch_link, unit_text)


class Service(Module):
    """Build commands, a systemd user unit, restart, an HTTP health check and rollback."""

    kind = "Service"
    phase = 1
    keys = (*Module.keys, "unit", "origin", "command", "build", "health", "routes")

    def validate(self) -> None:
        super().validate()
        d = self.declaration
        reserved = (settings.CONFIG["receiverUnit"], settings.CONFIG["tunnel"]["unit"])
        if not isinstance(d["unit"], str) or not re.fullmatch(r"jomaa-[a-z0-9-]+", d["unit"]) or d["unit"] in reserved:
            raise ValueError(f"invalid unit: {d['unit']!r}")
        local_url(d["origin"], ("http", "https", "ssh", "tcp"))
        command(d["command"])
        commands(d["build"], "build")
        health = d["health"]
        if (not isinstance(health, dict) or set(health) != {"path", "json"} or not isinstance(health["path"], str)
                or not health["path"].startswith("/") or not isinstance(health["json"], dict)):
            raise ValueError("health declares a path and the JSON fields its answer must contain")
        routes(d["routes"])

    @property
    def unit(self) -> str:
        return self.declaration["unit"]

    @property
    def origin(self) -> str:
        return self.declaration["origin"]

    def health_check(self) -> dict:
        return {"url": self.origin + self.declaration["health"]["path"], "json": self.declaration["health"]["json"]}

    def routes(self) -> list[dict]:
        return declared_routes(self, self.origin)

    def unit_file(self, ctx: Context) -> Path:
        return ctx.unit_dir / f"{self.unit}.service"

    def build(self, ctx: Context, release: Path) -> None:
        for arguments in self.declaration["build"]:
            ctx.run(*expand(arguments, release), cwd=release / self.directory)

    def start(self, ctx: Context) -> None:
        """Write the unit for the module pointer, then enable and restart it."""
        pointer = ctx.pointer(self.name)
        ctx.unit_dir.mkdir(parents=True, exist_ok=True)
        self.unit_file(ctx).write_text(unit_text(expand(self.declaration["command"], pointer),
                                                 pointer / self.directory,
                                                 {"JOMAA_DEPLOY_HOME": str(ctx.deploy_dir)}))
        ctx.systemctl("daemon-reload")
        ctx.systemctl("enable", f"{self.unit}.service")
        ctx.systemctl("restart", f"{self.unit}.service")

    def stop(self, ctx: Context) -> None:
        ctx.systemctl("disable", "--now", f"{self.unit}.service")
        self.unit_file(ctx).unlink(missing_ok=True)
        ctx.systemctl("daemon-reload")

    def snapshot(self, ctx: Context) -> dict:
        """The release the module pointer leads to and the unit file's text, each None when absent."""
        pointer = ctx.pointer(self.name)
        unit = self.unit_file(ctx)
        return {"pointer": str(pointer.resolve()) if pointer.exists() else None,
                "unit": unit.read_text() if unit.exists() else None}

    def activate(self, ctx: Context, release: Path) -> None:
        switch_link(ctx.pointer(self.name), release)
        self.start(ctx)
        previous = self.previous()
        if previous is not None and previous.unit != self.unit:
            previous.stop(ctx)

    def verify(self, ctx: Context) -> bool:
        return ctx.wait_healthy(self.health_check())

    def previous(self) -> Service | None:
        if self.record is None or self.record["declaration"] is None:
            return None
        return Service.from_record(self.record)

    def rollback(self, ctx: Context, snapshot: dict) -> str:
        previous = self.previous()
        if previous is None:
            return self.restore_replaced(ctx, snapshot)
        if previous.unit != self.unit:
            self.stop(ctx)
        switch_link(ctx.pointer(self.name), ctx.release_of(self.record["revision"]))
        previous.start(ctx)
        return "failed" if previous.verify(ctx) else "failed-unrestored"

    def restore_replaced(self, ctx: Context, snapshot: dict) -> str:
        """Without a recorded version, put back the unit file and pointer of the snapshot."""
        pointer = ctx.pointer(self.name)
        if snapshot["pointer"] is None:
            pointer.unlink(missing_ok=True)
        else:
            switch_link(pointer, Path(snapshot["pointer"]))
        if snapshot["unit"] is None:
            self.stop(ctx)
            return "failed"
        self.unit_file(ctx).write_text(snapshot["unit"])
        ctx.systemctl("daemon-reload")
        ctx.systemctl("restart", f"{self.unit}.service")
        return "failed" if self.verify(ctx) else "failed-unrestored"

    def remove(self, ctx: Context, record: dict) -> None:
        if record["declaration"] is not None:
            Service.from_record(record).stop(ctx)


class StaticSite(Module):
    """One hostname directory served by the static-pages service through the site map."""

    kind = "StaticSite"
    phase = 2
    keys = ("name", "origin")
    # The name is the folder name; build() checks that it is a hostname.
    name_pattern = re.compile(r"[^./][^/]*")

    def __init__(self, directory: str, declaration: object, root: Path | None = None,
                 parent: Module | None = None):
        super().__init__(directory, declaration, root)
        self.parent = parent

    @classmethod
    def discover(cls, parent: Service) -> list[StaticSite]:
        """A site for every direct subdirectory of the parent named like a hostname."""
        assert parent.root is not None
        sites = []
        for folder in sorted((parent.root / parent.directory).iterdir()):
            if folder.name.startswith(".") or "." not in folder.name or not (folder.is_dir() or folder.is_symlink()):
                continue
            sites.append(cls(parent.directory, {"name": folder.name, "origin": parent.origin}, parent.root, parent))
        return sites

    def validate(self) -> None:
        super().validate()
        local_url(self.declaration["origin"], ("http", "https"))

    def paths(self) -> list[str]:
        return [f"{self.directory}/{self.name}"]

    def objects(self, repo: Path, sha: str) -> dict[str, str]:
        return {path: git_object(repo, sha, path) for path in self.paths()}

    def check_job(self) -> str | None:
        return self.parent.check_job() if self.parent is not None else None

    def routes(self) -> list[dict]:
        return [{"hostname": self.name, "probes": None, "origin": self.declaration["origin"]}]

    def folder(self, release: Path) -> Path:
        return release / self.directory / self.name

    def build(self, ctx: Context, release: Path) -> None:
        hostname(self.name)
        folder = self.folder(release)
        if folder.is_symlink():
            raise ValueError(f"site directory cannot be a symlink: {self.name}")
        index = folder / "index.html"
        if not index.is_file() or not index.resolve().is_relative_to(folder.resolve()):
            raise ValueError(f"site needs an index.html inside its folder: {self.name}")

    def snapshot(self, ctx: Context) -> dict:
        """The site's directory in the site map, or None."""
        return {"site": ctx.sites.load().get(self.name)}

    def activate(self, ctx: Context, release: Path) -> None:
        ctx.sites.set(self.name, self.folder(release))

    def verify(self, ctx: Context) -> bool:
        return ctx.healthy({"url": self.declaration["origin"] + "/", "host": self.name})

    def rollback(self, ctx: Context, snapshot: dict) -> str:
        ctx.sites.set(self.name, Path(snapshot["site"]) if snapshot["site"] is not None else None)
        return "failed"

    def remove(self, ctx: Context, record: dict) -> None:
        ctx.sites.set(record["name"], None)
