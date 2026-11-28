"""Camera monitoring with the shared source environment in its deployment fingerprint."""
import hashlib
import json
import settings
from modules import Service
from modules.base import relative_path


class Frigate(Service):
    @property
    def inputs(self):
        if self.root is None:
            return super().inputs
        config = json.loads((self.root / self.directory / "config.json").read_text())
        hub_file = relative_path(config["hubSettingsFile"])
        hub = json.loads((self.root / hub_file).read_text())
        camera_file = relative_path(hub["cameraConfigFile"])
        return list(dict.fromkeys([*super().inputs, hub_file, camera_file]))

    def state_files(self, source):
        name = settings.CONFIG["cloudflare"]["env"]
        return {**super().state_files(source), name: hashlib.sha256((source / name).read_bytes()).hexdigest()}
