"""
Canonical document hashing (task 6).

ONE hash for a document everywhere: SHA-256 of the decoded file bytes, hex.

Why content (not path, not base64 string):
- The Node side stores the same SHA-256 of the raw file buffer in Prisma
  (`Document.documentHash`). Hashing content here makes the agent's
  `document_hash` match the DB, so exact-duplicate detection actually works.
- Path-based hashing broke cross-process cache sharing: Node never knows the
  agent's random temp-file path, so `/tmp/text_cache` keys never lined up.
  Content hashing is identical on both sides (base64 round-trip is lossless).

Use `sha256_file` for the canonical document hash and for any `/tmp/text_cache`
or `/tmp/coa_relevance` cache key.
"""

import hashlib

_CHUNK = 1024 * 1024  # 1 MiB streaming read


def sha256_file(path: str) -> str:
    """SHA-256 (hex) of a file's bytes. Returns '' on read failure."""
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(_CHUNK), b""):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return ""


def sha256_bytes(data: bytes) -> str:
    """SHA-256 (hex) of raw bytes."""
    return hashlib.sha256(data).hexdigest()
