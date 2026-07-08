"""AutoImport extraction worker.

Invoked by the NestJS extraction module as a subprocess:

    python3 main.py extract <file> --content-type application/pdf

Optional stdin: JSON with {"past_corrections": [...]} used as RAG context.
Prints exactly one JSON object on the last stdout line:

    {ok, document_type, type_confidence, fields, field_confidence,
     validation_issues, needs_review}  |  {ok: false, error}
"""
import argparse
import json
import os
import sys

REVIEW_CONFIDENCE_FLOOR = 0.7


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["extract", "categorize"])
    parser.add_argument("file")
    parser.add_argument("--content-type", default="application/pdf")
    args = parser.parse_args()

    if not os.environ.get("ANTHROPIC_API_KEY"):
        emit({"ok": False, "error": "ANTHROPIC_API_KEY is not configured — extraction disabled"})
        return 1
    if not os.path.isfile(args.file):
        emit({"ok": False, "error": f"file not found: {args.file}"})
        return 1

    corrections_context = None
    if not sys.stdin.isatty():
        raw = sys.stdin.read().strip()
        if raw:
            try:
                corrections_context = json.dumps(json.loads(raw).get("past_corrections", []), ensure_ascii=False)
            except json.JSONDecodeError:
                corrections_context = None

    try:
        result = run_pipeline(args.file, args.content_type, corrections_context, categorize_only=args.mode == "categorize")
        emit(result)
        return 0
    except Exception as exc:  # noqa: BLE001 — the contract is a JSON error, never a traceback on stdout
        emit({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        return 1


def run_pipeline(path: str, content_type: str, corrections_context, categorize_only: bool = False) -> dict:
    from llm import structured_call
    from ocr import extract_text
    from schemas import Categorization, envelope_for
    from validators import validate

    ocr = extract_text(path, content_type)
    text = ocr.text
    use_vision = text is None or len(text) < 100

    # Phase 0 — categorization
    categorization = structured_call(
        Categorization,
        "Classify this document. For invoices also decide direction: 'incoming' if the dealership "
        "is the customer (purchase), 'outgoing' if it issued the invoice (sale).",
        text=None if use_vision else text,
        file_path=path if use_vision else None,
        content_type=content_type if use_vision else None,
    )

    if categorize_only:
        return {
            "ok": True,
            "document_type": categorization.document_type,
            "type_confidence": categorization.confidence,
            "fields": {},
            "field_confidence": {},
            "validation_issues": [],
            "needs_review": categorization.confidence < REVIEW_CONFIDENCE_FLOOR,
            "ocr_source": ocr.source,
        }

    # Phase 1 — typed extraction with the schema registered for the type
    envelope = structured_call(
        envelope_for(categorization.document_type),
        f"Extract all fields for this {categorization.document_type}. "
        "Report a per-field confidence for every field you filled in.",
        text=None if use_vision else text,
        file_path=path if use_vision else None,
        content_type=content_type if use_vision else None,
        extra_context=corrections_context,
    )

    fields = envelope.fields.model_dump()
    field_confidence = {c.field: c.confidence for c in envelope.confidences}

    issues = validate(categorization.document_type, fields)
    # A field with a failed validator is never left "high confidence".
    for issue in issues:
        field = issue["field"]
        field_confidence[field] = min(field_confidence.get(field, 1.0), 0.4)

    low_confidence = any(v < REVIEW_CONFIDENCE_FLOOR for v in field_confidence.values())
    needs_review = bool(issues) or low_confidence or categorization.confidence < REVIEW_CONFIDENCE_FLOOR

    return {
        "ok": True,
        "document_type": categorization.document_type,
        "direction": categorization.direction,
        "type_confidence": categorization.confidence,
        "fields": fields,
        "field_confidence": field_confidence,
        "validation_issues": issues,
        "needs_review": needs_review,
        "ocr_source": ocr.source,
    }


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False, default=str))


if __name__ == "__main__":
    sys.exit(main())
