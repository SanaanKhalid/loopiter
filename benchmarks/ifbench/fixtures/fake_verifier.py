#!/usr/bin/env python3
"""Stand-in verifier for bridge tests. It does not import ifbench."""

import json
import os
import sys
import time

pid_path = os.environ.get("FAKE_PID_FILE")
log_path = os.environ.get("FAKE_CHUNK_LOG")
mode = sys.argv[1] if len(sys.argv) > 1 else "fast"
if pid_path:
    with open(pid_path, "a", encoding="utf-8") as handle:
        handle.write(f"{os.getpid()}\n")

for line in sys.stdin:
    if not line.strip():
        continue
    message = json.loads(line)
    items = message["items"]
    if log_path:
        with open(log_path, "a", encoding="utf-8") as handle:
            handle.write(f"{len(items)}\n")
    if mode == "slow":
        time.sleep(2)
    rows = [
        {
            "strictPrompt": mode != "slow",
            "loosePrompt": mode != "slow",
            "instructions": [],
            "marker": mode,
        }
        for _item in items
    ]
    sys.stdout.write(json.dumps({"id": message.get("id"), "rows": rows}) + "\n")
    sys.stdout.flush()
