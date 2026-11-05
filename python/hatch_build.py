"""Package docs linked from AGENT_GUIDE.md into the wheel.

The guide is stored at ``loopiter/AGENT_GUIDE.md``, so a relative link such as
``docs/application-observation.md`` resolves to ``loopiter/docs/application-observation.md``.
The source file lives in the repository ``docs/`` directory, outside this project.
Sdists copy it under ``packaged-docs/`` so a wheel built from the sdist still finds it.
"""

import os
import re
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


def relative_doc_links(guide):
    links = []
    for target in re.findall(r"\[[^\]]*\]\(([^)\s]+)\)", guide):
        if "://" in target or target.startswith("#"):
            continue
        path = target.split("#", 1)[0].split("?", 1)[0]
        if not path:
            continue
        normalized = os.path.normpath(path)
        if (
            path.startswith("/")
            or "\\" in path
            or normalized.startswith("..")
            or os.path.isabs(normalized)
        ):
            message = f"AGENT_GUIDE.md link cannot be packaged: {target}"
            raise ValueError(message)
        links.append(normalized.replace(os.sep, "/"))
    return links


def _doc_source(root, link):
    packaged_root = (root / "packaged-docs").resolve()
    packaged = (packaged_root / link).resolve()
    if packaged.is_file() and packaged.is_relative_to(packaged_root):
        return packaged
    checkout_root = root.parent.resolve()
    checkout = (checkout_root / link).resolve()
    if checkout.is_file() and checkout.is_relative_to(checkout_root):
        return checkout
    message = f"AGENT_GUIDE.md links to {link}, which is not in the repository or packaged-docs"
    raise FileNotFoundError(message)


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version, build_data):
        root = Path(self.root)
        guide = (root / "AGENT_GUIDE.md").read_text(encoding="utf-8")
        for link in relative_doc_links(guide):
            source = _doc_source(root, link)
            if self.target_name == "sdist":
                destination = f"packaged-docs/{link}"
            else:
                destination = f"loopiter/{link}"
            build_data["force_include"][str(source)] = destination
