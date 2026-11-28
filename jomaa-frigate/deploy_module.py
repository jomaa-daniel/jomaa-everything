"""Camera monitoring with the shared source environment in its deployment fingerprint."""
import hashlib
import settings
from modules import Service


class Frigate(Service):
    def state_files(self, source):
        name = settings.CONFIG["cloudflare"]["env"]
        return {**super().state_files(source), name: hashlib.sha256((source / name).read_bytes()).hexdigest()}
