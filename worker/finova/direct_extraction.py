"""
Direct OpenAI extraction — replaces CrewAI for single-agent document calls.

Phase 0 (categorize_document) and Phase 1 (extract_document) each run as one
chat-completion with response_format=json_schema (strict=True). No CrewAI
framework prompts, no tool-use loop, no regex JSON parsing.

The account-attribution flow stays on CrewAI for now since it's a candidate
for a real multi-agent crew (see task 17 in the project task list).
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from typing import Any, Dict, Optional, Type

import yaml
from openai import OpenAI
from pydantic import BaseModel, ValidationError

# Support both `from first_crew_finova.direct_extraction import ...` (package)
# and `import direct_extraction` (script run with this dir on sys.path).
try:
    from .model_config import (
        get_extraction_llm_model,
        get_extraction_max_tokens,
        get_categorization_max_tokens,
    )
    from .schemas import (
        CategorizationResult,
        StrictBase,
        schema_for,
        BankTransactionsChunk,
    )
except ImportError:
    from model_config import (  # type: ignore[no-redef]
        get_extraction_llm_model,
        get_extraction_max_tokens,
        get_categorization_max_tokens,
    )
    from schemas import (  # type: ignore[no-redef]
        CategorizationResult,
        StrictBase,
        schema_for,
        BankTransactionsChunk,
    )

# Opt-in debug trace (FINOVA_DEBUG_TRACE=1); a no-op singleton when disabled.
try:
    from .debug_trace import TRACE, txn_summary, glued_numbers_score
except ImportError:  # script run
    from debug_trace import TRACE, txn_summary, glued_numbers_score  # type: ignore


class TruncatedExtraction(RuntimeError):
    """The model hit max_tokens mid-JSON (finish_reason == "length"), so the
    structured output is incomplete and unparseable.

    Distinct from a transient failure: retrying the identical call just truncates
    again at the same row, so the caller recovers via the page-chunked path
    instead of blindly re-running the expensive call (the 3× retry of an ~80s
    call is what blows the Node-side timeout and surfaces to the user as a
    "processed but empty" document).

    Carries ``partial`` — the raw (incomplete) JSON string the model DID emit
    before it was cut off. The header scalars (company_name/ein, bank, account,
    period, opening/closing balance) are serialized BEFORE the transactions array,
    so they're almost always complete in the partial and worth salvaging rather
    than discarding (the UniCredit 306-row case loses its whole header otherwise)."""

    def __init__(self, message: str, partial: str = "") -> None:
        super().__init__(message)
        self.partial = partial or ""


# ---------------------------------------------------------------------------
# Tasks YAML — load once, format per call
# ---------------------------------------------------------------------------

_TASKS_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "config",
    "tasks.yaml",
)

_tasks_cache: Optional[Dict[str, Any]] = None


def _load_tasks_config() -> Dict[str, Any]:
    global _tasks_cache
    if _tasks_cache is None:
        with open(_TASKS_PATH, "r", encoding="utf-8") as f:
            _tasks_cache = yaml.safe_load(f)
    return _tasks_cache


# ---------------------------------------------------------------------------
# Prompt assembly
# ---------------------------------------------------------------------------

# Matches simple {identifier} placeholders only. Crucially this does NOT match
# the literal JSON examples embedded in the task YAML (e.g. {'document_type':
# 'Invoice'}) because those contain quotes/colons — so str.format-style parsing
# of literal braces is avoided entirely.
_PLACEHOLDER_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")


def _stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (str, int, float, bool)):
        return str(value)
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(value)


def _format_prompt(template: str, inputs: Dict[str, Any]) -> str:
    """Fill {placeholder} markers in a YAML task description.

    Only substitutes placeholders whose name is a known key in `inputs` (plus
    the shared prompt fragments). Unknown placeholders and any literal braces
    (JSON examples in the prompt) are left exactly as written. Non-scalar values
    are serialized as JSON so the model sees structured context rather than
    ``str(dict)`` output.
    """
    # Shared boilerplate fragments (task 9) resolve like any other input.
    try:
        from .prompt_fragments import inject_fragments
    except ImportError:
        from prompt_fragments import inject_fragments
    inputs = inject_fragments(dict(inputs))

    def _replace(match: "re.Match[str]") -> str:
        key = match.group(1)
        if key in inputs:
            return _stringify(inputs[key])
        return match.group(0)  # leave unknown placeholder untouched

    return _PLACEHOLDER_RE.sub(_replace, template)


def _build_messages(
    prompt: str,
    document_text: str,
    document_basename: str,
) -> list[Dict[str, str]]:
    """Compose chat messages with stable prefix ordering for prompt caching.

    System prompt (large, mostly static rules) comes first so OpenAI's
    automatic prompt caching can reuse the prefix across documents.
    """
    return [
        {
            "role": "system",
            "content": prompt.strip(),
        },
        {
            "role": "user",
            "content": (
                f"=== DOCUMENT ({document_basename}) ===\n"
                f"{document_text}"
            ),
        },
    ]


# ---------------------------------------------------------------------------
# Vision extraction (task 4)
#
# Feed the page image to a multimodal model so it can read what OCR drops —
# receipt dates, layout, stamps, the aviz checkbox. The OCR text is still
# included as a second signal (clean machine-read tables from AnalyzeDocument),
# so the model gets both "see it" and "machine-read it".
# ---------------------------------------------------------------------------

def _vision_enabled() -> bool:
    """Always use the page image for extraction. Default ON (champion config);
    set FINOVA_VISION_EXTRACTION=false to A/B the text-only pass."""
    return os.getenv("FINOVA_VISION_EXTRACTION", "true").lower() == "true"


def _escalation_enabled() -> bool:
    """Run the cheap text pass first, escalate to vision only when it leaves a
    critical field empty — confidence-gated, cost-aware."""
    return os.getenv("FINOVA_VISION_ESCALATION", "false").lower() == "true"


def _repair_enabled() -> bool:
    """Validator-guided repair pass: after extraction, run the deterministic
    validators (validators.validate_extraction) and, if any check fails, re-ask
    the model with the specific arithmetic/checksum discrepancies to fix. Fires
    only on documents that fail a check; kept only if it reduces failures. Off by
    default — A/B with the eval harness (FINOVA_REPAIR_PASS)."""
    return os.getenv("FINOVA_REPAIR_PASS", "false").lower() == "true"


# Checksum/format checks are deterministic identity/format validations — the RO
# CUI control digit, IBAN mod-97, and date format. A failure means a single
# misread the model can correct in isolation, without touching anything else.
# The Σ-reconciliation checks (line-item VAT math, total = Σlines, invoice
# vat = Σline vat, bank balance continuity) are NOT in this set: feeding those
# discrepancies back asks the model to make the arithmetic close, which it did
# by inventing/merging line items — the corruption behind the naive repair's
# −2.9% A/B. The scoped repair keeps the vendor_ein/checksum slice and drops
# the reconciliation checks.
_SCOPED_REPAIR_RULES = frozenset({
    "RO CUI checksum",
    "IBAN mod-97",
    "DD-MM-YYYY, not future",
})


def _repair_scoped_enabled() -> bool:
    """Restrict the repair pass to checksum/format checks only (CUI / IBAN /
    date), excluding the Σ-reconciliation checks that corrupted line items.
    Default ON (champion config) — FINOVA_REPAIR_SCOPED=false to A/B."""
    return os.getenv("FINOVA_REPAIR_SCOPED", "true").lower() == "true"


def _scoped_failed(failed: list) -> list:
    """The subset of failed checks the scoped repair acts on (checksum/format)."""
    return [c for c in failed if c.get("rule") in _SCOPED_REPAIR_RULES]


def _bank_chunking_enabled() -> bool:
    """Extract bank-statement transactions a page (-group) at a time and merge,
    instead of one call that truncates long statements. Default ON (champion
    config) — FINOVA_BANK_CHUNKING=false to A/B."""
    return os.getenv("FINOVA_BANK_CHUNKING", "true").lower() == "true"


_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".tiff", ".bmp", ".webp")


def _render_doc_images(doc_path: str, doc_type: Optional[str] = None) -> list[str]:
    """Render a document's pages to base64 PNGs for a vision model.

    Caps page count (FINOVA_VISION_MAX_PAGES; a higher
    FINOVA_VISION_MAX_PAGES_BANK for multi-page bank statements so a 9-page
    statement isn't truncated to 4) and longest-side pixels
    (FINOVA_VISION_MAX_DIM) to bound token cost. Each page is auto-oriented
    upright (scanned statements arrive rotated). Returns [] on any failure so
    the caller transparently falls back to text-only.
    """
    import base64
    import io

    if doc_type == "Bank Statement":
        max_pages = int(os.getenv("FINOVA_VISION_MAX_PAGES_BANK", "12"))
    else:
        max_pages = int(os.getenv("FINOVA_VISION_MAX_PAGES", "4"))
    max_dim = int(os.getenv("FINOVA_VISION_MAX_DIM", "1600"))
    try:
        from .image_orient import auto_orient
    except ImportError:
        try:
            from image_orient import auto_orient  # type: ignore
        except ImportError:
            auto_orient = lambda im: im  # noqa: E731  (orientation optional)
    try:
        from PIL import Image, ImageOps
    except ImportError:
        print("⚠️  vision: Pillow not available, falling back to text", file=sys.stderr)
        return []

    low = doc_path.lower()
    try:
        if low.endswith(".pdf"):
            from pdf2image import convert_from_path
            dpi = int(os.getenv("FINOVA_VISION_DPI", "200"))
            pil_images = convert_from_path(doc_path, dpi=dpi, first_page=1, last_page=max_pages)
        elif low.endswith(_IMAGE_EXTS):
            pil_images = [Image.open(doc_path)]
        else:
            return []
    except Exception as e:
        print(f"⚠️  vision render failed for {os.path.basename(doc_path)}: {e}", file=sys.stderr)
        return []

    out: list[str] = []
    for img in pil_images[:max_pages]:
        try:
            # Honor the camera EXIF orientation tag first. Phone photos are stored
            # in the sensor's native orientation with a rotation flag that PIL does
            # NOT apply on open, so the raw pixels are often sideways even though
            # they preview upright — and a sideways receipt reads as garbage to both
            # OCR and the vision model. exif_transpose bakes the rotation into the
            # pixels (no-op for PDF-rendered pages, which carry no EXIF).
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
            print(f"⚠️  vision: page encode failed: {e}", file=sys.stderr)
    if TRACE.enabled:
        try:
            TRACE.stage("vision_render", doc_type=doc_type, dpi=locals().get("dpi"), max_dim=max_dim,
                        pages_rendered=len(out),
                        page_px=[list(im.size) for im in pil_images[:max_pages]],
                        b64_kb=[round(len(b) / 1024, 1) for b in out])
        except Exception:
            pass
    return out


def _build_vision_messages(
    prompt: str, document_text: str, images_b64: list[str], basename: str
) -> list[Dict[str, Any]]:
    """Multimodal messages: the page image(s) the model reads directly, plus the
    OCR text as a secondary signal. System prompt stays first for prompt caching."""
    content: list[Dict[str, Any]] = [
        {"type": "text",
         "text": f"=== DOCUMENT ({basename}) — page image(s) below, OCR text after ==="}
    ]
    for b64 in images_b64:
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/png;base64,{b64}", "detail": "high"},
        })
    content.append({"type": "text", "text": f"=== OCR TEXT ({basename}) ===\n{document_text}"})
    return [
        {"role": "system", "content": prompt.strip()},
        {"role": "user", "content": content},
    ]


# ---------------------------------------------------------------------------
# Schema → OpenAI response_format
# ---------------------------------------------------------------------------

def _coerce_fixed_document_type(parsed: Any, schema_cls: Type[BaseModel]) -> None:
    """If the schema fixes document_type to one literal value, force the parsed
    value to it. Guards against providers that don't enforce single-value enums in
    structured output. No-op when document_type is a multi-value enum (categorizer)."""
    if not isinstance(parsed, dict) or "document_type" not in parsed:
        return
    try:
        dt = schema_cls.model_json_schema().get("properties", {}).get("document_type", {})
        allowed = dt.get("const")
        if allowed is None and isinstance(dt.get("enum"), list) and len(dt["enum"]) == 1:
            allowed = dt["enum"][0]
        if allowed is not None and parsed.get("document_type") != allowed:
            parsed["document_type"] = allowed
    except Exception:
        pass


def _response_format_for(model_cls: Type[BaseModel], name: str) -> Dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": name,
            "strict": True,
            "schema": model_cls.model_json_schema(),
        },
    }


# ---------------------------------------------------------------------------
# OpenAI client (lazy, single instance per process)
# ---------------------------------------------------------------------------

_client: Optional[OpenAI] = None


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI()
    return _client


# Gemini via Google's OpenAI-compatibility endpoint: same chat-completions shape
# (incl. response_format json_schema and image_url vision), so the extraction path
# is reused verbatim with only a different base_url + key. Switch by setting
# FINOVA_EXTRACTION_LLM_MODEL=gemini-3-flash-preview (key: GEMINI_API_KEY or
# GOOGLE_GEMINI_API_KEY).
_gemini_client: Optional[OpenAI] = None
_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"


def _is_gemini_model(model: str) -> bool:
    return (
        model.lower().startswith("gemini")
        or os.getenv("FINOVA_EXTRACTION_PROVIDER", "").lower() == "gemini"
    )


def _get_gemini_client() -> OpenAI:
    global _gemini_client
    if _gemini_client is None:
        key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_GEMINI_API_KEY")
        _gemini_client = OpenAI(base_url=_GEMINI_BASE_URL, api_key=key)
    return _gemini_client


# OpenRouter: one OpenAI-compatible gateway in front of ~all providers. Any model
# given as a "vendor/model" slug (e.g. google/gemini-3-flash-preview,
# qwen/qwen3-vl-235b-a22b-instruct) routes here, so a whole model sweep needs only
# different FINOVA_EXTRACTION_LLM_MODEL strings + one OPENROUTER_API_KEY.
_openrouter_client: Optional[OpenAI] = None
_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


def _is_openrouter_model(model: str) -> bool:
    return "/" in model or os.getenv("FINOVA_EXTRACTION_PROVIDER", "").lower() == "openrouter"


def _get_openrouter_client() -> OpenAI:
    global _openrouter_client
    if _openrouter_client is None:
        _openrouter_client = OpenAI(
            base_url=_OPENROUTER_BASE_URL,
            api_key=os.getenv("OPENROUTER_API_KEY"),
            default_headers={"HTTP-Referer": "https://finova.ro", "X-Title": "Finova Extraction"},
            # Big OpenRouter-routed models (e.g. qwen3-vl-235b) can be slow and drop
            # connections; the SDK's default 2 retries / short timeout aren't enough.
            max_retries=int(os.getenv("FINOVA_OPENROUTER_MAX_RETRIES", "5")),
            timeout=float(os.getenv("FINOVA_OPENROUTER_TIMEOUT", "180")),
        )
    return _openrouter_client


# ---------------------------------------------------------------------------
# Cached document text
# ---------------------------------------------------------------------------

# Below this many characters, a cached text file is considered a failed/empty
# extraction (e.g. PyPDF2 on a scanned PDF) and re-extraction is forced.
_MIN_CACHED_TEXT_CHARS = 50


def _bank_debug_enabled() -> bool:
    """Verbose bank-statement diagnostics straight to stderr (→ Render logs, which
    is the only debug channel we can actually read in prod — the FINOVA_DEBUG_TRACE
    side-files live on ephemeral container disk). ON by default while we stabilize
    bank extraction; set FINOVA_BANK_DEBUG=false to silence."""
    return os.getenv("FINOVA_BANK_DEBUG", "true").strip().lower() not in ("0", "false", "no", "off")


def _bank_dbg(tag: str, **fields: Any) -> None:
    """One bounded, grep-friendly diagnostic line for bank extraction."""
    if not _bank_debug_enabled():
        return
    try:
        parts = " ".join(f"{k}={v!r}" for k, v in fields.items())
        print(f"🏦DBG [{tag}] {parts}"[:3000], file=sys.stderr)
        sys.stderr.flush()
    except Exception:
        pass


def _bank_dbg_block(tag: str, body: str, limit: int = 2200) -> None:
    """Dump a bounded multi-line block (e.g. the OCR header) so we can see the exact
    labels the bank prints (company name / CUI / Sold initial-final) — which is what
    we need to recover them deterministically."""
    if not _bank_debug_enabled() or not body:
        return
    try:
        snippet = body[:limit]
        print(f"🏦DBG-BLOCK [{tag}] ({len(body)} chars, showing {len(snippet)}):\n"
              f"<<<<<<<<<< {tag} >>>>>>>>>>\n{snippet}\n<<<<<<<<<< /{tag} >>>>>>>>>>",
              file=sys.stderr)
        sys.stderr.flush()
    except Exception:
        pass


def _bank_force_textract() -> bool:
    """Force Textract (over PyPDF2) for bank statements — they have dense
    debit/credit/balance columns PyPDF2 mangles. On by default; set
    FINOVA_BANK_FORCE_TEXTRACT=false to fall back to the generic text path
    (e.g. to save Textract cost when boto3/AWS isn't available)."""
    return os.getenv("FINOVA_BANK_FORCE_TEXTRACT", "true").strip().lower() not in ("0", "false", "no", "off")


def _bank_textract_max_pages() -> int:
    """Max pages to OCR per bank statement via Textract (column-preserving — what
    lets the model get debit/credit right; PyPDF2 glues the columns and the model
    then guesses directions AND misreads glued amounts → won't reconcile).

    MUST be paired with the Node-side bank Phase-1 timeout: ~5.5s/page at 300 DPI,
    so a 49-page statement needs ~270s of Textract — the Node timeout for bank
    statements is raised to match (DATA_EXTRACTION_BANK_PYTHON_TIMEOUT_MS). Above
    this cap (a pathological page count the timeout can't cover) the caller keeps
    the complete PyPDF2 text instead of a SIGKILL. Tunable via
    FINOVA_BANK_TEXTRACT_MAX_PAGES."""
    try:
        return max(1, int(os.getenv("FINOVA_BANK_TEXTRACT_MAX_PAGES", "60")))
    except ValueError:
        return 60


def _textract_text_for_bank(doc_path: str, max_pages: Optional[int] = None) -> str:
    """Column-preserving OCR text via AWS Textract (AnalyzeDocument TABLES when
    FINOVA_TEXTRACT_ANALYZE is on). Returns "" on any failure / unavailability so
    the caller safely keeps whatever text it already had. max_pages bounds the
    per-page OCR loop to stay within the process timeout on long statements."""
    try:
        try:
            from .aws_textract_tool import AWSTextractExtractor
        except ImportError:
            from aws_textract_tool import AWSTextractExtractor  # type: ignore
        txt = AWSTextractExtractor()._run(doc_path, max_pages=max_pages) or ""
        floor = max(50, 40 * min(_pdf_page_count(doc_path), max_pages or 10**9))
        if txt.startswith("ERROR") or len(txt.strip()) < floor:
            print(f"⚠️  bank Textract returned no usable text ({len(txt.strip())} chars < {floor})", file=sys.stderr)
            return ""
        print(f"📑 [phase1:Bank Statement] forced Textract OCR: {len(txt)} chars (column-preserving)", file=sys.stderr)
        return txt
    except Exception as e:
        print(f"⚠️  bank Textract re-extract skipped ({type(e).__name__}: {e})", file=sys.stderr)
        return ""


def _bank_textract_min_ratio() -> float:
    """Minimum fraction of the existing PyPDF2 text a forced-bank Textract result
    must reach to be trusted (see _textract_text_is_usable). Tunable via
    FINOVA_BANK_TEXTRACT_MIN_RATIO; defaults to 0.5."""
    try:
        return float(os.getenv("FINOVA_BANK_TEXTRACT_MIN_RATIO", "0.5"))
    except ValueError:
        return 0.5


def _textract_text_is_usable(tab: str, existing: str, pages: int) -> bool:
    """Decide whether a forced-bank Textract result should REPLACE the PyPDF2 text
    we already have.

    Reject it when Textract returned far less than the existing PyPDF2 text — the
    Banca Transilvania AnalyzeDocument failure mode, where TABLES detects nothing
    and returns a near-empty column dump (e.g. 72 chars) that would otherwise
    overwrite complete PyPDF2 text (e.g. 16k chars) and starve the model into
    nulls/hallucination. The absolute per-page floor in _textract_text_for_bank
    can't catch this (72 chars clears a 1-page floor of 50); only a RELATIVE
    comparison to the text we'd be discarding can.

    Only guards when the existing text is itself usable — a scanned PDF (little/no
    PyPDF2 text) still takes whatever Textract produced, since there's nothing
    richer to fall back to."""
    tab_len = len((tab or "").strip())
    existing_len = len((existing or "").strip())
    existing_usable = existing_len >= max(_MIN_CACHED_TEXT_CHARS, 40 * max(1, pages))
    if not existing_usable:
        return True  # nothing better to keep — take the Textract text
    return tab_len >= _bank_textract_min_ratio() * existing_len


def _pdf_page_count(doc_path: str) -> int:
    """Best-effort PDF page count (1 on any failure / non-PDF), for the
    page-aware text-sufficiency floor. Never raises."""
    if not str(doc_path).lower().endswith(".pdf"):
        return 1
    try:
        import PyPDF2
        with open(doc_path, "rb") as f:
            return max(1, len(PyPDF2.PdfReader(f).pages))
    except Exception:
        return 1


def _read_cached_document_text(doc_path: str) -> str:
    """Read pre-extracted text from /tmp/text_cache.

    main.py pre-extracts text via SimpleTextExtractorTool before invoking
    extraction, so the cache file is expected to exist. If it doesn't,
    fall back to extracting now — the same tool main.py uses.

    Keyed on the canonical content hash (SHA-256 of file bytes) so it matches
    what main.py and the Node side write — see doc_hash.py.
    """
    try:
        from .doc_hash import sha256_file
    except ImportError:
        from doc_hash import sha256_file

    cache_path = f"/tmp/text_cache/text_{sha256_file(doc_path)}.txt"
    if os.path.exists(cache_path):
        with open(cache_path, "r", encoding="utf-8") as f:
            cached = f.read()
        # A too-small cache file means a writer (e.g. the Node PyPDF2 pre-cache)
        # couldn't extract real text — e.g. an image-based PDF. Treat as a miss
        # so we fall through to a full extraction (PyPDF2 → Textract). The floor
        # is page-aware: a 9-page scan that cached 151 chars (~17/page) is a failed
        # extraction that must re-run through Textract, not be served as "text".
        min_chars = max(_MIN_CACHED_TEXT_CHARS, 40 * _pdf_page_count(doc_path))
        if len(cached.strip()) >= min_chars:
            return cached
        print(
            f"♻️  Cached text too small ({len(cached.strip())} chars < {min_chars}), re-extracting via Textract",
            file=sys.stderr,
        )

    # Fallback: extract now using the same tool main.py uses.
    try:
        from .crew import SimpleTextExtractorTool
    except ImportError:
        from crew import SimpleTextExtractorTool
    extractor = SimpleTextExtractorTool()
    text = extractor._run(doc_path)
    try:
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        with open(cache_path, "w", encoding="utf-8") as f:
            f.write(text)
    except Exception as e:
        print(f"⚠️  Could not write text cache: {e}", file=sys.stderr)
    return text


# ---------------------------------------------------------------------------
# OpenAI call wrapper with structured-output enforcement
# ---------------------------------------------------------------------------

def _is_reasoning_model(model: str) -> bool:
    """gpt-5 family and o-series reasoning models use `max_completion_tokens`
    (not the legacy `max_tokens`) and spend reasoning tokens against that same
    budget, so callers should size it with headroom."""
    m = model.lower()
    return m.startswith(("gpt-5", "o1", "o3", "o4"))


def _is_transient_api_error(e: Exception) -> bool:
    """True for retryable gateway/transport failures (NOT model/logic errors).

    OpenRouter intermittently returns a 5xx as an HTML/text body, which the OpenAI
    SDK fails to parse → a bare ``json.JSONDecodeError`` from ``response.json()``;
    plus connection/timeout/5xx errors. Matched by type name + message so it doesn't
    depend on a specific openai SDK version's class hierarchy."""
    import json as _json
    if isinstance(e, (_json.JSONDecodeError, ConnectionError, TimeoutError)):
        return True
    name = type(e).__name__
    if name in {
        "APIConnectionError", "APITimeoutError", "InternalServerError",
        "APIError", "RateLimitError", "ServiceUnavailableError",
    }:
        return True
    msg = str(e).lower()
    return any(s in msg for s in ("expecting value", "502", "503", "504",
                                  "bad gateway", "gateway time", "service unavailable"))


def _create_with_fallbacks(client: "OpenAI", kwargs: Dict[str, Any]):
    """chat.completions.create, retrying on cross-model parameter mismatches:

    - drop ``prompt_cache_key`` on older SDKs (TypeError);
    - swap ``max_tokens`` ↔ ``max_completion_tokens`` if the model rejects one;
    - drop ``temperature`` if the model only supports its default.

    Keeps the extraction path model-agnostic (gpt-4o / gpt-4.1 / gpt-5.x) without
    hardcoding each family's quirks.
    """
    from openai import BadRequestError

    for _ in range(4):  # bounded: at most one fix per parameter
        try:
            return client.chat.completions.create(**kwargs)
        except TypeError:
            if kwargs.pop("prompt_cache_key", None) is not None:
                continue
            raise
        except BadRequestError as e:
            msg = str(e).lower()
            if "max_tokens" in msg and "max_completion_tokens" in msg and "max_tokens" in kwargs:
                kwargs["max_completion_tokens"] = kwargs.pop("max_tokens")
                continue
            if "temperature" in msg and "temperature" in kwargs:
                kwargs.pop("temperature")
                continue
            if "reasoning" in msg and "reasoning_effort" in kwargs:
                kwargs.pop("reasoning_effort")
                continue
            raise
    return client.chat.completions.create(**kwargs)


def _call_structured(
    messages: list[Dict[str, str]],
    schema_cls: Type[StrictBase],
    schema_name: str,
    max_tokens: int,
    label: str,
    cache_key: Optional[str] = None,
    model: Optional[str] = None,
) -> tuple[Dict[str, Any], Dict[str, Any]]:
    """Call OpenAI with strict json_schema response_format.

    Returns ``(parsed_dict, meta)`` where meta carries model + token usage +
    timing for the metrics layer. Raises on validation failure — callers
    decide whether to retry or surface the error.

    `cache_key` is passed as OpenAI's ``prompt_cache_key`` to route same-shape
    prompts (same document type) to the same cache, improving the automatic
    prompt-cache hit rate (task 14). The messages are also ordered static-first,
    document-text-last so the large instruction prefix is cacheable.
    """
    model = model or get_extraction_llm_model()
    # Anthropic models (Claude) speak a different API — route them to the native
    # Messages + forced-tool-use path, which gives schema-conforming structured
    # output the way OpenAI's strict json_schema does here.
    if _is_anthropic_model(model):
        return _call_structured_anthropic(
            messages, schema_cls, schema_name, max_tokens, label, model=model)
    # OpenRouter (any vendor/model slug) and Gemini both speak the OpenAI
    # chat-completions API, so they reuse this whole path (messages, response_format,
    # parsing) with only a different client (base_url + key).
    if _is_openrouter_model(model):
        client = _get_openrouter_client()
    elif _is_gemini_model(model):
        client = _get_gemini_client()
    else:
        client = _get_client()

    create_kwargs: Dict[str, Any] = dict(
        model=model,
        messages=messages,
        response_format=_response_format_for(schema_cls, schema_name),
        temperature=0.3,
    )
    # Reasoning models reject `max_tokens`; use `max_completion_tokens` and let
    # the fallback wrapper handle any further per-model quirks.
    if _is_reasoning_model(model):
        create_kwargs["max_completion_tokens"] = max_tokens
    else:
        create_kwargs["max_tokens"] = max_tokens
    if cache_key and not _is_openrouter_model(model):
        # prompt_cache_key is an OpenAI-/Gemini-native param; OpenRouter rejects it.
        create_kwargs["prompt_cache_key"] = cache_key
    if "gemini" in model.lower():
        # Gemini 3 is a thinking model (direct or via OpenRouter): reasoning tokens
        # are billed against max_tokens, so they eat into the task budget and cut the
        # JSON off mid-list (the 300-token categorizer, and a long receipt that overran
        # 4000). Keep reasoning shallow and add headroom ON TOP of the task budget.
        # max_tokens is a cap, not a charge, so this only prevents truncation — cost
        # still tracks the tokens actually generated.
        create_kwargs["reasoning_effort"] = "low"
        create_kwargs["max_tokens"] = max(create_kwargs.get("max_tokens", 0), 2000) + 4000

    last_err: Optional[Exception] = None
    for attempt in range(2):
        started = time.time()
        # Pass a copy: _create_with_fallbacks mutates kwargs (pops unsupported params).
        try:
            response = _create_with_fallbacks(client, dict(create_kwargs))
        except Exception as e:
            # Transient gateway failures (OpenRouter 5xx returned as a non-JSON body →
            # the SDK raises json.JSONDecodeError; connection/timeout errors) aren't
            # the model's fault — resample once rather than failing the whole attempt
            # (which would re-run the expensive Textract OCR on the outer retry).
            if attempt == 0 and _is_transient_api_error(e):
                last_err = e
                print(f"⚠️  [{label}] transient API error (attempt {attempt + 1}/2): "
                      f"{type(e).__name__}: {str(e)[:160]}", file=sys.stderr)
                time.sleep(1.5)
                continue
            raise
        elapsed_ms = int((time.time() - started) * 1000)

        choice = response.choices[0]
        if choice.message.refusal:
            raise RuntimeError(f"[{label}] model refused: {choice.message.refusal}")

        # finish_reason == "length" means the response was cut off at max_tokens, so
        # the JSON is incomplete (a long row list overran the budget). Surface it as a
        # distinct, non-retryable error so the caller recovers via chunking rather than
        # re-running the same truncating call — see TruncatedExtraction.
        if getattr(choice, "finish_reason", None) == "length":
            raise TruncatedExtraction(
                f"[{label}] output hit max_tokens={create_kwargs.get('max_tokens') or max_tokens} "
                f"(finish_reason=length); row list cut off mid-JSON",
                partial=choice.message.content or "",
            )

        raw = choice.message.content or "{}"
        try:
            parsed = json.loads(raw)
            # Some providers (Gemini/OpenRouter) don't hard-enforce single-value enums
            # in response_format, so the model may echo the document's own language
            # ("Factura" vs the schema literal "Invoice"). The doc type is known by the
            # caller, so coerce a fixed-literal document_type to the schema's value.
            _coerce_fixed_document_type(parsed, schema_cls)
            schema_cls.model_validate(parsed)
        except (json.JSONDecodeError, ValidationError) as e:
            # Non-strict providers occasionally drift from the schema; resample once
            # before giving up (OpenAI strict mode effectively never lands here).
            last_err = e
            print(
                f"⚠️  [{label}] invalid structured output (attempt {attempt + 1}/2): "
                f"{str(e)[:160]}",
                file=sys.stderr,
            )
            continue

        usage = response.usage
        cached_tokens = 0
        if usage is not None:
            details = getattr(usage, "prompt_tokens_details", None)
            if details is not None:
                cached_tokens = getattr(details, "cached_tokens", 0) or 0
        meta: Dict[str, Any] = {
            "model": model,
            "duration_ms": elapsed_ms,
            "prompt_tokens": usage.prompt_tokens if usage else None,
            "completion_tokens": usage.completion_tokens if usage else None,
            "cached_tokens": cached_tokens,
        }
        if usage:
            print(
                f"💰 [{label}] model={model} prompt={usage.prompt_tokens} "
                f"(cached={cached_tokens}) completion={usage.completion_tokens} "
                f"elapsed={elapsed_ms}ms",
                file=sys.stderr,
            )
        # Debug trace: the RAW model output, BEFORE any deterministic
        # post-processing — the single most important diagnostic (is the model or
        # the post-processing to blame?).
        if TRACE.enabled:
            try:
                fields: Dict[str, Any] = {
                    "label": label,
                    "model": model,
                    "finish_reason": getattr(choice, "finish_reason", None),
                    "keys": sorted(parsed.keys()) if isinstance(parsed, dict) else None,
                    "raw_sample": TRACE.sample(raw),
                }
                if isinstance(parsed.get("transactions"), list):
                    fields["raw_txn_summary"] = txn_summary(parsed)
                if isinstance(parsed.get("line_items"), list):
                    fields["raw_line_item_count"] = len(parsed["line_items"])
                TRACE.stage("model_raw", **fields)
            except Exception:
                pass
        return parsed, meta

    raise last_err  # both attempts produced unparseable / schema-invalid output


# ---------------------------------------------------------------------------
# Anthropic (Claude) provider — structured output via forced tool-use
#
# The extraction path is built around OpenAI's strict json_schema response_format.
# Claude has no equivalent response_format, but a tool with `input_schema` set to
# the Pydantic JSON schema and `tool_choice` forcing that tool yields the same
# guarantee: the model must return arguments matching the schema. This lets us A/B
# a frontier multimodal model (e.g. claude-sonnet-4-6) on the SAME prompts/schemas/
# pipeline by only changing FINOVA_EXTRACTION_LLM_MODEL. Embeddings/RAG stay on
# OpenAI; only the chat extraction call switches.
# ---------------------------------------------------------------------------

_anthropic_client = None


def _is_anthropic_model(model: str) -> bool:
    return (
        model.lower().startswith("claude")
        or os.getenv("FINOVA_EXTRACTION_PROVIDER", "").lower() == "anthropic"
    )


def _get_anthropic_client():
    global _anthropic_client
    if _anthropic_client is None:
        import anthropic
        _anthropic_client = anthropic.Anthropic()
    return _anthropic_client


def _to_anthropic_messages(messages: list) -> tuple[str, list]:
    """Translate the OpenAI-shaped messages from _build_messages /
    _build_vision_messages into Anthropic's (system, messages) form.

    OpenAI `image_url` data-URLs become Anthropic base64 image blocks; the system
    message becomes the top-level `system` string.
    """
    system_parts: list[str] = []
    out: list = []
    for m in messages:
        role = m.get("role")
        content = m.get("content")
        if role == "system":
            if isinstance(content, str):
                system_parts.append(content)
            continue
        if isinstance(content, str):
            blocks: list = [{"type": "text", "text": content}]
        else:
            blocks = []
            for part in content:
                ptype = part.get("type")
                if ptype == "text":
                    blocks.append({"type": "text", "text": part.get("text", "")})
                elif ptype == "image_url":
                    url = part.get("image_url", {}).get("url", "")
                    if url.startswith("data:"):
                        header, _, b64 = url.partition(",")
                        media_type = header[5:].split(";")[0] or "image/png"
                        blocks.append({
                            "type": "image",
                            "source": {"type": "base64", "media_type": media_type, "data": b64},
                        })
            if not blocks:
                blocks = [{"type": "text", "text": ""}]
        out.append({"role": "assistant" if role == "assistant" else "user", "content": blocks})
    return "\n".join(p for p in system_parts if p), out


def _call_structured_anthropic(
    messages: list,
    schema_cls: Type[StrictBase],
    schema_name: str,
    max_tokens: int,
    label: str,
    model: Optional[str] = None,
) -> tuple[Dict[str, Any], Dict[str, Any]]:
    """Claude equivalent of _call_structured via forced tool-use. Same return shape."""
    client = _get_anthropic_client()
    model = model or get_extraction_llm_model()
    system, anth_messages = _to_anthropic_messages(messages)
    tool = {
        "name": schema_name,
        "description": "Return ONLY the extracted document fields, matching the schema exactly.",
        "input_schema": schema_cls.model_json_schema(),
    }

    started = time.time()
    response = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        temperature=0.3,
        system=system or "You are a precise financial-document data-extraction engine.",
        messages=anth_messages,
        tools=[tool],
        tool_choice={"type": "tool", "name": schema_name},
    )
    elapsed_ms = int((time.time() - started) * 1000)

    # stop_reason == "max_tokens" → the tool arguments were cut off mid-JSON; same
    # contract as the OpenAI finish_reason=="length" branch (recover via chunking).
    if getattr(response, "stop_reason", None) == "max_tokens":
        partial = ""
        try:  # best-effort salvage of the (incomplete) tool args for header recovery
            for block in response.content:
                if getattr(block, "type", None) == "tool_use":
                    partial = json.dumps(getattr(block, "input", {}) or {}, default=str)
                    break
        except Exception:
            pass
        raise TruncatedExtraction(
            f"[{label}] output hit max_tokens={max_tokens} (stop_reason=max_tokens)",
            partial=partial,
        )

    parsed = None
    for block in response.content:
        if getattr(block, "type", None) == "tool_use" and getattr(block, "name", None) == schema_name:
            parsed = block.input
            break
    if parsed is None:
        texts = " ".join(getattr(b, "text", "") for b in response.content
                         if getattr(b, "type", None) == "text")
        raise RuntimeError(f"[{label}] Claude returned no tool_use block: {texts[:200]}")

    try:
        schema_cls.model_validate(parsed)
    except ValidationError as e:
        print(f"⚠️  [{label}] schema validation failed (anthropic): {e}", file=sys.stderr)
        raise

    usage = getattr(response, "usage", None)
    cached = (getattr(usage, "cache_read_input_tokens", 0) or 0) if usage else 0
    meta: Dict[str, Any] = {
        "model": model,
        "duration_ms": elapsed_ms,
        "prompt_tokens": getattr(usage, "input_tokens", None) if usage else None,
        "completion_tokens": getattr(usage, "output_tokens", None) if usage else None,
        "cached_tokens": cached,
    }
    if usage:
        print(
            f"💰 [{label}] model={model} input={meta['prompt_tokens']} "
            f"(cached={cached}) output={meta['completion_tokens']} elapsed={elapsed_ms}ms",
            file=sys.stderr,
        )
    return parsed, meta


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def categorize_document(
    doc_path: str, inputs: Dict[str, Any]
) -> tuple[Dict[str, Any], Dict[str, Any]]:
    """Phase 0: classify a document.

    Returns ``(data, meta)`` where data matches schemas.CategorizationResult.
    """
    tasks = _load_tasks_config()
    template = tasks["categorize_document_task"]["description"]
    prompt = _format_prompt(template, inputs)

    text = _read_cached_document_text(doc_path)
    messages = _build_messages(prompt, text, os.path.basename(doc_path))

    return _call_structured(
        messages=messages,
        schema_cls=CategorizationResult,
        schema_name="categorization_result",
        max_tokens=get_categorization_max_tokens(),
        label="phase0:categorize",
        cache_key="finova-categorize",
    )


_EXTRACTION_TASK_NAMES = {
    "Invoice": "extract_invoice_data_task",
    "Receipt": "extract_receipt_data_task",
    "Bank Statement": "extract_bank_statement_data_task",
    "Contract": "extract_contract_data_task",
    "Z Report": "extract_z_report_data_task",
    "Payment Disposition": "extract_payment_disposition_data_task",
    "Collection Disposition": "extract_collection_disposition_data_task",
    "CMR": "extract_cmr_data_task",
    "Vehicle Registration Certificate": "extract_vehicle_registration_data_task",
    "Other": "extract_other_document_data_task",
}

def _empty_critical(document_type: str, data: Dict[str, Any]) -> list:
    """Critical fields a pass left empty — the vision-escalation trigger."""
    try:
        import extraction_metrics
    except ImportError:
        from . import extraction_metrics  # type: ignore
    return extraction_metrics.compute_empty_fields(document_type, data)


def _run_phase1(
    doc_path: str,
    document_type: str,
    prompt: str,
    text: str,
    basename: str,
    use_vision: bool,
) -> tuple[Dict[str, Any], Dict[str, Any]]:
    """One extraction call — vision (image + OCR text) or text-only. Falls back
    to text if image rendering yields nothing."""
    schema_cls = schema_for(document_type)
    images = _render_doc_images(doc_path, document_type) if use_vision else []
    vision = bool(images)
    if vision:
        messages = _build_vision_messages(prompt, text, images, basename)
        label = f"phase1:{document_type}:vision({len(images)}p)"
    else:
        messages = _build_messages(prompt, text, basename)
        label = f"phase1:{document_type}" + (":vision-render-failed" if use_vision else "")

    data, meta = _call_structured(
        messages=messages,
        schema_cls=schema_cls,
        schema_name=f"{document_type.lower().replace(' ', '_')}_data",
        max_tokens=get_extraction_max_tokens(document_type),
        label=label,
        cache_key=f"finova-extract-{document_type.lower().replace(' ', '-')}",
    )
    meta["vision"] = vision
    return data, meta


def _schema_name_for(document_type: str) -> str:
    return f"{document_type.lower().replace(' ', '_')}_data"


# ---------------------------------------------------------------------------
# Validator-guided repair pass
#
# The deterministic validators (validators.py) already compute exactly *which*
# fields are arithmetically inconsistent (VAT math, total = Σlines, closing =
# opening + Σcr − Σdr, CUI checksum, IBAN mod-97). Instead of only lowering
# confidence, feed those specific failures back to the model as a targeted
# correction. Kept only if it reduces the failure count and doesn't blank a
# critical field — same conservative "keep if better" rule as vision escalation.
# ---------------------------------------------------------------------------

def _validate(document_type: str, data: Dict[str, Any], current_date: Optional[str]) -> list:
    """Failing checks from the deterministic validators (empty if all pass)."""
    try:
        import validators as _validators
    except ImportError:
        from . import validators as _validators  # type: ignore
    try:
        result = _validators.validate_extraction(document_type, data, current_date)
    except Exception as e:  # validators must never break extraction
        print(f"⚠️  validation failed (treated as no findings): {e}", file=sys.stderr)
        return []
    return [c for c in result.get("checks", []) if not c.get("passed")]


def _repair_instruction(prior_data: Dict[str, Any], failed: list) -> str:
    """The correction turn: the specific failed checks + the prior JSON to fix."""
    findings = "\n".join(
        f"- {c.get('field')}: check \"{c.get('rule')}\" FAILED — {c.get('detail')}"
        for c in failed
    )
    # Drop internal/bookkeeping keys so the model focuses on the real fields.
    clean = {k: v for k, v in prior_data.items()
             if not k.startswith("_") and k != "confidence"}
    return (
        "=== VALIDATION ERRORS — CORRECT THESE ===\n"
        "Deterministic checks found these fields inconsistent with the document. "
        "Re-examine the document and return the FULL corrected JSON for the same "
        "schema. Fix these specific problems; keep every other field unchanged "
        "unless the document clearly contradicts it.\n\n"
        f"{findings}\n\n"
        "Likely causes: a misread digit, a missing or duplicated line item, net vs "
        "gross VAT confusion, or a balance sign error (a balance printed in the "
        "Debit column is negative). Recompute so the amounts reconcile.\n\n"
        "Your previous extraction to correct:\n"
        f"{json.dumps(clean, ensure_ascii=False)}"
    )


def _run_repair(
    doc_path: str,
    document_type: str,
    prompt: str,
    text: str,
    basename: str,
    prior_data: Dict[str, Any],
    failed: list,
    use_vision: bool,
) -> tuple[Dict[str, Any], Dict[str, Any]]:
    """One correction call: same prompt/schema, plus the failed-check addendum."""
    images = _render_doc_images(doc_path, document_type) if use_vision else []
    if images:
        messages = _build_vision_messages(prompt, text, images, basename)
    else:
        messages = _build_messages(prompt, text, basename)
    messages.append({"role": "user", "content": _repair_instruction(prior_data, failed)})

    data, meta = _call_structured(
        messages=messages,
        schema_cls=schema_for(document_type),
        schema_name=_schema_name_for(document_type),
        max_tokens=get_extraction_max_tokens(document_type),
        label=f"phase1:{document_type}:repair",
        cache_key=f"finova-extract-{document_type.lower().replace(' ', '-')}",
    )
    meta["vision"] = bool(images)
    return data, meta


def _maybe_repair(
    doc_path: str,
    document_type: str,
    prompt: str,
    text: str,
    basename: str,
    data: Dict[str, Any],
    meta: Dict[str, Any],
    current_date: Optional[str],
) -> tuple[Dict[str, Any], Dict[str, Any]]:
    """Run one repair pass if a validator check failed; keep it only if strictly
    better (fewer failures, no new empty critical field)."""
    failed = _validate(document_type, data, current_date)
    scoped = _repair_scoped_enabled()
    if scoped:
        failed = _scoped_failed(failed)
    if not failed:
        return data, meta

    print(
        f"🔧 [phase1:{document_type}] {len(failed)} {'checksum/format' if scoped else 'validator'} "
        f"check(s) failed → repair pass",
        file=sys.stderr,
    )
    try:
        data_r, meta_r = _run_repair(
            doc_path, document_type, prompt, text, basename, data, failed,
            use_vision=bool(meta.get("vision")),
        )
    except Exception as e:
        print(f"⚠️  repair pass errored (keeping original): {e}", file=sys.stderr)
        return data, meta

    failed_after = _validate(document_type, data_r, current_date)
    if scoped:
        failed_after = _scoped_failed(failed_after)
    improved = len(failed_after) < len(failed)
    no_new_gaps = len(_empty_critical(document_type, data_r)) <= len(_empty_critical(document_type, data))
    if improved and no_new_gaps:
        meta_r["repaired"] = True
        meta_r["checks_failed_before"] = len(failed)
        meta_r["checks_failed_after"] = len(failed_after)
        print(f"✅ repair kept: failed checks {len(failed)}→{len(failed_after)}", file=sys.stderr)
        return data_r, meta_r

    print(
        f"↩️  repair discarded: {len(failed)}→{len(failed_after)} failed checks"
        f"{' (would blank a critical field)' if not no_new_gaps else ''}",
        file=sys.stderr,
    )
    return data, meta


# ---------------------------------------------------------------------------
# Chunked bank-statement transaction extraction
#
# A 9–20 page statement has 50+ transaction rows — more than the model reliably
# emits in one structured-output call, so the tail silently drops (the eval shows
# transactions[F1] as the worst metric). Read the statement a page-group at a
# time with a transactions-only schema and concatenate the rows. Header fields
# (balances, period, account) stay from the single full-document pass.
# ---------------------------------------------------------------------------

_PAGE_MARKER_RE = re.compile(r"=== PAGE \d+ ===")

_BANK_CHUNK_PROMPT = """You are extracting transaction rows from a page of a multi-page bank statement.

Return EVERY transaction row visible in the text below, as JSON. Do not skip any row, and do not invent rows that are not there. Ignore page headers, column titles, the opening/closing balance lines, and subtotal/total lines — only real dated transaction rows.

For each transaction:
- transaction_date: the value date, DD-MM-YYYY.
- description: the narrative / details text.
- reference_number: the row's document or reference number if shown, else "".
- debit_amount: money OUT (debit column); null when the row is a credit.
- credit_amount: money IN (credit column); null when the row is a debit.
- balance_after_transaction: the running balance for the row, signed (negative if shown in the debit/overdraft column).
- transaction_type: the best fit of transfer, payment, deposit, withdrawal.
- referenced_numbers: any invoice/document numbers inside the description, else [].
"""


def _split_pages(text: str) -> list[str]:
    """Split OCR text on ``=== PAGE N ===`` markers into non-empty page chunks."""
    return [p.strip() for p in _PAGE_MARKER_RE.split(text or "") if p.strip()]


def _txn_amount_key(value: Any) -> Optional[float]:
    n = _num_or_none(value)
    return round(n, 2) if n is not None else None


def _num_or_none(value: Any) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _dedupe_transactions(txns: list) -> list:
    """Drop rows duplicated across page boundaries (repeated headers / carryover).

    Keyed on date + reference number + signed amounts + balance + a description
    prefix, which is unique per real row; preserves order. The reference number
    is part of the key so two same-day, same-amount rows that differ only by
    document/reference number aren't collapsed into one."""
    seen = set()
    out = []
    for t in txns:
        if not isinstance(t, dict):
            continue
        key = (
            str(t.get("transaction_date") or "").strip(),
            (t.get("reference_number") or "").strip(),
            _txn_amount_key(t.get("debit_amount")),
            _txn_amount_key(t.get("credit_amount")),
            _txn_amount_key(t.get("balance_after_transaction")),
            (t.get("description") or "").strip().lower()[:40],
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(t)
    return out


def _extract_chunk_transactions(chunk_text: str, basename: str, idx: int, total: int) -> list:
    """Transactions-only extraction for one page-group; [] on failure (the base
    pass already has a fallback set)."""
    messages = [
        {"role": "system", "content": _BANK_CHUNK_PROMPT.strip()},
        {"role": "user",
         "content": f"=== BANK STATEMENT PAGE GROUP {idx}/{total} ({basename}) ===\n{chunk_text}"},
    ]
    try:
        parsed, _ = _call_structured(
            messages=messages,
            schema_cls=BankTransactionsChunk,
            schema_name="bank_transactions_chunk",
            max_tokens=get_extraction_max_tokens("Bank Statement"),
            label=f"phase1:Bank Statement:chunk({idx}/{total})",
            cache_key="finova-extract-bank-chunk",
        )
    except Exception as e:
        print(f"⚠️  bank chunk {idx}/{total} failed: {e}", file=sys.stderr)
        return []
    return parsed.get("transactions") or []


def _maybe_chunk_bank_transactions(
    prompt: str,  # unused; kept for signature symmetry with _maybe_repair
    text: str,
    basename: str,
    data: Dict[str, Any],
    meta: Dict[str, Any],
    force: bool = False,
) -> tuple[Dict[str, Any], Dict[str, Any]]:
    """Re-extract transactions page-by-page and merge; keep the chunked set only
    if it recovers more rows than the single full-document pass (the failure mode
    is truncation, so more rows = recovered tail).

    `force=True` is used when the full-document pass itself truncated: there are
    no base rows to beat, so the chunked rows are the only ones we have — process
    even a single page rather than returning the empty seed."""
    pages = _split_pages(text)
    if len(pages) < 2 and not force:
        return data, meta  # single page → one call already saw everything
    if not pages:
        pages = [text]

    chunk_pages = max(1, int(os.getenv("FINOVA_BANK_CHUNK_PAGES", "1")))
    groups = [pages[i:i + chunk_pages] for i in range(0, len(pages), chunk_pages)]

    # Each page-group is an independent, transactions-only LLM call, so run them
    # concurrently. Sequentially, a 20+ page statement is 20+ serial calls whose
    # summed wall-clock overruns the Node-side 180s subprocess timeout — the
    # caller then kills Python and returns the empty `python_timeout` fallback,
    # i.e. a statement that "extracted nothing". Bounded so we don't fan out into
    # OpenAI rate limits (the Node layer already runs up to 4 docs in parallel).
    concurrency = max(1, int(os.getenv("FINOVA_BANK_CHUNK_CONCURRENCY", "6")))
    per_group: list = [None] * len(groups)
    if concurrency == 1 or len(groups) == 1:
        for idx, group in enumerate(groups, 1):
            per_group[idx - 1] = _extract_chunk_transactions(
                "\n\n".join(group), basename, idx, len(groups))
    else:
        from concurrent.futures import ThreadPoolExecutor

        def _run_group(item):
            idx, group = item  # idx is 1-based
            return idx, _extract_chunk_transactions(
                "\n\n".join(group), basename, idx, len(groups))

        with ThreadPoolExecutor(max_workers=min(concurrency, len(groups))) as pool:
            for idx, rows in pool.map(_run_group, list(enumerate(groups, 1))):
                per_group[idx - 1] = rows

    # Concatenate in page order (per_group is index-aligned) so the merged list
    # stays chronological regardless of completion order, keeping dedup and
    # downstream output deterministic.
    collected: list = []
    for rows in per_group:
        collected.extend(rows or [])
    merged = _dedupe_transactions(collected)

    base_count = len(data.get("transactions") or [])
    # Keep the chunked set only if it reconciles BETTER than the base — not merely
    # if it has more rows. "More rows" let page-boundary duplicates replace a correct
    # base pass; the statement's own arithmetic (opening + Σcr − Σdr vs closing) is
    # the right judge. Fall back to the row-count rule only when balances are absent,
    # and always keep when the base was an empty truncation seed.
    try:
        from .bank_statement_recon import statement_sum_gap
    except ImportError:
        from bank_statement_recon import statement_sum_gap  # type: ignore
    base_gap = statement_sum_gap(data)
    merged_gap = statement_sum_gap({**data, "transactions": merged})

    if force and base_count == 0:
        keep = True
    elif base_gap is not None and merged_gap is not None:
        keep = merged_gap + 0.01 < base_gap
    else:
        keep = len(merged) > base_count

    if TRACE.enabled:
        try:
            TRACE.stage("bank_chunking", pages=len(pages), groups=len(groups),
                        per_group_counts=[len(r or []) for r in per_group],
                        collected=len(collected), merged=len(merged),
                        base_count=base_count, base_gap=base_gap, merged_gap=merged_gap,
                        force=force, keep=keep)
        except Exception:
            pass

    if not keep:
        print(
            f"↩️  bank chunking not kept: merged {len(merged)} rows (gap {merged_gap}) "
            f"vs base {base_count} rows (gap {base_gap})",
            file=sys.stderr,
        )
        return data, meta

    data = dict(data)
    data["transactions"] = merged
    meta["bank_chunked"] = True
    meta["txn_rows_base"] = base_count
    meta["txn_rows_chunked"] = len(merged)
    print(
        f"✅ bank chunking kept: {base_count}→{len(merged)} rows "
        f"(gap {base_gap}→{merged_gap}, {len(groups)} page-group call(s))",
        file=sys.stderr,
    )
    return data, meta


def _salvage_header_from_partial_json(partial: str) -> Dict[str, Any]:
    """Pull the header scalars out of a TRUNCATED bank-statement JSON.

    The model serializes header fields (company_name/ein, bank, account, period,
    opening/closing balance, currency) BEFORE the ``transactions`` array, so when
    the output is cut off mid-transactions those leading fields are intact. We
    can't json.loads the incomplete string, so: cut everything from ``"transactions"``
    onward, close the object, and parse that head. Falls back to per-field regex if
    the head still won't parse. Returns only the scalar fields found (never raises)."""
    out: Dict[str, Any] = {}
    if not partial or not isinstance(partial, str):
        return out
    scalar_keys = (
        "company_name", "company_ein", "bank_name", "account_number",
        "statement_number", "statement_period_start", "statement_period_end",
        "opening_balance", "closing_balance", "currency",
    )
    # Attempt 1: parse the object head (everything before the transactions array).
    cut = partial.find('"transactions"')
    head = partial[:cut].rstrip().rstrip(",") if cut > 0 else ""
    if head:
        try:
            obj = json.loads(head + "}")
            if isinstance(obj, dict):
                got = {k: obj[k] for k in scalar_keys if k in obj and obj[k] not in (None, "")}
                if got:  # only trust the head parse when it actually yielded fields
                    return got
        except Exception:
            pass
    # Attempt 2: regex each scalar out of the partial (robust to odd truncation).
    for k in scalar_keys:
        m = re.search(rf'"{k}"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d[\d.]*)', partial)
        if not m:
            continue
        tok = m.group(1)
        if tok.startswith('"'):
            try:
                val = json.loads(tok)
            except Exception:
                continue
        else:
            try:
                val = float(tok) if ("." in tok) else int(tok)
            except ValueError:
                continue
        if val not in (None, ""):
            out[k] = val
    return out


def _seed_bank_statement_after_truncation(partial: str = "") -> Dict[str, Any]:
    """Placeholder when the bank-statement full-document pass truncated mid-JSON, so
    the chunked recovery can run and refill the transaction list. Header scalars are
    SALVAGED from the truncated partial (they precede the transactions array, so they
    were already emitted) — the UniCredit 306-row case lost its whole header before
    this. Shapes match BankStatementData so downstream consumers don't KeyError."""
    seed: Dict[str, Any] = {
        "document_type": "Bank Statement",
        "company_name": "", "company_ein": "", "bank_name": "",
        "account_number": "", "statement_number": "",
        "statement_period_start": "", "statement_period_end": "",
        "opening_balance": 0.0, "closing_balance": 0.0,
        "currency": "RON", "transactions": [],
    }
    salvaged = _salvage_header_from_partial_json(partial)
    if salvaged:
        seed.update(salvaged)
        print(f"♻️  [phase1:Bank Statement] salvaged header from truncated JSON: "
              f"{sorted(salvaged.keys())}", file=sys.stderr)
    return seed


# Control/summary rows Romanian banks print inside the transaction grid (turnover
# and balance lines). They are NOT transactions, but models routinely emit them —
# inflating the row count and breaking balance reconciliation. Matched against the
# diacritic-stripped, lowercased description (anchored at the start).
_SUMMARY_TXN_MARKERS = (
    "rulaj",  # RULAJ ZI / RULAJ TOTAL CONT / RULAJ CONT
    "sold initial", "sold final", "sold anterior", "sold precedent", "sold zi",
    "sold cont", "sold intermediar", "sold disponibil", "sold curent",
    "total cont", "total rulaj", "total general", "total zi", "total iesiri",
    "total intrari", "report sold",
)


def _is_summary_transaction(t: dict) -> bool:
    """True if a row's description is a bank control/summary label, not a movement."""
    import unicodedata
    desc = t.get("description")
    if not isinstance(desc, str):
        return False
    norm = "".join(
        c for c in unicodedata.normalize("NFKD", desc) if not unicodedata.combining(c)
    )
    norm = re.sub(r"\s+", " ", norm).strip().lower()
    return any(norm.startswith(m) for m in _SUMMARY_TXN_MARKERS)


def _drop_summary_transactions(transactions: list) -> list:
    """Remove bank control/summary rows the model mistook for transactions."""
    return [
        t for t in transactions
        if not (isinstance(t, dict) and _is_summary_transaction(t))
    ]


# Domestic reverse charge (taxare inversă, art. 331 Cod fiscal). The mention is legally
# required on such an invoice, so a text hit is a high-precision signal — it sets the flag
# the beneficiary's 4426=4427 self-assessment posting reads downstream (files.service).
_REVERSE_CHARGE_MARKERS = (
    "taxare inversa",
    "taxarea inversa",
    "reverse charge",
    "reverse-charge",
)

_VAT_KEY_HEADER_RE = re.compile(
    r"(?:\bvat\s*key\b|\bmwst\.?\s*kennz(?:eichnung)?\.?)",
    re.IGNORECASE,
)
_VAT_KEY_BEFORE_PRICE_RE = re.compile(
    r"(?:^|[\s|;])([IM])(?=\s*(?:[|;]\s*)?(?:EUR|€)?\s*[-+]?\d[\d.,]*)",
    re.IGNORECASE,
)
_VAT_KEY_ONLY_RE = re.compile(r"^\s*[|;]?\s*([IM])\s*[|;]?\s*$", re.IGNORECASE)
_VAT_TABLE_END_RE = re.compile(
    r"^\s*(?:total(?:\s+netto)?|summe\s+netto|subtotal|gesamt)",
    re.IGNORECASE,
)


def _reverse_charge_from_vat_key(text: Optional[str]) -> Optional[bool]:
    """Map an explicitly printed VAT-key table column to reverse charge.

    AUTO1 invoice tables label the column ``MwSt. Kennz. / VAT Key``. Their key
    ``I`` means reverse charge while ``M`` means reverse charge is not applied.
    OCR may preserve a whole table row on one line or emit each cell on its own
    line, so support both shapes. Return ``None`` when there is no trustworthy
    VAT-key table signal.
    """
    lines = (text or "").splitlines()
    header_index = next(
        (index for index, line in enumerate(lines) if _VAT_KEY_HEADER_RE.search(line)),
        None,
    )
    if header_index is None:
        return None

    keys: list[str] = []
    # VAT tables are short, but keep a generous bound for multi-line OCR output.
    for line in lines[header_index + 1:header_index + 121]:
        if keys and _VAT_TABLE_END_RE.search(line):
            break
        match = _VAT_KEY_BEFORE_PRICE_RE.search(line) or _VAT_KEY_ONLY_RE.fullmatch(line)
        if match:
            keys.append(match.group(1).upper())

    if "I" in keys:
        return True
    if "M" in keys:
        return False
    return None


def _detect_reverse_charge(text: Optional[str], data: dict) -> bool:
    """True when an invoice applies domestic reverse charge. An explicit AUTO1
    VAT key is authoritative; otherwise use a "taxare inversă" text marker and
    finally keep whatever the model may have set."""
    import unicodedata
    vat_key_value = _reverse_charge_from_vat_key(text)
    if vat_key_value is not None:
        return vat_key_value
    hay = "".join(
        c for c in unicodedata.normalize("NFKD", (text or "").lower())
        if not unicodedata.combining(c)
    )
    if any(marker in hay for marker in _REVERSE_CHARGE_MARKERS):
        return True
    return data.get("reverse_charge") is True


def _force_positive_transaction_amounts(transactions: list) -> None:
    """Coerce each transaction's debit_amount/credit_amount to a positive magnitude.

    The schema carries debit and credit in separate fields, so direction is implied
    by which field is populated; a negative value means the model misread the column,
    and a negative debit would double-count when downstream reconciliation computes
    ``balance = prev − debit + credit``. ``balance_after_transaction`` is left
    untouched (it is legitimately negative on an overdraft). Mutates in place.
    """
    for t in transactions:
        if not isinstance(t, dict):
            continue
        for key in ("debit_amount", "credit_amount"):
            v = t.get(key)
            if isinstance(v, (int, float)):
                t[key] = abs(v)


def extract_document(
    doc_path: str,
    document_type: str,
    inputs: Dict[str, Any],
    extra_instructions: str = "",
    force_vision: bool = False,
) -> tuple[Dict[str, Any], Dict[str, Any]]:
    """Phase 1: extract structured data for an already-categorized document.

    `extra_instructions` is the dynamic per-document suffix (neplatitor TVA,
    learned corrections, CAEN context) produced by
    FirstCrewFinova.get_dynamic_prompt_suffix — kept identical across the
    legacy and direct paths.

    Vision modes (task 4):
      * FINOVA_VISION_EXTRACTION=true (or force_vision) — always send the page
        image alongside the OCR text.
      * FINOVA_VISION_ESCALATION=true — text-only first, then re-run with vision
        only if the cheap pass left a critical field empty (cost-aware).

    Returns ``(data, meta)`` where data matches the schema registered for
    `document_type`. Raises ValueError if document_type is unknown.
    """
    if document_type not in _EXTRACTION_TASK_NAMES:
        raise ValueError(
            f"Unsupported document_type for extraction: {document_type!r}"
        )

    tasks = _load_tasks_config()
    template = tasks[_EXTRACTION_TASK_NAMES[document_type]]["description"]
    prompt = _format_prompt(template, inputs)
    if extra_instructions:
        prompt = prompt + extra_instructions

    text = _read_cached_document_text(doc_path)
    basename = os.path.basename(doc_path)

    # Bank statements: prefer Textract AnalyzeDocument (TABLES) over PyPDF2. PyPDF2
    # linearizes the debit/credit/balance columns into glued tokens (the UniCredit
    # "RAMNICU8.60" / "/IRF .00.04" junk that has a long-but-useless char count and
    # so passes the size floor) — the model then can't tell which column an amount
    # is in. Textract preserves the column layout, which is exactly what lets it
    # assign debit vs credit and catch every row. Re-extract here (where doc_type is
    # known) and prefer it unless it comes back clearly worse. Gated/safe.
    if document_type == "Bank Statement" and _bank_force_textract():
        # Long statements can't OCR every page within the Phase-1 process timeout
        # (~5s/page → a 49-page statement blows the 180s budget and gets SIGKILLed,
        # yielding the garbage timeout fallback). When PyPDF2 already produced
        # complete text, keep it: complete-but-column-glued beats a hard timeout.
        # Only force Textract here when the page count is within the OCR budget, or
        # when we have no usable PyPDF2 text (scanned PDF) and must OCR a bounded
        # subset regardless.
        pages = _pdf_page_count(doc_path)
        bank_cap = _bank_textract_max_pages()
        has_usable_text = bool(text and len(text.strip()) >= max(50, 40 * pages))
        if pages > bank_cap and has_usable_text:
            print(
                f"⏭️  [phase1:Bank Statement] {pages} pages > {bank_cap}-page OCR budget — "
                f"keeping PyPDF2 text ({len(text)} chars) to stay within the Phase-1 timeout",
                file=sys.stderr,
            )
            tab = ""
        else:
            # Reuse a Textract result already produced for this document on a prior
            # attempt — re-OCR'ing 49 pages on every retry (the model call can fail
            # transiently) is exactly what blows the timeout budget (270s × 2 > 480s).
            # The marker file is dedicated (not the shared text cache, which other
            # writers overwrite) and keyed on content hash.
            try:
                from .doc_hash import sha256_file
            except ImportError:
                from doc_hash import sha256_file  # type: ignore
            try:
                _tcp = f"/tmp/text_cache/textract_{sha256_file(doc_path)}.txt"
            except Exception:
                _tcp = None
            tab = ""
            if _tcp and os.path.exists(_tcp):
                try:
                    with open(_tcp, "r", encoding="utf-8") as f:
                        tab = f.read()
                    if tab:
                        print(f"♻️  [phase1:Bank Statement] reusing cached Textract OCR "
                              f"({len(tab)} chars) — skipping re-OCR", file=sys.stderr)
                except Exception:
                    tab = ""
            if not tab:
                # _textract_text_for_bank returns "" unless Textract produced
                # page-appropriate content; its clean column layout beats PyPDF2's
                # glued text even when shorter. Cap the loop so it can't run past
                # the timeout, and persist it for the next attempt.
                tab = _textract_text_for_bank(doc_path, max_pages=bank_cap)
                if tab and _tcp:
                    try:
                        os.makedirs(os.path.dirname(_tcp), exist_ok=True)
                        with open(_tcp, "w", encoding="utf-8") as f:
                            f.write(tab)
                    except Exception:
                        pass
        if tab and not _textract_text_is_usable(tab, text, pages):
            # Banca Transilvania ANALYZE-no-tables failure: Textract returned far
            # less than the PyPDF2 text we already have. Keep PyPDF2 (the model
            # gets complete text + the page image) instead of letting a near-empty
            # column dump replace it.
            print(
                f"⏭️  [phase1:Bank Statement] Textract OCR ({len((tab or '').strip())} chars) ≪ "
                f"PyPDF2 text ({len((text or '').strip())} chars) — ANALYZE found no tables; "
                f"keeping PyPDF2 text",
                file=sys.stderr,
            )
            _bank_dbg("textract_rejected", textract_chars=len((tab or '').strip()),
                      pypdf2_chars=len((text or '').strip()))
            tab = ""
        if tab:
            if TRACE.enabled:
                TRACE.stage("ocr_bank_textract_forced",
                            old_chars=len(text or ""), new_chars=len(tab),
                            old_glued=glued_numbers_score(text or ""),
                            new_glued=glued_numbers_score(tab))
            text = tab
            try:  # refresh the cache so the chunk pass + any re-read use the good text
                from .doc_hash import sha256_file
            except ImportError:
                from doc_hash import sha256_file  # type: ignore
            try:
                cp = f"/tmp/text_cache/text_{sha256_file(doc_path)}.txt"
                os.makedirs(os.path.dirname(cp), exist_ok=True)
                with open(cp, "w", encoding="utf-8") as f:
                    f.write(tab)
            except Exception:
                pass

    # Always-on bank diagnostics (→ Render logs): the OCR header is what reveals the
    # exact labels a bank prints for company name / CUI / opening-closing balance, so
    # we can recover them deterministically. Dump the header + OCR stats here.
    if document_type == "Bank Statement":
        _bank_dbg(
            "ocr",
            chars=len(text or ""),
            page_markers=(text or "").count("=== PAGE"),
            glued_score=glued_numbers_score(text or ""),
        )
        _bank_dbg_block("ocr_header", text or "")

    # Debug trace: exactly what OCR text the model will receive. The glued-numbers
    # score + sample reveal whether the OCR merged columns / lost the amount column
    # (the suspected root cause for UniCredit/BRD). Full text → side file.
    if TRACE.enabled:
        try:
            TRACE.stage(
                "ocr_text",
                doc_type=document_type,
                char_count=len(text or ""),
                has_page_markers=bool(text and "=== PAGE" in text),
                glued_numbers=glued_numbers_score(text or ""),
                full_text_file=TRACE.dump_full("ocr", text),
                sample=TRACE.sample(text),
            )
        except Exception:
            pass

    # Photographed documents (JPG/PNG/HEIC uploads — phone snaps, WhatsApp
    # captures) are the case where OCR is least reliable: a low-contrast, skewed or
    # shadowed photo yields little/garbled Textract text, and a text-only pass then
    # returns an empty "Unknown / 0 / 01-01-2000" skeleton (the model is asked for
    # structured output with nothing to read). Always send the page image for image
    # inputs so the model reads the document directly, independent of the
    # FINOVA_VISION_EXTRACTION A/B flag. PDFs keep the flag-gated behaviour.
    is_image_doc = doc_path.lower().endswith(_IMAGE_EXTS)
    use_vision = force_vision or _vision_enabled() or is_image_doc
    # A bank statement with more pages than the vision cap (FINOVA_VISION_MAX_PAGES_BANK,
    # default 12) can only have a fraction of its pages imaged — the model then sees
    # 12 of 49 pages, so the image pass adds nothing for transaction extraction (the
    # per-page chunk pass does that on the full Textract text) while making the request
    # heavy enough that the model API returned a non-JSON error / timed out. Go
    # text-only: the column-preserving Textract text is what the model actually needs.
    if use_vision and document_type == "Bank Statement":
        _vision_bank_cap = int(os.getenv("FINOVA_VISION_MAX_PAGES_BANK", "12"))
        _pages = _pdf_page_count(doc_path)
        if _pages > _vision_bank_cap:
            use_vision = False
            print(
                f"⏭️  [phase1:Bank Statement] {_pages} pages > {_vision_bank_cap} vision cap — "
                f"text-only (Textract columns suffice; avoids the heavy partial-vision request)",
                file=sys.stderr,
            )
            _bank_dbg("vision_skipped", pages=_pages, vision_bank_cap=_vision_bank_cap)
    truncated = False
    try:
        data, meta = _run_phase1(doc_path, document_type, prompt, text, basename, use_vision)
    except TruncatedExtraction as e:
        # The single full-document pass overran max_tokens mid-JSON. Re-running it
        # (the caller's retry loop) just truncates again at the same row and burns
        # the wall-clock budget — that retry-storm is what surfaces to the user as
        # a timed-out, "processed but empty" document. A bank statement's long
        # transaction list is the realistic offender: seed an empty shell and
        # recover the rows via the chunked path below. Anything else re-raises to
        # the caller's existing retry (other types don't truncate at 8000 tokens).
        if document_type != "Bank Statement":
            raise
        truncated = True
        print(f"⚠️  {e} → recovering transactions via page-chunked extraction", file=sys.stderr)
        data = _seed_bank_statement_after_truncation(getattr(e, "partial", ""))
        meta = {"model": get_extraction_llm_model(), "vision": False, "truncated": True}

    # Confidence-gated escalation: a cheap text pass that left critical fields
    # empty gets one vision retry; keep it only if it recovered more. Skipped
    # after a truncation seed (there's no usable base pass to escalate).
    if not truncated and not use_vision and _escalation_enabled():
        empty = _empty_critical(document_type, data)
        if empty:
            print(
                f"🔬 [phase1:{document_type}] text pass left {empty} empty → escalating to vision",
                file=sys.stderr,
            )
            data_v, meta_v = _run_phase1(doc_path, document_type, prompt, text, basename, True)
            if meta_v.get("vision") and len(_empty_critical(document_type, data_v)) < len(empty):
                meta_v["escalated"] = True
                data, meta = data_v, meta_v

    # Chunk a bank statement ONLY when the base pass genuinely lost rows: it
    # truncated, OR chunking is enabled AND the base pass doesn't already reconcile.
    # A complete one-shot extraction (a long-context model that read every row)
    # reconciles to the printed closing balance — re-splitting + re-merging it just
    # duplicates rows (the 49-page UniCredit failure). When opening/closing aren't
    # both present we can't judge reconciliation, so we only chunk on real truncation.
    if document_type == "Bank Statement":
        try:
            from .bank_statement_recon import statement_reconciles
        except ImportError:
            from bank_statement_recon import statement_reconciles  # type: ignore
        if truncated or (_bank_chunking_enabled() and not statement_reconciles(data)):
            data, meta = _maybe_chunk_bank_transactions(
                prompt, text, basename, data, meta, force=truncated)

    # Drop bank control/summary rows (RULAJ ZI, SOLD FINAL, TOTAL CONT…) the model
    # mistook for transactions. Runs before recon/repair so neither the sign fix
    # nor the balance-continuity check sees the phantom rows.
    if document_type == "Bank Statement" and isinstance(data.get("transactions"), list):
        before = len(data["transactions"])
        data["transactions"] = _drop_summary_transactions(data["transactions"])
        dropped = before - len(data["transactions"])
        if dropped:
            meta["summary_rows_dropped"] = dropped
            print(f"🧹 [phase1:Bank Statement] dropped {dropped} control/summary row(s)",
                  file=sys.stderr)

    # Deterministic Banca Transilvania reconciliation: the printed control totals
    # (SOLD ANTERIOR / RULAJ ZI / SOLD FINAL CONT) fix the debit/credit signs the
    # linearized text strips of column position, anchor the closing balance, and
    # flag days that don't reconcile. No-ops on non-BT statements. Runs before the
    # repair pass so a recovered CUI/IBAN leaves the scoped repair nothing to do.
    if document_type == "Bank Statement":
        try:
            from .bank_statement_recon import reconcile_bt_statement
        except ImportError:
            from bank_statement_recon import reconcile_bt_statement  # type: ignore
        try:
            data, recon = reconcile_bt_statement(data, text)
            if recon.get("applied"):
                meta["bt_recon"] = recon
                print(
                    f"🧾 [phase1:Bank Statement] BT recon: closing→{recon.get('closing_balance')}, "
                    f"signs fixed={recon.get('signs_corrected')}, header={recon.get('header_fixed')}, "
                    f"days {recon.get('days_reconciled')}/{recon.get('days_total')} reconciled, "
                    f"flagged={recon.get('unreconciled_days')}",
                    file=sys.stderr,
                )
            if TRACE.enabled:
                TRACE.stage("transform:bt_recon", applied=recon.get("applied"),
                            report=recon, after=txn_summary(data))
        except Exception as e:  # reconciliation must never break extraction
            print(f"⚠️  BT reconciliation skipped ({type(e).__name__}: {e})", file=sys.stderr)

        # Generic header recovery (any bank): when the full-document pass truncated,
        # headers were seeded empty and the chunk pass only refilled transactions.
        # Recover account_number (IBAN), bank_name (from the IBAN code) and the
        # statement period (span of the transaction dates) from what's still in the
        # text/rows — the 49-page UniCredit case lost all of these.
        try:
            from .bank_statement_recon import recover_bank_header
        except ImportError:
            from bank_statement_recon import recover_bank_header  # type: ignore
        try:
            recovered = recover_bank_header(data, text)
            if recovered:
                meta["header_recovered"] = recovered
                print(f"🔎 [phase1:Bank Statement] header recovered: {recovered}", file=sys.stderr)
            if TRACE.enabled:
                TRACE.stage("transform:header_recover", recovered=recovered,
                            company_ein=data.get("company_ein"), bank_name=data.get("bank_name"),
                            account_number=data.get("account_number"))
        except Exception as e:
            print(f"⚠️  header recovery skipped ({type(e).__name__}: {e})", file=sys.stderr)

        # Drop a company_ein that's actually the BANK's own CUI (UniCredit prints
        # no holder CUI in the header, so the model grabs 361536 from the letterhead).
        # Showing the bank's CUI as the company's is worse than showing none.
        try:
            from .bank_statement_recon import strip_bank_own_company_ein
        except ImportError:
            from bank_statement_recon import strip_bank_own_company_ein  # type: ignore
        try:
            if strip_bank_own_company_ein(data, text):
                meta["bank_ein_stripped"] = True
                print("🧹 [phase1:Bank Statement] dropped bank's own CUI mistaken for company_ein",
                      file=sys.stderr)
        except Exception as e:
            print(f"⚠️  bank-ein strip skipped ({type(e).__name__}: {e})", file=sys.stderr)

    # Validator-guided repair: re-ask the model to fix arithmetic/checksum
    # failures the deterministic validators caught. FINOVA_REPAIR_SCOPED narrows
    # it to checksum/format checks only and enables the pass on its own.
    if _repair_enabled() or _repair_scoped_enabled():
        data, meta = _maybe_repair(
            doc_path, document_type, prompt, text, basename, data, meta,
            inputs.get("current_date"),
        )

    # Deterministic output conventions, applied last so they are the final word
    # (and so the eval — which calls extract_document directly — sees exactly what
    # production persists).
    #  • Bank transactions: debit/credit are positive magnitudes (the column is the
    #    direction). Normalizes non-BT statements too, where bank_statement_recon
    #    doesn't fire (e.g. the UniCredit debits-as-negative case).
    if document_type == "Bank Statement" and isinstance(data.get("transactions"), list):
        _force_positive_transaction_amounts(data["transactions"])
        # Printed account-summary control totals (UniCredit "SUMAR CONT": Sold
        # inițial / final + Sume debitate / creditate). These are ground truth, so:
        #  (1) anchor opening/closing authoritatively, and
        #  (2) repair debit/credit DIRECTIONS the OCR column-gluing destroyed — the
        #      model flips some "Fee/Amount" (debit) rows to credit; we pick the
        #      Amount/Fee→direction mapping that reproduces BOTH printed totals.
        # All deterministic and self-validating (direction repair only applies when
        # it makes Σdebit/Σcredit match the statement).
        try:
            from .bank_statement_recon import (parse_account_summary_totals,
                                               repair_directions_from_control_totals)
        except ImportError:
            from bank_statement_recon import (parse_account_summary_totals,  # type: ignore
                                              repair_directions_from_control_totals)
        try:
            totals = parse_account_summary_totals(text)
            o, c = totals.get("opening"), totals.get("closing")
            td, tc = totals.get("total_debit"), totals.get("total_credit")
            # Trust the summary ONLY when all four values are present AND
            # self-consistent (opening + Σcredit − Σdebit = closing). That signals a
            # complete SUMAR CONT block (UniCredit) — not a stray per-day "Sold final"
            # that would clobber a correct model value on a statement like BRD.
            coherent = (None not in (o, c, td, tc)) and abs(o + tc - td - c) <= 0.5
            _bank_dbg("control_totals", coherent=coherent, **totals)
            if coherent:
                data["opening_balance"] = o
                data["closing_balance"] = c
                data["_control_totals"] = {"debit": td, "credit": tc}
                rep = repair_directions_from_control_totals(data, td, tc)
                _bank_dbg("direction_repair", **rep)
                if rep.get("applied"):
                    meta["direction_repair"] = rep
                    print(
                        f"🔧 [phase1:Bank Statement] direction repair via control totals: "
                        f"flipped {rep['flips']} row(s) (Amount→{rep['amount_dir']}, "
                        f"Fee/Amount→{rep['fee_dir']})",
                        file=sys.stderr,
                    )
        except Exception as e:  # control-total repair must never break extraction
            print(f"⚠️  control-total repair skipped ({type(e).__name__}: {e})", file=sys.stderr)
        # Opening/closing-balance recovery: the truncated full-document pass seeds the
        # header balances at 0 and the chunk pass only refills rows (BRD RO95: 52 rows
        # recovered, opening/closing both 0 → reconciliation can't run). Recover them
        # from the printed running-balance endpoints before the chain check so
        # _balance_reconciled and the closing-balance validator reflect the real ledger.
        try:
            from .bank_statement_recon import recover_balances_from_chain
        except ImportError:
            from bank_statement_recon import recover_balances_from_chain  # type: ignore
        try:
            bal_fixed = recover_balances_from_chain(data)
            if bal_fixed:
                meta["balances_recovered"] = bal_fixed
                print(
                    f"💰 [phase1:Bank Statement] balances recovered from chain: {bal_fixed} "
                    f"(opening={data.get('opening_balance')}, closing={data.get('closing_balance')})",
                    file=sys.stderr,
                )
        except Exception as e:  # recovery must never break extraction
            print(f"⚠️  balance recovery skipped ({type(e).__name__}: {e})", file=sys.stderr)
        # Fallback: when the running-balance column was never read (e.g. UniCredit
        # prints no per-row balance → chain recovery can't fire), parse opening/closing
        # from the printed "Sold initial/final" labels in the OCR text. Apply ONLY if
        # they make the statement reconcile (a label can sit next to a date the regex
        # might grab) — but ALWAYS log what was parsed, so an un-applied parse still
        # tells us whether the balance is even present in the OCR.
        try:
            from .bank_statement_recon import parse_statement_balances_from_text, statement_sum_gap
        except ImportError:
            from bank_statement_recon import parse_statement_balances_from_text, statement_sum_gap  # type: ignore
        try:
            need_bal = (not data.get("opening_balance")) or (not data.get("closing_balance"))
            parsed = parse_statement_balances_from_text(text)
            _bank_dbg("balances_from_text", need=need_bal,
                      cur_opening=data.get("opening_balance"), cur_closing=data.get("closing_balance"),
                      **parsed)
            if need_bal and parsed.get("opening") is not None and parsed.get("closing") is not None:
                trial = dict(data)
                trial["opening_balance"] = parsed["opening"]
                trial["closing_balance"] = parsed["closing"]
                gap = statement_sum_gap(trial)
                if gap is not None and gap <= 0.5:
                    data["opening_balance"] = parsed["opening"]
                    data["closing_balance"] = parsed["closing"]
                    meta["balances_from_text"] = parsed
                    print(
                        f"💰 [phase1:Bank Statement] balances from text labels "
                        f"({parsed.get('opening_label')}/{parsed.get('closing_label')}): "
                        f"opening={parsed['opening']}, closing={parsed['closing']} (gap={gap})",
                        file=sys.stderr,
                    )
                else:
                    _bank_dbg("balances_from_text_rejected", gap=gap,
                              reason="parsed balances do not reconcile with rows")
        except Exception as e:
            print(f"⚠️  text balance recovery skipped ({type(e).__name__}: {e})", file=sys.stderr)
        # Balance-chain reconciliation: drop phantom/duplicate rows via the printed
        # running balance, and flag whether the statement reconciles so downstream
        # can withhold auto-accept on a statement whose rows don't sum to its closing
        # balance (wrong bank rows = wrong books).
        try:
            from .bank_statement_recon import reconcile_balance_chain
        except ImportError:
            from bank_statement_recon import reconcile_balance_chain  # type: ignore
        try:
            data, _chain = reconcile_balance_chain(data)
            data["_balance_reconciled"] = bool(_chain.get("reconciled"))
            if _chain.get("applied") or not _chain.get("reconciled", True):
                meta["balance_chain"] = _chain
                print(
                    f"⚖️  [phase1:Bank Statement] balance-chain: dropped "
                    f"{_chain.get('dropped', 0)} phantom row(s), {_chain.get('breaks', 0)} "
                    f"unexplained jump(s), reconciled={_chain.get('reconciled')}",
                    file=sys.stderr,
                )
            if TRACE.enabled:
                TRACE.stage("transform:balance_chain", report=_chain,
                            balance_reconciled=data.get("_balance_reconciled"),
                            after=txn_summary(data))
        except Exception as e:  # reconciliation must never break extraction
            print(f"⚠️  balance-chain skipped ({type(e).__name__}: {e})", file=sys.stderr)

        # Final bank diagnostic: the whole picture on one line — what was extracted vs
        # recovered, and whether it reconciles. This is the line to read first when a
        # bank statement comes out wrong.
        try:
            _summ = txn_summary(data)
            _bank_dbg(
                "final",
                company_name=data.get("company_name"),
                company_ein=data.get("company_ein"),
                bank=data.get("bank_name"),
                account=data.get("account_number"),
                period=f"{data.get('statement_period_start')}..{data.get('statement_period_end')}",
                opening=data.get("opening_balance"),
                closing=data.get("closing_balance"),
                txns=_summ.get("txns"),
                sum_debit=_summ.get("sum_debit"),
                sum_credit=_summ.get("sum_credit"),
                nonzero_balances=sum(
                    1 for t in data["transactions"]
                    if isinstance(t, dict) and t.get("balance_after_transaction")
                ),
                recon_gap=_summ.get("recon_gap"),
                reconciled=data.get("_balance_reconciled"),
                header_recovered=meta.get("header_recovered"),
                balances_recovered=meta.get("balances_recovered") or list((meta.get("balances_from_text") or {}).keys()) or None,
                truncated=meta.get("truncated"),
                chunked=meta.get("txn_rows_chunked"),
            )
        except Exception:
            pass
    #  • Line items: rewrite gross line totals to NET so `total + vat_amount`
    #    reproduces the printed gross. Idempotent + conservative; mirrors the
    #    catch-all at main.py (which still covers the legacy CrewAI path).
    if isinstance(data.get("line_items"), list):
        try:
            try:
                import validators as _validators
            except ImportError:
                from . import validators as _validators  # type: ignore
            # Relabel any mislabelled per-line VAT rate from its printed amount BEFORE
            # net-normalization (which strips to net using that rate).
            _validators.reconcile_line_item_vat_rates(data)
            _validators.normalize_line_items_to_net(data)
            # Repair a fuel quantity↔unit_price swap (needs net `total`, so run last).
            _validators.reconcile_fuel_quantity_unit_swap(data)
        except Exception as e:
            print(f"⚠️  net-normalization skipped ({type(e).__name__}: {e})", file=sys.stderr)

    #  • Reverse charge (taxare inversă): set the boolean the downstream 4426=4427
    #    self-assessment posting reads. Explicit text/VAT-key evidence overrides the model.
    if document_type == "Invoice" and isinstance(data, dict):
        try:
            data["reverse_charge"] = _detect_reverse_charge(text, data)
        except Exception as e:
            print(f"⚠️  reverse-charge detection skipped ({type(e).__name__}: {e})", file=sys.stderr)

    # Debug trace: the FINAL state after all deterministic transforms — compare to
    # the `model_raw` stage to see exactly what post-processing changed.
    if TRACE.enabled and document_type == "Bank Statement":
        try:
            TRACE.stage("final", meta_flags={k: meta.get(k) for k in
                        ("bank_chunked", "header_recovered", "bt_recon", "balance_chain") if k in meta},
                        summary=txn_summary(data))
        except Exception:
            pass

    return data, meta
