"""
Centralized OpenAI model configuration for the data-extraction pipeline.

Defaults are pinned to specific snapshots so behavior doesn't drift when OpenAI
rolls a new revision of a moving alias like `gpt-4o-mini`. Override per
environment via env vars when validating a new snapshot:

  FINOVA_EXTRACTION_LLM_MODEL   chat model used for extraction & categorization
  FINOVA_EMBEDDING_MODEL        embedding model used for RAG account selection

For a financial-data pipeline whose output goes into bookkeeping records,
unpinned moving aliases are an audit risk. Bump these defaults deliberately
after validating the new snapshot against a regression set.
"""

import os

# Pinned snapshot of gpt-4o-mini (original public release snapshot).
# Bump deliberately after validating a newer snapshot.
DEFAULT_EXTRACTION_LLM_MODEL = "gpt-4o-mini-2024-07-18"

# text-embedding-3-small is a stable identifier (no public snapshot suffix).
# Override only if migrating to a different embedding model entirely.
DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"


def get_extraction_llm_model() -> str:
    return os.getenv("FINOVA_EXTRACTION_LLM_MODEL", DEFAULT_EXTRACTION_LLM_MODEL)


def get_embedding_model() -> str:
    return os.getenv("FINOVA_EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL)


# ---------------------------------------------------------------------------
# Per-task completion-token budgets (task 10)
# ---------------------------------------------------------------------------
#
# One global max_tokens=8000 was sized for the worst case (invoices with ~29
# line items) and applied to every call, including ~100-token categorization.
# These per-task caps are sized to each document type's realistic worst case.
# Tune from the extraction metrics' p95 completion_tokens (see metrics_report).
# Each is overridable via FINOVA_MAXTOK_<TASK> for ops-time adjustment without
# a deploy.

CATEGORIZATION_MAX_TOKENS = 300

# Generous defaults for the variable-length document types; tighter for the
# small fixed-shape forms.
_DEFAULT_EXTRACTION_MAX_TOKENS = {
    "Invoice": 8000,            # invoices with many line items
    "Receipt": 4000,
    "Bank Statement": 8000,     # many transactions
    "Contract": 3000,
    "Z Report": 2000,
    "Payment Disposition": 1000,
    "Collection Disposition": 1000,
    "CMR": 2500,
    "Customs Declaration": 2500,
    "Vehicle Registration Certificate": 2500,
    "Technical Inspection (ITP)": 1500,
    "Insurance": 1500,
    "Other": 1200,
}

# Fallback when a document type isn't in the table.
DEFAULT_MAX_TOKENS = 8000


def _env_key(document_type: str) -> str:
    return "FINOVA_MAXTOK_" + document_type.upper().replace(" ", "_")


def get_categorization_max_tokens() -> int:
    return int(os.getenv("FINOVA_MAXTOK_CATEGORIZATION", CATEGORIZATION_MAX_TOKENS))


# Batch-scan segmentation emits ~35 tokens per segment; 2000 covers the
# 40-page worst case (40 single-page docs) with headroom.
SEGMENTATION_MAX_TOKENS = 2000


def get_segmentation_max_tokens() -> int:
    return int(os.getenv("FINOVA_MAXTOK_SEGMENTATION", SEGMENTATION_MAX_TOKENS))


def get_segmentation_llm_model() -> str:
    """Model for the batch-scan boundary detector. Defaults to the extraction
    model (must be vision-capable — batch scans are usually image-only PDFs);
    FINOVA_SEGMENT_LLM_MODEL overrides just the segmenter."""
    return os.getenv("FINOVA_SEGMENT_LLM_MODEL", get_extraction_llm_model())


def get_extraction_max_tokens(document_type: str) -> int:
    """Per-task completion-token budget, env-overridable per document type."""
    default = _DEFAULT_EXTRACTION_MAX_TOKENS.get(document_type, DEFAULT_MAX_TOKENS)
    return int(os.getenv(_env_key(document_type), default))
