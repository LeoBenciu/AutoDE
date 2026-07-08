"""Multi-source OCR with guards.

Source priority:
  1. Embedded PDF text layer (pypdf) — used when rich enough, judged with a
     page-aware character floor so scanned pages don't slip through.
  2. AWS Textract (optional, needs boto3 + AWS creds) — guarded by a ratio
     check so a worse OCR source never overwrites a better text layer.
  3. None — caller falls back to LLM vision on the original file.

Memory rule: never render all PDF pages into RAM at once; anything that
rasterizes pages must stream them to disk one at a time.
"""
import io
import os
from dataclasses import dataclass
from typing import Optional

TEXT_LAYER_MIN_CHARS_PER_PAGE = int(os.environ.get("OCR_TEXT_LAYER_MIN_CHARS_PER_PAGE", "200"))
TEXTRACT_MIN_RATIO = float(os.environ.get("OCR_TEXTRACT_MIN_RATIO", "0.5"))
TEXTRACT_MAX_PAGES = int(os.environ.get("OCR_TEXTRACT_MAX_PAGES", "15"))


@dataclass
class OcrResult:
    text: Optional[str]
    source: str  # "text-layer" | "textract" | "none"
    page_count: int
    scanned_page_ratio: float


def extract_text(path: str, content_type: str) -> OcrResult:
    if content_type == "application/pdf" or path.lower().endswith(".pdf"):
        return _extract_pdf(path)
    # Images and other binaries: no text source, use LLM vision.
    return OcrResult(text=None, source="none", page_count=1, scanned_page_ratio=1.0)


def _extract_pdf(path: str) -> OcrResult:
    text_layer, page_count, scanned_ratio = _pdf_text_layer(path)

    layer_ok = text_layer is not None and scanned_ratio < 0.5
    if layer_ok:
        candidate = text_layer
        source = "text-layer"
    else:
        candidate, source = None, "none"

    textract_text = _try_textract(path)
    if textract_text:
        # Ratio guard: never let a worse OCR source overwrite a better one.
        # (Real bug this fixes: Textract returned ~72 chars/page on some
        # layouts and would have destroyed a 16k-char text layer.)
        if candidate and len(textract_text) < TEXTRACT_MIN_RATIO * len(candidate):
            pass  # keep the text layer
        else:
            candidate, source = textract_text, "textract"

    return OcrResult(text=candidate, source=source, page_count=page_count, scanned_page_ratio=scanned_ratio)


def _pdf_text_layer(path: str):
    try:
        from pypdf import PdfReader
    except ImportError:
        return None, 1, 1.0

    try:
        reader = PdfReader(path)
        pages = reader.pages
        page_count = len(pages)
        texts = []
        scanned_pages = 0
        for page in pages:
            page_text = (page.extract_text() or "").strip()
            # Page-aware character floor: a page below the floor counts as scanned.
            if len(page_text) < TEXT_LAYER_MIN_CHARS_PER_PAGE:
                scanned_pages += 1
            texts.append(page_text)
        combined = "\n\n".join(t for t in texts if t)
        ratio = scanned_pages / page_count if page_count else 1.0
        return (combined if combined else None), page_count, ratio
    except Exception:
        return None, 1, 1.0


def _try_textract(path: str) -> Optional[str]:
    """AWS Textract, if boto3 + credentials are available. Fails soft."""
    if not (os.environ.get("AWS_ACCESS_KEY_ID") and os.environ.get("AWS_SECRET_ACCESS_KEY")):
        return None
    try:
        import boto3  # type: ignore
    except ImportError:
        return None
    try:
        client = boto3.client("textract", region_name=os.environ.get("AWS_REGION", "eu-central-1"))
        with open(path, "rb") as fh:
            data = fh.read()
        # Synchronous API: single-page images / small PDFs only. Long documents
        # need the async StartDocumentTextDetection flow with page chunking.
        response = client.detect_document_text(Document={"Bytes": data})
        lines = [b["Text"] for b in response.get("Blocks", []) if b.get("BlockType") == "LINE"]
        return "\n".join(lines) if lines else None
    except Exception:
        return None
