#!/usr/bin/env python3
"""Exit 1 unless a targeted plan's only real change is one address."""
import json
import sys

allowed = sys.argv[1]
document = json.load(sys.stdin)
changed = []
for entry in document.get("resource_changes") or []:
    actions = (entry.get("change") or {}).get("actions") or []
    if actions in (["no-op"], ["read"]):
        continue
    changed.append(str(entry.get("address", "<unknown>")))
extra = [address for address in changed if address != allowed]
if extra or len(changed) > 1:
    sys.stderr.write("Targeted plan would change more than %s:\n" % allowed)
    for address in extra or changed:
        sys.stderr.write("  %s\n" % address)
    sys.stderr.write(
        "Run plan and review those changes before apply. "
        "Web and worker were not updated.\n"
    )
    sys.exit(1)
