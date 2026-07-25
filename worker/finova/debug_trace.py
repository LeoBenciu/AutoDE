"""Structured, opt-in debug trace for the document-processing flow.

Why: bank-statement extraction fails in ways we couldn't localize from the final
output alone — we couldn't tell whether the OCR text was garbled, the model
mis-read clean text, or a deterministic post-processing step corrupted a correct
read. This records each stage's key data into one object that is attached to the
result as ``_debug`` and therefore rides through Node → the client → the
"RAW EXTRACTED DATA" / "DEBUG TRACE" section of the report the user copies, so the
whole pipeline becomes observable from a single paste. It also echoes each stage
to stderr (which Node already relays to its logs / Render).

Off by default (zero overhead): enable with ``FINOVA_DEBUG_TRACE=1``.

Design: a process-wide singleton (``TRACE``). The Python process handles exactly
one document per invocation, so the singleton is naturally per-document; call
``TRACE.reset(doc_hash)`` at the start of a document and read ``TRACE.as_dict()``
at the end. Stages just ``from debug_trace import TRACE`` and call
``TRACE.stage(...)`` — no function signatures change, so instrumentation stays
local and conflict-free. Thread-safe for the concurrent bank-chunk extraction.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from typing import Any, Dict, List, Optional


def trace_enabled() -> bool:
    return os.getenv("FINOVA_DEBUG_TRACE", "").strip().lower() in ("1", "true", "yes", "on")


# How much of a long string (OCR text, raw model JSON) to embed inline. The full
# text is written to a side file via dump_full(); only this much rides in _debug.
SAMPLE_CHARS = int(os.getenv("FINOVA_DEBUG_SAMPLE_CHARS", "2500"))
_DEBUG_DIR = "/tmp/finova_debug"


class Trace:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.enabled = trace_enabled()
        self.doc_hash = "doc"
        self.stages: List[Dict[str, Any]] = []

    def reset(self, doc_hash: str = "") -> "Trace":
        with self._lock:
            self.enabled = trace_enabled()
            self.doc_hash = (doc_hash or "doc")[:32]
            self.stages = []
        return self

    def stage(self, name: str, **fields: Any) -> None:
        """Record one stage. Values are coerced to JSON-safe; long strings should
        be pre-truncated by the caller via ``sample()``."""
        if not self.enabled:
            return
        rec: Dict[str, Any] = {"stage": name}
        for k, v in fields.items():
            try:
                json.dumps(v, default=str)
                rec[k] = v
            except Exception:
                rec[k] = str(v)
        with self._lock:
            self.stages.append(rec)
        # Echo to stderr so it also lands in Node/Render logs (one line, bounded).
        try:
            line = json.dumps(rec, ensure_ascii=False, default=str)
            sys.stderr.write(f"[PY-TRACE] {line[:2000]}\n")
            sys.stderr.flush()
        except Exception:
            pass

    def sample(self, text: Any, n: int = SAMPLE_CHARS) -> str:
        if not self.enabled or not text:
            return ""
        s = str(text)
        return s if len(s) <= n else (s[:n] + f"…(+{len(s) - n} chars)")

    def dump_full(self, name: str, text: Any) -> Optional[str]:
        """Write the full text to /tmp/finova_debug/<hash>.<name>.txt; return path.

        For OCR text / raw model output that is too big to embed but is exactly
        what we need to inspect. The path is recorded in the trace so the user can
        grab the file when a sample isn't enough.
        """
        if not self.enabled or not text:
            return None
        try:
            os.makedirs(_DEBUG_DIR, exist_ok=True)
            path = os.path.join(_DEBUG_DIR, f"{self.doc_hash}.{name}.txt")
            with open(path, "w", encoding="utf-8") as f:
                f.write(str(text))
            return path
        except Exception:
            return None

    def as_dict(self) -> Optional[Dict[str, Any]]:
        if not self.enabled:
            return None
        with self._lock:
            return {"enabled": True, "doc_hash": self.doc_hash, "stages": list(self.stages)}


# ---------------------------------------------------------------------------
# Bank-statement diagnostic helpers (used by several stages, kept in one place
# so the numbers always match the eval oracle's gap math).
# ---------------------------------------------------------------------------

def _num(v: Any) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def txn_summary(data: Dict[str, Any]) -> Dict[str, Any]:
    """Compact diagnostic snapshot of a bank statement's transactions: counts,
    Σdebit/Σcredit, first/last printed balance, recon gap, and negative-balance
    rows — enough to see at a glance whether THIS stage's data reconciles."""
    txns = data.get("transactions") if isinstance(data, dict) else None
    if not isinstance(txns, list):
        return {"txns": 0}
    sdr = sum(abs(_num(t.get("debit_amount")) or 0.0) for t in txns if isinstance(t, dict))
    scr = sum(abs(_num(t.get("credit_amount")) or 0.0) for t in txns if isinstance(t, dict))
    bals = [_num(t.get("balance_after_transaction")) for t in txns if isinstance(t, dict)]
    bals = [b for b in bals if b is not None]
    ob, cb = _num(data.get("opening_balance")), _num(data.get("closing_balance"))
    gap = None
    if ob is not None and cb is not None:
        gap = round(abs(ob + scr - sdr - cb), 2)
    return {
        "txns": len(txns),
        "sum_debit": round(sdr, 2),
        "sum_credit": round(scr, 2),
        "opening": ob,
        "closing": cb,
        "first_balance": bals[0] if bals else None,
        "last_balance": bals[-1] if bals else None,
        "recon_gap": gap,
        "negative_balance_rows": sum(1 for b in bals if b < 0),
    }


def glued_numbers_score(text: str, limit: int = 20000) -> int:
    """Heuristic count of OCR "glued number" artifacts (a digit jammed against a
    letter or another number with no separating space, e.g. 'RAMNICU8.60',
    '/IRF .00.04'). A high count over the transaction region is strong evidence
    the OCR merged columns / lost the amount column structure."""
    import re
    head = (text or "")[:limit]
    return len(re.findall(r"[A-Za-z]\d|\d[A-Za-z]", head))


# Process-wide singleton.
TRACE = Trace()
