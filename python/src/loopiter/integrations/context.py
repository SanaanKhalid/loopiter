"""Released guidance formatting, adapted from Supermemory (MIT).

Copyright (c) 2025 Supermemory Inc. See THIRD_PARTY_NOTICES.md.
Formatting is not a prompt-injection security boundary.
"""

import re

_START = '<loopiter context="released-guidance" readonly>'
_END = "</loopiter>"
_BLOCK = re.compile(r'(?:\r?\n)?<loopiter context="released-guidance" readonly>[\s\S]*?</loopiter>')
_DELIMITER = re.compile(r"<\s*/?\s*loopiter\b[^>]*>", re.IGNORECASE)


def strip_guidance(content: str) -> str:
    return _BLOCK.sub("", content)


def replace_guidance(content: str, guidance: str) -> str:
    preserved, normalized = strip_guidance(content), guidance.strip()
    if not normalized:
        return preserved
    escaped = _DELIMITER.sub(
        lambda match: match[0].replace("<", "&lt;").replace(">", "&gt;"), normalized
    )
    wrapped = f"{_START}\n{escaped}\n{_END}"
    return f"{preserved}\n{wrapped}" if preserved else wrapped


def guidance_messages(messages: list[dict], guidance: str) -> list[dict]:
    result, injected = [], False
    for message in messages:
        if message.get("role") not in ("system", "developer"):
            result.append(message)
            continue
        if not isinstance(message.get("content"), str):
            raise TypeError("Guidance injection requires text instruction messages.")
        content = (
            strip_guidance(message["content"])
            if injected
            else replace_guidance(message["content"], guidance)
        )
        result.append({**message, "content": content})
        injected = True
    if not injected and guidance.strip():
        result.insert(0, {"role": "system", "content": replace_guidance("", guidance)})
    return result
