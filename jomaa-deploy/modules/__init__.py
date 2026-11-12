"""Deployment module classes that component deploy_module.py files extend."""
from modules.base import VERIFY_JOB, Context, DeployError, Module
from modules.command import Checks, Command, External
from modules.service import Service, StaticSite

KINDS: dict[str, type[Module]] = {cls.kind: cls for cls in (Checks, External, Service, StaticSite, Command)}

__all__ = ["KINDS", "VERIFY_JOB", "Checks", "Command", "Context", "DeployError", "External", "Module", "Service",
           "StaticSite"]
