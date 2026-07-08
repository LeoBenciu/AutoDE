"""Claude calls with structured outputs (strict Pydantic schemas).

Text-first: when OCR produced a usable text layer we send text (cheap);
otherwise the original file goes to Claude as a vision/PDF input. Model is
configurable via EXTRACTION_MODEL (claude-opus-4-8 default; claude-sonnet-4-6
for cost-sensitive high volume).
"""
import base64
import os
from typing import Optional, Type, TypeVar

from pydantic import BaseModel

MODEL = os.environ.get("EXTRACTION_MODEL", "claude-opus-4-8")
MAX_TOKENS = 16000

T = TypeVar("T", bound=BaseModel)

_client = None


def get_client():
    global _client
    if _client is None:
        import anthropic

        _client = anthropic.Anthropic()
    return _client


def _file_block(path: str, content_type: str) -> dict:
    with open(path, "rb") as fh:
        data = base64.standard_b64encode(fh.read()).decode("utf-8")
    if content_type == "application/pdf":
        return {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": data}}
    if content_type in ("image/png", "image/jpeg", "image/gif", "image/webp"):
        return {"type": "image", "source": {"type": "base64", "media_type": content_type, "data": data}}
    raise ValueError(f"Unsupported content type for vision input: {content_type}")


def structured_call(
    schema: Type[T],
    instruction: str,
    text: Optional[str] = None,
    file_path: Optional[str] = None,
    content_type: Optional[str] = None,
    extra_context: Optional[str] = None,
) -> T:
    content: list = []
    if text:
        content.append({"type": "text", "text": f"<document_text>\n{text[:150000]}\n</document_text>"})
    elif file_path and content_type:
        content.append(_file_block(file_path, content_type))
    if extra_context:
        content.append({
            "type": "text",
            "text": (
                "<past_corrections>\nCorrections users made on similar documents from this "
                f"dealership (learn from them):\n{extra_context}\n</past_corrections>"
            ),
        })
    content.append({"type": "text", "text": instruction})

    client = get_client()
    response = client.messages.parse(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        system=(
            "You are a document data extraction engine for a Romanian used-car import dealership. "
            "Documents may be in Romanian, German, French, Dutch or English. "
            "Extract exactly what the document says; use null for absent fields, never guess. "
            "Dates are ISO YYYY-MM-DD. Amount convention: line totals are NET (without VAT); "
            "gross total = net + VAT. Confidences are honest estimates in [0,1]."
        ),
        messages=[{"role": "user", "content": content}],
        output_format=schema,
    )
    parsed = response.parsed_output
    if parsed is None:
        raise RuntimeError("model returned no parseable structured output")
    return parsed
