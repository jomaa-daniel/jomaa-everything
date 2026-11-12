"""The static server, with a static site for every hostname directory."""
from modules import Service, StaticSite


class StaticPages(Service):
    def children(self) -> list[StaticSite]:
        return StaticSite.discover(self)
