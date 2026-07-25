"""Render an AWS Textract ``AnalyzeExpense`` response to model-friendly text.

``AnalyzeExpense`` is Textract's purpose-built API for invoices and receipts. On
top of the raw OCR it returns two things the generic ``DetectDocumentText`` /
``AnalyzeDocument`` paths don't give you for free:

  * ``SummaryFields`` — normalized header fields (VENDOR_NAME, TOTAL, TAX,
    INVOICE_RECEIPT_DATE, ...), each a typed key + detected value;
  * ``LineItemGroups`` — line items already segmented into rows and columns
    (ITEM, QUANTITY, UNIT_PRICE, PRICE, ...) — exactly the structure the model
    otherwise has to reconstruct from linearized OCR, which is where line-item
    F1 bleeds.

This module flattens that into:

    <reading-order LINE text>

    --- EXPENSE SUMMARY FIELDS ---
    VENDOR_NAME: ACME SRL
    TOTAL: 119.00

    --- LINE ITEMS ---
    | ITEM | QUANTITY | UNIT_PRICE | PRICE |
    | Widget | 2 | 50.00 | 100.00 |

The raw LINE text is always emitted first, so the mode degrades gracefully on
documents AnalyzeExpense isn't built for (e.g. bank statements still get their
plain OCR lines).

Pure function (no boto3 / network) so the traversal is unit-tested against a
synthetic response. The caller (aws_textract_tool) handles the API call and
per-page image rendering. Mirrors textract_analyze.parse_analyze_response.
"""

from __future__ import annotations

from typing import Any, Dict, List

# Opt-in debug trace (FINOVA_DEBUG_TRACE=1); a no-op singleton when disabled.
try:
    from .debug_trace import TRACE, glued_numbers_score
except ImportError:
    from debug_trace import TRACE, glued_numbers_score  # type: ignore

# Preferred column order for line-item grids; any other field types Textract
# returns are appended after these in first-seen order. EXPENSE_ROW (the whole
# concatenated row) is dropped — it's already present in the raw LINE text.
_LINE_ITEM_COLUMN_ORDER = ["ITEM", "PRODUCT_CODE", "QUANTITY", "UNIT_PRICE", "PRICE"]


def _detection_text(detection: Any) -> str:
    """Text of an AnalyzeExpense {Type,LabelDetection,ValueDetection} sub-object."""
    if isinstance(detection, dict):
        return (detection.get("Text") or "").strip()
    return ""


def _summary_key(field: Dict[str, Any]) -> str:
    """Key for a summary field: its normalized Type, falling back to the printed
    label when Textract couldn't classify it (Type == OTHER / blank)."""
    type_text = _detection_text(field.get("Type"))
    if type_text and type_text.upper() != "OTHER":
        return type_text
    return _detection_text(field.get("LabelDetection")) or type_text or "OTHER"


def _render_summary(fields: List[Dict[str, Any]]) -> str:
    lines: List[str] = []
    for f in fields:
        value = _detection_text(f.get("ValueDetection"))
        if not value:
            continue
        lines.append(f"{_summary_key(f)}: {value}")
    return "\n".join(lines)


def _line_item_cells(item: Dict[str, Any]) -> Dict[str, str]:
    cells: Dict[str, str] = {}
    for f in item.get("LineItemExpenseFields") or []:
        key = _detection_text(f.get("Type")) or "OTHER"
        value = _detection_text(f.get("ValueDetection"))
        if value:
            cells[key] = value
    cells.pop("EXPENSE_ROW", None)  # whole-row text, redundant with raw LINE text
    return cells


def _render_line_items(groups: List[Dict[str, Any]]) -> str:
    rows: List[Dict[str, str]] = []
    for group in groups:
        for item in group.get("LineItems") or []:
            cells = _line_item_cells(item)
            if cells:
                rows.append(cells)
    if not rows:
        return ""

    # Columns = preferred order first (only those present), then any extras.
    columns: List[str] = [c for c in _LINE_ITEM_COLUMN_ORDER if any(c in r for r in rows)]
    for r in rows:
        for k in r:
            if k not in columns:
                columns.append(k)

    grid = ["| " + " | ".join(columns) + " |"]
    for r in rows:
        grid.append("| " + " | ".join(r.get(c, "") for c in columns) + " |")
    return "\n".join(grid)


def parse_expense_response(response: Dict[str, Any]) -> str:
    """Flatten a Textract AnalyzeExpense response to text + summary + line items."""
    docs = response.get("ExpenseDocuments") or []
    multi = len(docs) > 1

    sections: List[str] = []
    for idx, doc in enumerate(docs, 1):
        parts: List[str] = []

        # 1. Reading-order line text (raw OCR; also covers non-expense content
        # so the mode degrades gracefully on documents it wasn't built for).
        line_text = "\n".join(
            b.get("Text", "")
            for b in (doc.get("Blocks") or [])
            if b.get("BlockType") == "LINE" and b.get("Text")
        )
        if line_text.strip():
            parts.append(line_text)

        # 2. Normalized header fields.
        summary = _render_summary(doc.get("SummaryFields") or [])
        if summary:
            parts.append("--- EXPENSE SUMMARY FIELDS ---\n" + summary)

        # 3. Pre-segmented line items as a pipe grid.
        line_items = _render_line_items(doc.get("LineItemGroups") or [])
        if line_items:
            parts.append("--- LINE ITEMS ---\n" + line_items)

        if not parts:
            continue
        block = "\n\n".join(parts)
        # A single receipt/invoice is the norm; only label when a page held more
        # than one expense document (e.g. two receipts scanned together).
        if multi:
            block = f"=== EXPENSE DOCUMENT {idx} ===\n{block}"
        sections.append(block)

    result = "\n\n".join(sections)

    if TRACE.enabled:
        try:
            TRACE.stage(
                "ocr_expense",
                char_count=len(result or ""),
                has_summary=("--- EXPENSE SUMMARY FIELDS ---" in result),
                has_line_items=("--- LINE ITEMS ---" in result),
                glued_numbers=glued_numbers_score(result),
                sample=TRACE.sample(result),
            )
        except Exception:
            pass

    return result
