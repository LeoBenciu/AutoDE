#!/usr/bin/env python3
"""
Aggregate the extraction metrics JSONL into a per-document-type report.

Usage:
    python3 metrics_report.py [path-to-metrics.jsonl]

Defaults to FINOVA_METRICS_PATH or /tmp/finova_metrics/extraction_metrics.jsonl.

This is the "minimal dashboard" for prompt iteration: it answers, per document
type, "is the new prompt/model helping?" via success rate, retry rate, latency,
token cost, and which critical fields most often come back empty.

Field-level *correction* rate (extraction vs. what the user fixed) is not here —
that needs a join against user corrections by document_hash, which lives on the
Node/Prisma side. This report covers everything computable from extraction
events alone.
"""

from __future__ import annotations

import json
import os
import sys
from collections import Counter, defaultdict
from typing import Any, Dict, List


def _default_path() -> str:
    return os.getenv("FINOVA_METRICS_PATH", "/tmp/finova_metrics/extraction_metrics.jsonl")


def load_events(path: str) -> List[Dict[str, Any]]:
    events: List[Dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return events


def _avg(values: List[float]) -> float:
    nums = [v for v in values if isinstance(v, (int, float))]
    return sum(nums) / len(nums) if nums else 0.0


def report(events: List[Dict[str, Any]]) -> str:
    # Group by (phase, document_type)
    groups: Dict[tuple, List[Dict[str, Any]]] = defaultdict(list)
    for e in events:
        groups[(e.get("phase"), e.get("document_type", "Unknown"))].append(e)

    lines: List[str] = []
    lines.append(f"Extraction metrics — {len(events)} events\n")
    header = f"{'phase':<6}{'doc_type':<22}{'n':>5}{'ok%':>7}{'retry%':>8}{'ms(avg)':>9}{'tok_in':>8}{'tok_out':>8}{'cache%':>8}"
    lines.append(header)
    lines.append("-" * len(header))

    for (phase, doc_type), evs in sorted(groups.items(), key=lambda kv: (kv[0][0] or 0, kv[0][1])):
        n = len(evs)
        ok = sum(1 for e in evs if e.get("success"))
        retried = sum(1 for e in evs if (e.get("retry_count") or 0) > 0)
        ok_pct = 100.0 * ok / n if n else 0.0
        retry_pct = 100.0 * retried / n if n else 0.0
        avg_ms = _avg([e.get("duration_ms", 0) for e in evs])
        avg_in = _avg([e.get("prompt_tokens") or 0 for e in evs])
        avg_out = _avg([e.get("completion_tokens") or 0 for e in evs])
        # Cache hit rate = cached prompt tokens / total prompt tokens.
        tot_in = sum(e.get("prompt_tokens") or 0 for e in evs)
        tot_cached = sum(e.get("cached_tokens") or 0 for e in evs)
        cache_pct = (100.0 * tot_cached / tot_in) if tot_in else 0.0
        lines.append(
            f"{str(phase):<6}{doc_type:<22}{n:>5}{ok_pct:>6.1f}%{retry_pct:>7.1f}%"
            f"{avg_ms:>9.0f}{avg_in:>8.0f}{avg_out:>8.0f}{cache_pct:>7.0f}%"
        )

        # Most-common empty critical fields (Phase 1 only).
        empties: Counter = Counter()
        for e in evs:
            for fld in e.get("empty_fields") or []:
                empties[fld] += 1
        if empties:
            top = ", ".join(f"{fld}×{cnt}" for fld, cnt in empties.most_common(5))
            lines.append(f"        ↳ empty critical fields: {top}")

        # Error sampling.
        errors = [e.get("error") for e in evs if e.get("error")]
        if errors:
            lines.append(f"        ↳ errors: {len(errors)} (e.g. {errors[0][:80]})")

    return "\n".join(lines)


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else _default_path()
    if not os.path.exists(path):
        print(f"No metrics file at {path}", file=sys.stderr)
        return 1
    events = load_events(path)
    print(report(events))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
