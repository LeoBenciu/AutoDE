"""
Batch-scan segmentation (pre-phase-0): detect logical document boundaries in a
multi-page PDF so one scanned stack ("teanc") fans out into N separate
documents, each then running the normal Phase 0/1 pipeline.

One cheap vision call: low-DPI page thumbnails (batch scans are usually
image-only PDFs, so text alone can't see boundaries) plus a per-page PyPDF2
snippet when a text layer exists. The model groups consecutive pages into
segments; deterministic validation requires the segments to cover all pages
contiguously without overlap, else we fall back to a single segment.

Fail-open by design: segment_document never raises and always exits as a
valid result — every failure mode collapses to "single document", which the
Node caller treats as "process exactly as today". Deliberately NOT wired into
process_single_document; Node invokes it as a separate `segment` CLI mode
(see main.py) before dispatching Phase 0.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Dict, List, Optional

try:
    from .direct_extraction import (
        _call_structured,
        _format_prompt,
        _load_tasks_config,
        _pdf_page_count,
    )
    from .doc_hash import sha256_file
    from .model_config import get_segmentation_llm_model, get_segmentation_max_tokens
    from .schemas import SegmentationResult
except ImportError:  # script run with this dir on sys.path
    from direct_extraction import (  # type: ignore[no-redef]
        _call_structured,
        _format_prompt,
        _load_tasks_config,
        _pdf_page_count,
    )
    from doc_hash import sha256_file  # type: ignore[no-redef]
    from model_config import (  # type: ignore[no-redef]
        get_segmentation_llm_model,
        get_segmentation_max_tokens,
    )
    from schemas import SegmentationResult  # type: ignore[no-redef]


# ---------------------------------------------------------------------------
# Knobs (code defaults; env-overridable without a deploy)
# ---------------------------------------------------------------------------

def _seg_dpi() -> int:
    return int(os.getenv("FINOVA_SEGMENT_DPI", "100"))


def _seg_max_dim() -> int:
    return int(os.getenv("FINOVA_SEGMENT_MAX_DIM", "800"))


def _seg_max_pages() -> int:
    """Above this page count we don't attempt to split — documents that long
    are almost always one bank statement, and thumbnail cost grows linearly."""
    return int(os.getenv("FINOVA_SEGMENT_MAX_PAGES", "40"))


def _seg_snippet_chars() -> int:
    return int(os.getenv("FINOVA_SEGMENT_TEXT_SNIPPET_CHARS", "400"))


def _seg_min_confidence() -> float:
    """A segment whose is-a-separate-document confidence is below this merges
    into its neighbor: over-merge is the designed failure mode, mis-split is
    the one that corrupts bookkeeping."""
    return float(os.getenv("FINOVA_SEGMENT_MIN_CONFIDENCE", "0.7"))


_CHILD_DIR_ROOT = "/tmp/finova-segments"


# ---------------------------------------------------------------------------
# Result shapes
# ---------------------------------------------------------------------------

def _single_segment_result(
    total_pages: int, fallback_reason: Optional[str], meta: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    return {
        "data": {
            "total_pages": total_pages,
            "single_document": True,
            "fallback_reason": fallback_reason,
            "segments": [{
                "start_page": 1,
                "end_page": max(1, total_pages),
                "doc_type_hint": "Unknown",
                "confidence": 1.0,
                "file_path": None,
            }],
        },
        "meta": meta or {},
    }


# ---------------------------------------------------------------------------
# Page inputs: thumbnails + cheap per-page text
# ---------------------------------------------------------------------------

def _render_page_thumbnails(doc_path: str, total_pages: int) -> List[str]:
    """All pages as low-DPI base64 PNG thumbnails (segmentation-specific knobs;
    _render_doc_images targets extraction: higher DPI, page caps per doc type).
    Returns [] on any failure — caller falls back to single segment; a partial
    render also returns [] because we can't place boundaries on unseen pages."""
    import base64
    import io

    try:
        from .image_orient import auto_orient
    except ImportError:
        try:
            from image_orient import auto_orient  # type: ignore
        except ImportError:
            auto_orient = lambda im: im  # noqa: E731  (orientation optional)
    try:
        from PIL import ImageOps
        from pdf2image import convert_from_path
    except ImportError as e:
        print(f"⚠️  segmentation: render deps unavailable: {e}", file=sys.stderr)
        return []

    max_dim = _seg_max_dim()
    try:
        pil_images = convert_from_path(
            doc_path, dpi=_seg_dpi(), first_page=1, last_page=total_pages
        )
    except Exception as e:
        print(f"⚠️  segmentation: render failed for {os.path.basename(doc_path)}: {e}",
              file=sys.stderr)
        return []
    if len(pil_images) != total_pages:
        print(f"⚠️  segmentation: rendered {len(pil_images)}/{total_pages} pages, "
              "falling back", file=sys.stderr)
        return []

    out: List[str] = []
    for img in pil_images:
        try:
            img = ImageOps.exif_transpose(img) or img
            img = auto_orient(img)
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            w, h = img.size
            scale = min(1.0, max_dim / float(max(w, h)))
            if scale < 1.0:
                img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))))
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            out.append(base64.b64encode(buf.getvalue()).decode("ascii"))
        except Exception as e:
            print(f"⚠️  segmentation: page encode failed: {e}", file=sys.stderr)
            return []
    return out


def _cheap_page_texts(doc_path: str, total_pages: int) -> List[str]:
    """Per-page text snippets via PyPDF2 ONLY — never Textract. The dominant
    batch-scan case is an image-only PDF where PyPDF2 yields nothing, and
    running per-page OCR just to find boundaries would cost more than the
    split saves; the thumbnails carry the signal then. (This is also why
    _read_cached_document_text is unsuitable here: its too-small-cache
    fallback escalates to a full Textract run.)"""
    limit = _seg_snippet_chars()
    try:
        import PyPDF2
        with open(doc_path, "rb") as f:
            reader = PyPDF2.PdfReader(f)
            if reader.is_encrypted:
                try:
                    reader.decrypt("")
                except Exception:
                    return [""] * total_pages
            texts = []
            for page in reader.pages[:total_pages]:
                try:
                    texts.append((page.extract_text() or "").strip()[:limit])
                except Exception:
                    texts.append("")
        texts += [""] * (total_pages - len(texts))
        return texts
    except Exception as e:
        print(f"⚠️  segmentation: PyPDF2 page texts failed: {e}", file=sys.stderr)
        return [""] * total_pages


def _build_segmentation_messages(
    prompt: str, images_b64: List[str], page_texts: List[str], basename: str
) -> List[Dict[str, Any]]:
    """One user message interleaving explicit page labels, thumbnail, and text
    snippet per page, so the model can address pages by index. detail:low —
    boundary detection needs layout/letterhead, not legible line items."""
    total = len(images_b64)
    content: List[Dict[str, Any]] = [{
        "type": "text",
        "text": f"=== SCANNED FILE ({basename}) — {total} pages below, in order ===",
    }]
    for i, b64 in enumerate(images_b64, 1):
        content.append({"type": "text", "text": f"=== PAGE {i} of {total} ==="})
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/png;base64,{b64}", "detail": "low"},
        })
        snippet = page_texts[i - 1] if i - 1 < len(page_texts) else ""
        if snippet:
            content.append({"type": "text", "text": f"Text on page {i}:\n{snippet}"})
    return [
        {"role": "system", "content": prompt.strip()},
        {"role": "user", "content": content},
    ]


# ---------------------------------------------------------------------------
# Deterministic validation + conservative merge
# ---------------------------------------------------------------------------

def _validate_segments(
    segments: List[Dict[str, Any]], total_pages: int
) -> Optional[List[Dict[str, Any]]]:
    """Segments must partition [1, total_pages]: sorted, contiguous,
    non-overlapping, full coverage. Any violation returns None — the caller
    falls back to a single segment rather than "repairing" a broken partition
    by guessing where the model meant the boundary to be."""
    if not segments:
        return None
    segs = sorted(segments, key=lambda s: s["start_page"])
    prev_end = 0
    for s in segs:
        start, end = s["start_page"], s["end_page"]
        if not (isinstance(start, int) and isinstance(end, int)):
            return None
        if start != prev_end + 1 or end < start:
            return None
        prev_end = end
    if prev_end != total_pages:
        return None
    return segs


def _merge_low_confidence(
    segments: List[Dict[str, Any]], min_confidence: float
) -> List[Dict[str, Any]]:
    """Merge any segment the model wasn't sure is a SEPARATE document into its
    predecessor (a low-confidence first segment merges forward instead). Input
    must already be a validated partition; output stays one by construction.

    The surviving segment keeps ITS OWN confidence: a segment's score is about
    its start boundary, which absorbing pages at its end doesn't weaken —
    propagating min() instead made one doubtful boundary cascade into merging
    every following (and even preceding) segment."""
    merged: List[Dict[str, Any]] = []
    for seg in segments:
        if merged and seg["confidence"] < min_confidence:
            merged[-1] = {**merged[-1], "end_page": seg["end_page"]}
        else:
            merged.append(dict(seg))
    # First segment low-confidence: it can only merge forward.
    if len(merged) > 1 and merged[0]["confidence"] < min_confidence:
        merged[1] = {**merged[1], "start_page": merged[0]["start_page"]}
        merged = merged[1:]
    return merged


# ---------------------------------------------------------------------------
# Physical split
# ---------------------------------------------------------------------------

def _write_child_pdfs(doc_path: str, segments: List[Dict[str, Any]]) -> None:
    """Write one PDF per segment and set file_path on each. Output paths are
    deterministic (content hash + page range) and overwritten on retry, so a
    crashed fan-out that re-runs converges on the same files."""
    import PyPDF2

    out_dir = os.path.join(_CHILD_DIR_ROOT, sha256_file(doc_path) or "nohash")
    os.makedirs(out_dir, exist_ok=True)
    with open(doc_path, "rb") as f:
        reader = PyPDF2.PdfReader(f)
        if reader.is_encrypted:
            reader.decrypt("")
        for i, seg in enumerate(segments, 1):
            writer = PyPDF2.PdfWriter()
            for page_idx in range(seg["start_page"] - 1, seg["end_page"]):
                writer.add_page(reader.pages[page_idx])
            child_path = os.path.join(
                out_dir, f"seg_{i}_p{seg['start_page']}-{seg['end_page']}.pdf"
            )
            with open(child_path, "wb") as out:
                writer.write(out)
            seg["file_path"] = child_path


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

def segment_document(
    doc_path: str, forced: Optional[List[Dict[str, Any]]] = None
) -> Dict[str, Any]:
    """Detect logical document boundaries in a (possibly batch-scanned) PDF.

    Never raises; every failure mode returns a single-segment result with a
    fallback_reason so the caller processes the file exactly as today.

    ``forced`` replays a previously decided partition (list of
    {start_page, end_page, ...}) without calling the model: a crashed fan-out
    that already created some children must converge on the SAME boundaries on
    retry, and a fresh LLM call could draw different ones.
    """
    try:
        return _segment_document_inner(doc_path, forced)
    except Exception as e:
        print(f"⚠️  segmentation failed, falling back to single document: "
              f"{type(e).__name__}: {e}", file=sys.stderr)
        return _single_segment_result(
            _pdf_page_count(doc_path), f"error:{type(e).__name__}")


def _segment_document_inner(
    doc_path: str, forced: Optional[List[Dict[str, Any]]] = None
) -> Dict[str, Any]:
    if not str(doc_path).lower().endswith(".pdf"):
        return _single_segment_result(1, "not_pdf")

    total_pages = _pdf_page_count(doc_path)
    if total_pages < 2:
        return _single_segment_result(total_pages, "too_few_pages")

    if forced:
        segments = _validate_segments(
            [{"doc_type_hint": "Unknown", "confidence": 1.0, **s} for s in forced],
            total_pages)
        if segments is None or len(segments) < 2:
            return _single_segment_result(total_pages, "invalid_forced_segments")
        _write_child_pdfs(doc_path, segments)
        print(f"✂️  segmentation: replayed forced partition → {len(segments)} documents",
              file=sys.stderr)
        return {
            "data": {
                "total_pages": total_pages,
                "single_document": False,
                "fallback_reason": None,
                "segments": segments,
            },
            "meta": {"forced": True},
        }

    if total_pages > _seg_max_pages():
        return _single_segment_result(total_pages, "page_cap")

    images = _render_page_thumbnails(doc_path, total_pages)
    if not images:
        return _single_segment_result(total_pages, "render_failed")
    page_texts = _cheap_page_texts(doc_path, total_pages)

    template = _load_tasks_config()["segment_batch_task"]["description"]
    prompt = _format_prompt(template, {"total_pages": total_pages})
    messages = _build_segmentation_messages(
        prompt, images, page_texts, os.path.basename(doc_path))

    parsed, meta = _call_structured(
        messages=messages,
        schema_cls=SegmentationResult,
        schema_name="segmentation_result",
        max_tokens=get_segmentation_max_tokens(),
        label="segmentation",
        cache_key="finova-segment",
        model=get_segmentation_llm_model(),
    )

    segments = _validate_segments(parsed.get("segments") or [], total_pages)
    if segments is None:
        print(f"⚠️  segmentation: invalid partition from model "
              f"({parsed.get('segments')}), falling back", file=sys.stderr)
        return _single_segment_result(total_pages, "invalid_segments", meta)

    segments = _merge_low_confidence(segments, _seg_min_confidence())
    if _validate_segments(segments, total_pages) is None:  # invariant guard
        return _single_segment_result(total_pages, "merge_broke_partition", meta)

    if len(segments) < 2:
        # A legitimate "this is one document" verdict, not a failure.
        return _single_segment_result(total_pages, None, meta)

    for seg in segments:
        seg.setdefault("file_path", None)
    _write_child_pdfs(doc_path, segments)
    print(f"✂️  segmentation: {os.path.basename(doc_path)} → {len(segments)} documents "
          f"({[(s['start_page'], s['end_page']) for s in segments]})", file=sys.stderr)
    return {
        "data": {
            "total_pages": total_pages,
            "single_document": False,
            "fallback_reason": None,
            "segments": segments,
        },
        "meta": meta,
    }
