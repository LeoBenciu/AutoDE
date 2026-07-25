"""
Shared prompt fragments (task 9).

Blocks that were duplicated near-verbatim across several task prompts in
tasks.yaml live here once. The YAML references them as {FRAGMENT_NAME}
placeholders; both extraction paths resolve them through the normal input
interpolation (see inject_fragments / direct_extraction._format_prompt).

Single source of truth → no drift when one copy is edited, and ~500-1000 fewer
tokens per call now that the structured-output schema already enforces the
enums (currency, VAT rate, units) the prompts used to spell out in prose.
"""

# Per-field confidence calibration. The schema already requires the confidence
# object and names its fields; this only conveys *how* to calibrate. (Note:
# deterministic validators override these values where a structural check fires
# — see validators.py.)
CONFIDENCE_CALIBRATION = (
    "PER-FIELD CONFIDENCE: For each field in the confidence object, use ≥0.9 "
    "only when the value is unambiguous and clearly present on the document; "
    "0.7–0.89 when inferred or partially obscured; <0.7 when uncertain or "
    "reconstructed."
)

# How to map a detected VAT percentage to the schema enum.
VAT_RATE_MAPPING = (
    "VAT RATE: map the detected percentage to the enum — "
    "0%→ZERO, 5%→FIVE, 9%→NINE, 11%→ELEVEN, 19%→NINETEEN, 21%→TWENTYONE."
)

# Account-code selection hierarchy, shared by invoice/receipt/disposition tasks.
# Deliberately self-contained (no nested {relevant_accounts} placeholder) so a
# single interpolation pass resolves it; the task prompt prints the account
# shortlist separately right before this fragment.
ACCOUNT_HIERARCHY = (
    "ACCOUNT SELECTION: match each item to the MOST SPECIFIC applicable account "
    "from the relevant accounts listed above. Hierarchy: Exact → Specific → "
    "Generic (628/629 only as a last resort)."
)

# Date format directive.
DATE_FORMAT = "All dates use DD-MM-YYYY format."


FRAGMENTS = {
    "CONFIDENCE_CALIBRATION": CONFIDENCE_CALIBRATION,
    "VAT_RATE_MAPPING": VAT_RATE_MAPPING,
    "ACCOUNT_HIERARCHY": ACCOUNT_HIERARCHY,
    "DATE_FORMAT": DATE_FORMAT,
}


def inject_fragments(inputs: dict) -> dict:
    """Return `inputs` with fragment placeholders added as defaults.

    Real inputs win over fragments (a fragment never overrides a caller value).
    Note ACCOUNT_HIERARCHY itself contains `{relevant_accounts}`; it is resolved
    in a second pass by the caller's interpolation since that key is also in
    inputs.
    """
    for key, value in FRAGMENTS.items():
        inputs.setdefault(key, value)
    return inputs
