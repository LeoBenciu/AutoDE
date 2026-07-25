"""Render an AWS Textract ``AnalyzeDocument`` response to model-friendly text.

``DetectDocumentText`` only returns LINE blocks, so multi-column tables (invoice
line items!) get linearized and the model has to guess which number belongs to
which column. ``AnalyzeDocument`` with ``FeatureTypes=['TABLES','FORMS']`` also
returns the table cell grid and key/value pairs. This module flattens that block
graph into:

    <reading-order LINE text>

    --- TABLES ---
    | col | col | col |
    | ... | ... | ... |

    --- FORM FIELDS ---
    key: value

Pure function (no boto3 / network) so the block-graph traversal is unit-tested
against a synthetic response. The caller (aws_textract_tool) handles the API
call and per-page image rendering.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List

# Opt-in debug trace (FINOVA_DEBUG_TRACE=1); a no-op singleton when disabled.
try:
    from .debug_trace import TRACE, glued_numbers_score
except ImportError:
    from debug_trace import TRACE, glued_numbers_score  # type: ignore


def _children(block: Dict[str, Any], bmap: Dict[str, Any]) -> Iterable[Dict[str, Any]]:
    for rel in block.get("Relationships") or []:
        if rel.get("Type") == "CHILD":
            for cid in rel.get("Ids", []):
                child = bmap.get(cid)
                if child is not None:
                    yield child


def _text_of(block: Dict[str, Any], bmap: Dict[str, Any]) -> str:
    """Concatenate the WORD / SELECTION_ELEMENT text under a block."""
    parts: List[str] = []
    for child in _children(block, bmap):
        bt = child.get("BlockType")
        if bt == "WORD":
            t = child.get("Text", "")
            if t:
                parts.append(t)
        elif bt == "SELECTION_ELEMENT":
            parts.append("[X]" if child.get("SelectionStatus") == "SELECTED" else "[ ]")
    return " ".join(parts)


def _render_table(table: Dict[str, Any], bmap: Dict[str, Any]) -> str:
    cells = [c for c in _children(table, bmap) if c.get("BlockType") == "CELL"]
    if not cells:
        return ""
    max_r = max((c.get("RowIndex", 1) for c in cells), default=0)
    max_c = max((c.get("ColumnIndex", 1) for c in cells), default=0)
    if max_r == 0 or max_c == 0:
        return ""
    grid = [["" for _ in range(max_c)] for _ in range(max_r)]
    for c in cells:
        r = c.get("RowIndex", 1) - 1
        col = c.get("ColumnIndex", 1) - 1
        if 0 <= r < max_r and 0 <= col < max_c:
            grid[r][col] = _text_of(c, bmap).strip()
    return "\n".join("| " + " | ".join(row) + " |" for row in grid)


def parse_analyze_response(response: Dict[str, Any]) -> str:
    """Flatten a Textract AnalyzeDocument response to text + tables + forms."""
    blocks = response.get("Blocks") or []
    bmap = {b["Id"]: b for b in blocks if "Id" in b}

    sections: List[str] = []

    # 1. Reading-order line text (Textract returns LINE blocks in reading order).
    line_text = "\n".join(
        b.get("Text", "") for b in blocks
        if b.get("BlockType") == "LINE" and b.get("Text")
    )
    if line_text.strip():
        sections.append(line_text)

    # 2. Tables as pipe grids.
    tables = []
    for b in blocks:
        if b.get("BlockType") == "TABLE":
            rendered = _render_table(b, bmap)
            if rendered.strip():
                tables.append(rendered)
    if tables:
        sections.append("--- TABLES ---\n" + "\n\n".join(tables))

    # 3. Form key/value pairs.
    forms = []
    for b in blocks:
        if b.get("BlockType") == "KEY_VALUE_SET" and "KEY" in (b.get("EntityTypes") or []):
            key = _text_of(b, bmap).strip()
            if not key:
                continue
            value = ""
            for rel in b.get("Relationships") or []:
                if rel.get("Type") == "VALUE":
                    for vid in rel.get("Ids", []):
                        vb = bmap.get(vid)
                        if vb is not None:
                            value = _text_of(vb, bmap).strip()
            forms.append(f"{key}: {value}")
    if forms:
        sections.append("--- FORM FIELDS ---\n" + "\n".join(forms))

    result = "\n\n".join(sections)

    if TRACE.enabled:
        try:
            TRACE.stage(
                "ocr_analyze",
                char_count=len(result or ""),
                has_tables=("--- TABLES ---" in result),
                has_forms=("--- FORM FIELDS ---" in result),
                glued_numbers=glued_numbers_score(result),
                sample=TRACE.sample(result),
            )
        except Exception:
            pass

    return result
