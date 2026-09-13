"""Canonical JSON and bounded base64url helpers shared by signed documents."""

from __future__ import annotations

import base64
import json
import re
from typing import Any

_BASE64URL_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def canonical_json(value: Any) -> bytes:
    """Serialize JSON deterministically for signature generation and verification."""

    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def decode_base64url(value: str, *, max_bytes: int) -> bytes:
    if not isinstance(value, str) or not value or not _BASE64URL_RE.fullmatch(value):
        raise ValueError("value is not unpadded base64url")
    if len(value) > ((max_bytes + 2) // 3) * 4:
        raise ValueError("decoded value exceeds size limit")
    padding = "=" * (-len(value) % 4)
    try:
        decoded = base64.urlsafe_b64decode(value + padding)
    except (ValueError, TypeError) as exc:
        raise ValueError("invalid base64url value") from exc
    if len(decoded) > max_bytes:
        raise ValueError("decoded value exceeds size limit")
    return decoded


def encode_base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")
