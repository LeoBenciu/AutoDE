"""
Per-document extraction metrics (task 4).

Given the subprocess architecture (Node spawns `python3 main.py` per document),
the lowest-friction durable sink is an append-only JSONL event stream. Each
extraction appends one line; a downstream job (or the Node service) can tail
and aggregate it, or ship it to a real table later without changing callers.

Two sinks, both best-effort (never raise into the extraction path):
  1. JSONL file at FINOVA_METRICS_PATH (default /tmp/finova_metrics/extraction_metrics.jsonl)
  2. A single stderr line prefixed `FINOVA_METRIC ` so the Node service — which
     already captures the subprocess's stderr — can scrape it in real time.

Field-level accuracy (correction rate) is NOT computed here: it requires
joining against user corrections recorded later. Emit the raw extraction event
now; compute correction rate in the aggregation step by matching document_hash.
"""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Any, Dict, List, Optional

_DEFAULT_PATH = "/tmp/finova_metrics/extraction_metrics.jsonl"


def _metrics_path() -> str:
    return os.getenv("FINOVA_METRICS_PATH", _DEFAULT_PATH)


def metrics_enabled() -> bool:
    # On by default; set FINOVA_METRICS_ENABLED=false to disable.
    return os.getenv("FINOVA_METRICS_ENABLED", "true").lower() != "false"


def record_extraction(
    *,
    phase: int,
    document_type: str,
    document_hash: str,
    model: str,
    success: bool,
    duration_ms: int,
    retry_count: int,
    prompt_tokens: Optional[int] = None,
    completion_tokens: Optional[int] = None,
    line_item_count: Optional[int] = None,
    empty_fields: Optional[List[str]] = None,
    error: Optional[str] = None,
    accounting_client_id: Optional[str] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> None:
    """Append one extraction event. Best-effort; never raises."""
    if not metrics_enabled():
        return

    event: Dict[str, Any] = {
        "ts": int(time.time() * 1000),
        "phase": phase,
        "document_type": document_type,
        "document_hash": document_hash,
        "model": model,
        "success": success,
        "duration_ms": duration_ms,
        "retry_count": retry_count,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "line_item_count": line_item_count,
        "empty_fields": empty_fields or [],
        "error": error,
        "accounting_client_id": accounting_client_id,
    }
    if extra:
        event.update(extra)

    line = json.dumps(event, ensure_ascii=False)

    # Sink 1: stderr (scraped live by the Node service).
    try:
        print(f"FINOVA_METRIC {line}", file=sys.stderr)
    except Exception:
        pass

    # Sink 2: append-only JSONL file.
    try:
        path = _metrics_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception as e:  # pragma: no cover - sink must never break extraction
        try:
            print(f"⚠️  metrics write failed: {e}", file=sys.stderr)
        except Exception:
            pass


# Critical fields per document type — used to compute empty_fields at emit time.
# Mirrors the controller's getCriticalFieldsForDocType so both sides agree.
CRITICAL_FIELDS = {
    "Invoice": ["vendor", "document_date", "total_amount", "line_items"],
    "Receipt": ["vendor", "document_date", "total_amount"],
    "Bank Statement": ["transactions"],
    "Contract": ["parties", "contract_date"],
    "Z Report": ["report_number", "daily_sales_total"],
    "Payment Disposition": ["total_amount", "document_number"],
    "Collection Disposition": ["total_amount", "document_number"],
    "CMR": ["carrier_name", "place_of_loading", "place_of_delivery"],
    "Customs Declaration": ["mrn"],
    "Vehicle Registration Certificate": ["vin", "make", "model"],
    "Technical Inspection (ITP)": ["vin", "valid_until"],
    "Insurance": ["policy_number", "insurer_name"],
    "Other": ["summary"],
}


def compute_empty_fields(document_type: str, data: Dict[str, Any]) -> List[str]:
    """Return the critical fields that are empty for this document type."""
    empty: List[str] = []
    for field in CRITICAL_FIELDS.get(document_type, []):
        value = data.get(field)
        # A numeric 0 (e.g. a legitimate 0.00 total) is a *present* value, not an
        # empty field — don't flag it, or we trigger pointless retries.
        if value is None or value == "" or (isinstance(value, list) and len(value) == 0):
            empty.append(field)
    return empty
