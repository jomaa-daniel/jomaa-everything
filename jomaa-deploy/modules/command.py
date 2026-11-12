"""Commands, external origins and check-only modules."""
from __future__ import annotations

import json
from pathlib import Path

from modules.base import (Context, Module, atomic_write, command, commands, declared_routes, expand, local_url,
                          relative_path, routes)


class Command(Module):
    """Runs its build and command on every activation; a failure is not rolled back."""

    kind = "Command"
    phase = 4
    always = True
    keys = (*Module.keys, "build", "command", "inventory")

    def validate(self) -> None:
        super().validate()
        commands(self.declaration["build"], "build")
        command(self.declaration["command"])
        if self.declaration["inventory"] is not None:
            relative_path(self.declaration["inventory"])

    def build(self, ctx: Context, release: Path) -> None:
        for arguments in self.declaration["build"]:
            ctx.run(*expand(arguments, release), cwd=release / self.directory)

    def activate(self, ctx: Context, release: Path) -> None:
        if self.declaration["inventory"] is not None:
            atomic_write(release / self.directory / self.declaration["inventory"],
                         json.dumps(ctx.inventory, indent=2) + "\n")
        ctx.run(*expand(self.declaration["command"], release), cwd=release / self.directory)


class External(Module):
    """An origin provisioned outside deployment, published through routes."""

    kind = "External"
    phase = 0
    keys = (*Module.keys, "origin", "routes")

    def validate(self) -> None:
        super().validate()
        local_url(self.declaration["origin"], ("http", "https", "ssh", "tcp"))
        routes(self.declaration["routes"])

    @property
    def origin(self) -> str:
        return self.declaration["origin"]

    def routes(self) -> list[dict]:
        return declared_routes(self, self.origin)


class Checks(Module):
    """Checks only; nothing is deployed."""

    kind = "Checks"
    phase = 0
