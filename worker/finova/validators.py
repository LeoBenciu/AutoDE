"""
Deterministic structural validators (task 7).

LLM self-reported confidence (the `_confidence` object the prompts ask for) is
poorly calibrated — models happily report 0.95 on hallucinated values. This
module computes *deterministic* per-field confidence from checks that can't be
faked: Romanian CUI checksum, IBAN mod-97, VAT arithmetic, line-item sums, and
date plausibility.

`validate_extraction(document_type, data, current_date)` returns:
    {
      "checks": [ {field, rule, passed, detail}, ... ],
      "field_confidence": { field: 0.0..1.0 },   # only fields a check covers
      "overall_score": 0.0..1.0,
    }

`merge_confidence(model_confidence, field_confidence)` blends the two: use the
deterministic value where a validator fired, fall back to the model's estimate
otherwise. The result is what the UI should use for auto-accept thresholds.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Dict, List, Optional

# VAT rate enum (matches schemas.VatRate) → numeric percent.
VAT_RATE_PCT = {
    "ZERO": 0.0,
    "FIVE": 5.0,
    "NINE": 9.0,
    "ELEVEN": 11.0,
    "NINETEEN": 19.0,
    "TWENTYONE": 21.0,
}

# Money comparison tolerance: 2 bani absolute, or 1% relative (rounding noise).
def _money_close(a: float, b: float) -> bool:
    return abs(a - b) <= max(0.02, 0.01 * max(abs(a), abs(b)))


# ---------------------------------------------------------------------------
# Romanian CUI/CIF checksum
# ---------------------------------------------------------------------------

_CUI_KEY = [7, 5, 3, 2, 1, 7, 5, 3, 2]  # control key, right-aligned


def valid_cui(ein: Any) -> Optional[bool]:
    """Validate a Romanian CUI/CIF check digit.

    Returns True/False, or None if the value isn't checkable (empty/non-numeric
    or out of the 2..10 digit range) — None means "no opinion", not "invalid".
    """
    if ein is None:
        return None
    raw = str(ein).upper().replace(" ", "").strip()
    # Foreign VAT IDs carry a non-RO ISO country prefix (DE…, HU…, FR…). The RO
    # checksum doesn't apply to them, so return None ("no opinion") rather than
    # failing a perfectly valid foreign id and triggering needless scoped-repair.
    if len(raw) >= 2 and raw[:2].isalpha() and raw[:2] != "RO":
        return None
    if raw.startswith("RO"):
        raw = raw[2:]
    digits = "".join(ch for ch in raw if ch.isdigit())
    if not digits or not (2 <= len(digits) <= 10):
        return None
    body, control = digits[:-1], int(digits[-1])
    nums = [int(c) for c in body]
    key = _CUI_KEY[-len(nums):] if len(nums) <= len(_CUI_KEY) else ([0] * (len(nums) - len(_CUI_KEY)) + _CUI_KEY)
    total = sum(n * k for n, k in zip(nums, key))
    check = (total * 10) % 11
    if check == 10:
        check = 0
    return check == control


# ---------------------------------------------------------------------------
# IBAN mod-97 (ISO 13616)
# ---------------------------------------------------------------------------

def valid_iban(iban: Any) -> Optional[bool]:
    """Validate an IBAN via mod-97. None if not IBAN-shaped (no opinion)."""
    if iban is None:
        return None
    s = str(iban).replace(" ", "").upper()
    if len(s) < 15 or len(s) > 34 or not s[:2].isalpha() or not s[2:4].isdigit():
        return None
    rearranged = s[4:] + s[:4]
    digits = ""
    for ch in rearranged:
        if ch.isdigit():
            digits += ch
        elif ch.isalpha():
            digits += str(ord(ch) - 55)  # A=10 .. Z=35
        else:
            return None
    try:
        return int(digits) % 97 == 1
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Vehicle identification number (ISO 3779 shape)
# ---------------------------------------------------------------------------

_VIN_RE = re.compile(r"^[A-HJ-NPR-Z0-9]{17}$")


def valid_vin(vin: Any) -> Optional[bool]:
    """Validate VIN length/alphabet. The check digit is not mandatory outside
    North America, so it is deliberately not treated as a universal hard rule."""
    if vin is None or str(vin).strip() == "":
        return None
    return bool(_VIN_RE.fullmatch(str(vin).strip().upper()))


# ---------------------------------------------------------------------------
# Date plausibility
# ---------------------------------------------------------------------------

def valid_date(value: Any, current_date: Optional[str] = None) -> Optional[bool]:
    """Validate DD-MM-YYYY and that it's not in the future. None if absent."""
    if not value:
        return None
    try:
        d = datetime.strptime(str(value), "%d-%m-%Y")
    except ValueError:
        return False
    if current_date:
        today: Optional[datetime] = None
        for fmt in ("%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d"):
            try:
                today = datetime.strptime(current_date, fmt)
                break
            except ValueError:
                continue
        # If current_date is in an unrecognised format, fall back to the system
        # clock rather than silently passing — otherwise future dates slip through.
        if today is None:
            today = datetime.now()
        return d <= today
    return True


def valid_date_format(value: Any) -> Optional[bool]:
    """Validate DD-MM-YYYY without rejecting legitimate future expiries."""
    if not value:
        return None
    try:
        datetime.strptime(str(value), "%d-%m-%Y")
        return True
    except ValueError:
        return False


# ---------------------------------------------------------------------------
# VAT arithmetic + line-item sums
# ---------------------------------------------------------------------------

def _check_line_item_vat(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    checks: List[Dict[str, Any]] = []
    for i, it in enumerate(items or []):
        rate = VAT_RATE_PCT.get(it.get("vat"))
        line_total = _num(it.get("total"))
        vat = _num(it.get("vat_amount"))
        if rate is None or line_total is None or vat is None:
            continue
        if rate == 0:
            passed = _money_close(0.0, vat)
            detail = f"expected 0.00, got {vat:.2f} (rate 0%)"
        else:
            # `total` may be net (VAT-exclusive) or gross (VAT-inclusive): the
            # extractor and the UI both use either convention (e.g. a 280 RON
            # receipt whose VAT is already inside the 280). Accept the line if
            # vat_amount reproduces under either reading so a gross line total
            # isn't flagged as if VAT were missing or wrong.
            vat_if_net = line_total * rate / 100.0
            vat_if_gross = line_total * rate / (100.0 + rate)
            passed = _money_close(vat_if_net, vat) or _money_close(vat_if_gross, vat)
            detail = f"got {vat:.2f}; net→{vat_if_net:.2f} or gross→{vat_if_gross:.2f} (rate {rate}%)"
        checks.append({
            "field": f"line_items[{i}].vat_amount",
            "rule": "vat = total * rate (total net or gross)",
            "passed": passed,
            "detail": detail,
        })
    return checks


def _check_line_item_arithmetic(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Per-line sanity: quantity × unit_price ≈ total (net or gross, same basis).

    Flags a line where the printed value doesn't reconcile with quantity×price —
    typically an OCR misread of one of the three numbers, e.g. a fuel bon where the
    litres and lei/litre got mangled. Confidence signal ONLY: this rule is
    deliberately kept out of the scoped-repair whitelist so it can't rewrite line
    items to chase internal consistency (the failure mode behind the −2.9% naive
    repair). It also can't catch a pure quantity/unit_price SWAP — the product is
    unchanged — which the fuel-bon prompt guidance handles instead.
    """
    checks: List[Dict[str, Any]] = []
    for i, it in enumerate(items or []):
        qty = _num(it.get("quantity"))
        unit = _num(it.get("unit_price"))
        total = _num(it.get("total"))
        if qty is None or unit is None or total is None or qty == 0 or unit == 0:
            continue  # zero/absent rows (free items, sub-totals) carry no signal
        passed = _money_close(qty * unit, total)
        checks.append({
            "field": f"line_items[{i}].total",
            "rule": "quantity * unit_price = total",
            "passed": passed,
            "detail": f"{qty} * {unit} = {qty * unit:.2f}, total={total:.2f}",
        })
    return checks


def _num(v: Any) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# Plausible Romanian fuel price band (lei per litre). Pump prices sit ~5–12 lei/L
# gross; the NET cap below is deliberately generous — no real fuel, premium incl.,
# comes near it. A per-litre fuel line whose unit_price exceeds it is almost always
# the LITRES value mislabelled as price — the quantity↔unit_price swap seen on
# price-first thermal bons (e.g. MOL's "9,69 x47,53 L" → 9.69 lei/L × 47.53 L, which
# the model reads as quantity=9.69 then back-solves unit_price to fit, so the
# quantity×unit_price check still passes and hides the swap). Detection ONLY — never
# a rewrite: recovering the true litres needs the net/gross basis of the swapped
# number, which isn't reliably knowable post-hoc.
_FUEL_NAME_HINTS = ("motorin", "benzin", "diesel", "gpl", "carburant", "combustibil")
_FUEL_UNIT_PRICE_MAX = 25.0


def _looks_like_fuel(it: Dict[str, Any]) -> bool:
    name = str(it.get("name") or it.get("description") or "").lower()
    if any(h in name for h in _FUEL_NAME_HINTS):
        return True
    return str(it.get("type") or "").upper() == "COMBUSTIBILI"


def _check_fuel_unit_price_plausible(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Flag a per-litre fuel line whose unit_price is impossibly high — the tell-tale
    of a quantity↔unit_price swap the arithmetic check can't catch. Confidence signal
    backstop for any swap that :func:`reconcile_fuel_quantity_unit_swap` could not
    safely auto-repair (routes the line to review)."""
    checks: List[Dict[str, Any]] = []
    for i, it in enumerate(items or []):
        if not isinstance(it, dict) or not _looks_like_fuel(it):
            continue
        if str(it.get("um") or "").upper() not in ("LITRU", "LITRI", "L"):
            continue
        unit = _num(it.get("unit_price"))
        if unit is None or unit <= 0:
            continue
        checks.append({
            "field": f"line_items[{i}].unit_price",
            "rule": "fuel unit_price plausible (lei/litre)",
            "passed": abs(unit) <= _FUEL_UNIT_PRICE_MAX,
            "detail": f"{abs(unit):.2f} lei/L (max {_FUEL_UNIT_PRICE_MAX:.0f}; over ⇒ likely quantity↔unit_price swap)",
        })
    return checks


def reconcile_fuel_quantity_unit_swap(data: Dict[str, Any]) -> Dict[str, Any]:
    """Repair a fuel line whose quantity and unit_price are transposed.

    Price-first thermal bons (e.g. MOL "9,69 x47,53 L" = 9.69 lei/L × 47.53 L) are
    routinely mis-read as quantity=9.69 (the price) with unit_price back-solved to fit,
    so ``quantity × unit_price ≈ total`` still PASSES and hides the swap. The tell is an
    impossible per-litre price: no Romanian fuel exceeds ~15 lei/L, so a fuel-litre line
    whose unit_price sits far above that has litres and price transposed.

    Recovery is fully determined for fuel because the pump price is GROSS (VAT-inside) —
    the misplaced 'quantity' value IS the gross lei/litre, so::

        real_quantity   = gross_line / misplaced_price   (gross_line = total + vat_amount)
        real_unit_price = total / real_quantity            (NET, to match `total`)

    `total`/`vat_amount` are already correct (only qty↔price moved) and are left intact.
    Must run AFTER :func:`normalize_line_items_to_net` so ``total`` is reliably net.
    Conservative + idempotent: fires only when unit_price is physically impossible AND
    the 'quantity' value is itself a plausible price AND the recovered price lands back
    in the plausible band; otherwise leaves the line for the review backstop.

    Mutates and returns ``data``.
    """
    items = data.get("line_items")
    if not isinstance(items, list):
        return data
    for it in items:
        if not isinstance(it, dict) or not _looks_like_fuel(it):
            continue
        if str(it.get("um") or "").upper() not in ("LITRU", "LITRI", "L"):
            continue
        q = _num(it.get("quantity"))
        u = _num(it.get("unit_price"))
        t = _num(it.get("total"))
        vat = _num(it.get("vat_amount")) or 0.0
        # Only positive single-sided fuel lines; skip credit notes / unusable rows.
        if q is None or u is None or t is None or t <= 0:
            continue
        # Swap signature: impossible price, with the 'quantity' value itself a plausible price.
        if u <= _FUEL_UNIT_PRICE_MAX or not (0 < q <= _FUEL_UNIT_PRICE_MAX):
            continue
        gross_line = t + abs(vat)
        if gross_line <= 0:
            continue
        real_qty = round(gross_line / q, 2)
        if real_qty <= 0:
            continue
        real_unit = round(t / real_qty, 4)
        # Accept only if the recovered price is now physically plausible for fuel.
        if real_unit <= 0 or real_unit > _FUEL_UNIT_PRICE_MAX:
            continue
        it["quantity"] = real_qty
        it["unit_price"] = real_unit
    return data


def enforce_receipt_line_accounts(data: Dict[str, Any]) -> Dict[str, Any]:
    """Apply accounting facts that are unambiguous on ordinary fiscal receipts.

    Fuel is account 6022 regardless of whether the model guessed that it might be
    related to a vehicle. Vehicle ownership is business context that cannot be
    inferred from the receipt itself and is selected separately by the user, so an
    extractor-produced vehicle category must not turn a general expense into a
    landed-cost document.

    Mutates and returns ``data``.
    """
    items = data.get("line_items")
    if not isinstance(items, list):
        return data
    for it in items:
        if not isinstance(it, dict):
            continue
        # Extraction cannot know which stock vehicle (if any) incurred a receipt.
        # Association and landed-cost categorization are explicit UI decisions.
        it["vehicle_cost_category"] = None
        if not _looks_like_fuel(it):
            continue
        it["account_code"] = "6022"
        it["vat_deductibility"] = "PARTIAL_50"
    return data


def _receipt_cui_candidates(document_text: str) -> List[tuple[int, str]]:
    """Return checksum-valid Romanian CUIs with their positions in receipt OCR."""
    text = document_text or ""
    # Thermal-print OCR routinely confuses 0/O, 1/I/L, 5/S and 8/B. Accept those
    # glyphs in a CUI-shaped token, normalize them, then let the Romanian checksum
    # decide whether the result is real. This recovers e.g. R0112O189I → 11201891
    # without weakening validation.
    cui_chars = r"[0-9OILSB]"
    patterns = (
        # Normal printed form: RO11201891 (OCR may mistake O for zero).
        re.compile(
            rf"\bR[O0]\s*[:.]?\s*((?:{cui_chars}[ .]*){{2,10}})",
            re.IGNORECASE,
        ),
        # Prefix occasionally disappears in OCR, but the CIF/CUI label survives.
        re.compile(
            r"\b(?:C\s*\.?\s*I\s*\.?\s*F\s*\.?|C\s*\.?\s*U\s*\.?\s*I\.?)"
            rf"\s*:?\s*(?:R[O0]\s*)?((?:{cui_chars}[ .]*){{2,10}})",
            re.IGNORECASE,
        ),
    )
    glyph_to_digit = str.maketrans({"O": "0", "I": "1", "L": "1", "S": "5", "B": "8"})
    found: List[tuple[int, str]] = []
    seen = set()
    for pattern in patterns:
        for match in pattern.finditer(text):
            normalized = match.group(1).upper().translate(glyph_to_digit)
            digits = "".join(ch for ch in normalized if ch.isdigit())
            key = (match.start(), digits)
            if key in seen or valid_cui(digits) is not True:
                continue
            seen.add(key)
            found.append(key)
    return sorted(found)


def reconcile_receipt_party_eins(
    data: Dict[str, Any],
    document_text: str,
    client_ein: Any = None,
) -> Dict[str, Any]:
    """Recover receipt vendor/buyer CUIs from the printed layout and the tenant CUI.

    A Romanian fiscal receipt (``bon fiscal``) prints only the SELLER's CUI(s): the
    issuer in the company header above ``BON FISCAL`` and sometimes a second entity
    CUI below it. The buyer's CUI is almost never printed, so vision models copy the
    one seller CUI they can read into BOTH ``vendor_ein`` and ``buyer_ein`` even
    though it passes the Romanian checksum.

    The uploaded document belongs to the tenant, so the tenant is necessarily one of
    the two parties. Resolve the identities deterministically:

      * ``vendor_ein`` ← the receipt issuer (header CUI, or the sole printed CUI that
        isn't the tenant when the header didn't OCR cleanly).
      * ``buyer_ein`` ← the tenant's own CUI whenever the tenant isn't the issuer
        (an incoming purchase), since the buyer's CUI isn't on the paper. When the
        tenant IS the issuer (outgoing), the buyer is the other printed CUI.

    Leaves genuinely ambiguous documents (no tenant CUI, or several rival seller
    CUIs and no header) untouched.
    """
    if not isinstance(data, dict) or not document_text:
        return data
    candidates = _receipt_cui_candidates(document_text)
    if not candidates:
        return data

    heading = re.search(
        r"\b(?:BON\s+FISCAL|CHITAN(?:T|Ț|Ţ)(?:A|Ă))\b",
        document_text,
        re.IGNORECASE,
    )
    heading_pos = heading.start() if heading else None
    header_candidates = (
        [(pos, cui) for pos, cui in candidates if pos < heading_pos]
        if heading_pos is not None
        else []
    )
    client = _norm_ein_compare(client_ein)

    # --- Vendor: the receipt issuer ---
    vendor = header_candidates[0][1] if header_candidates else ""
    if not vendor:
        # No readable header CIF (small thermal print, or OCR dropped it). The
        # issuer is the printed CUI that isn't the tenant; when exactly one such
        # seller CUI exists it is unambiguously the vendor. Covers both the "model
        # duplicated the seller CUI into both fields" case and the "only the seller
        # CUI is legible" fuel-receipt case.
        alternatives = list(dict.fromkeys(
            cui for _, cui in candidates if cui != client
        ))
        if len(alternatives) == 1:
            vendor = alternatives[0]

    if vendor:
        data["vendor_ein"] = vendor

    after_heading = (
        [cui for pos, cui in candidates if pos > heading_pos]
        if heading_pos is not None
        else [cui for _, cui in candidates]
    )

    # --- Buyer: the tenant, unless the tenant is the issuer ---
    # The receipt belongs to the tenant, so the tenant is one of the two parties.
    if vendor and vendor == client:
        # Outgoing: the tenant issued the receipt; the buyer is the other party.
        other_buyers = [cui for cui in after_heading if cui != vendor]
        if other_buyers:
            data["buyer_ein"] = other_buyers[0]
    elif client and vendor and vendor != client:
        # Incoming purchase: the buyer is the tenant. A fuel/retail bon fiscal
        # doesn't print the buyer's CUI, so the model's duplicated seller CUI in
        # buyer_ein is wrong — the tenant CUI is the only correct value. (When a
        # "Client CUI" line IS printed it equals the tenant, so this is consistent.)
        data["buyer_ein"] = client

    inferred = infer_direction(
        data.get("vendor_ein"), data.get("buyer_ein"), client_ein
    )
    if inferred:
        data["direction"] = inferred
    return data


# ---------------------------------------------------------------------------
# Normalize line totals to NET (VAT-exclusive)
# ---------------------------------------------------------------------------

def _tol(x: float) -> float:
    """Money tolerance: 2 bani absolute or 1% relative (rounding noise)."""
    return max(0.02, 0.01 * abs(x))


def reconcile_line_item_vat_rates(data: Dict[str, Any]) -> Dict[str, Any]:
    """Relabel an obviously-wrong per-line VAT *rate* from the printed ``vat_amount``.

    The model occasionally tags a line with the wrong rate enum while the VAT
    *amount* it read is correct — e.g. a 21% fuel line (vat_amount 85.15 on a 405.45
    net total) mislabelled ``NINETEEN``: 405.45×19%→77.04 ≠ 85.15 but 405.45×21%→85.14.
    When the labelled rate cannot reproduce ``vat_amount`` under either the net or the
    gross reading, but exactly ONE other known Romanian rate can, rewrite ``vat`` to
    that rate.

    Deterministic and grounded in the document's own number: it never invents a VAT
    amount, only relabels the rate, and only when the answer is unambiguous (a single
    candidate). If the current label already reconciles, or zero/several rates fit, the
    line is left untouched. Must run BEFORE :func:`normalize_line_items_to_net`, which
    strips ``total``/``unit_price`` to net using this rate — a wrong rate there would
    compute the wrong net.

    Mutates and returns ``data``.
    """
    items = data.get("line_items")
    if not isinstance(items, list):
        return data

    # Non-zero known rates only — a 0% line carries no amount to reconcile against,
    # and "exactly one match" can't distinguish 0% from "no VAT line".
    candidates = [(name, pct) for name, pct in VAT_RATE_PCT.items() if pct > 0]

    for it in items:
        if not isinstance(it, dict):
            continue
        cur = it.get("vat")
        cur_rate = VAT_RATE_PCT.get(cur)
        total = _num(it.get("total"))
        vat = _num(it.get("vat_amount"))
        if total is None or total == 0 or vat is None or abs(vat) <= 0:
            continue  # nothing to reconcile against

        amt = abs(total)
        v = abs(vat)

        def _fits(pct: float) -> bool:
            # `total` may be net (VAT on top) or gross (VAT inside) — accept either,
            # mirroring _check_line_item_vat; we only care which RATE reproduces vat.
            return _money_close(amt * pct / 100.0, v) or _money_close(amt * pct / (100.0 + pct), v)

        # If the current label already reproduces the amount, trust it as-is.
        if cur_rate is not None and _fits(cur_rate):
            continue

        hits = [name for name, pct in candidates if _fits(pct)]
        # Only correct when a SINGLE rate fits — never guess between rivals.
        if len(hits) == 1 and hits[0] != cur:
            it["vat"] = hits[0]

    return data


def normalize_line_items_to_net(data: Dict[str, Any]) -> Dict[str, Any]:
    """Rewrite each line item's ``total``/``unit_price`` to NET (VAT-exclusive).

    Romanian fiscal receipts (bon fiscal) and most till receipts print
    VAT-INCLUSIVE prices, so the extractor returns a GROSS line ``total`` (and a
    gross ``unit_price``) while ``vat_amount`` is the VAT *already contained* in
    that gross figure. Downstream — the line-items table (LineItemsTable.tsx) and
    the accounting export — treats ``total`` as net and computes the document
    total as Σ(total) + Σ(vat_amount); a gross ``total`` is therefore taxed a
    second time (e.g. a 100.06 RON fuel receipt shown as 116.04). This converts
    any line whose numbers are unmistakably gross back to net so
    ``total + vat_amount`` reproduces the printed gross amount.

    Conservative + deterministic: a line is only rewritten when the GROSS reading
    of its own ``vat_amount`` fits and the NET reading does not (per-line) or —
    when a line carries no usable ``vat_amount`` — when the line totals already
    sum to the document's gross ``total_amount`` (document-level). Lines that
    already look net are left untouched, so this is safe to run on invoices (net
    prices + a separate VAT column) too.

    Mutates and returns ``data``.
    """
    items = data.get("line_items")
    if not isinstance(items, list) or not items:
        return data

    # Document-level signal (fallback for lines with no usable per-line VAT):
    # do the line totals already sum to the GROSS document total — and NOT to the
    # net total (gross − document VAT) — meaning the lines are gross? This needs
    # the document `vat_amount`; with no per-line VAT, Σtotal alone can't tell net
    # from gross (Σtotal + 0 = Σtotal), so a zero document VAT stays a no-op.
    doc_total = _num(data.get("total_amount"))
    doc_vat = _num(data.get("vat_amount"))
    line_sum = sum(_num(it.get("total")) or 0.0 for it in items)
    doc_looks_gross = (
        doc_total is not None and doc_total > 0
        and doc_vat is not None and doc_vat > _tol(doc_total)
        and abs(line_sum - doc_total) <= _tol(doc_total)
        and abs(line_sum - (doc_total - doc_vat)) > _tol(doc_total)
    )

    for it in items:
        if not isinstance(it, dict):
            continue
        rate = VAT_RATE_PCT.get(it.get("vat"))
        if not rate:  # None (unknown) or 0% — nothing to strip
            continue
        total = _num(it.get("total"))
        if total is None or total == 0:
            continue
        factor = 1.0 + rate / 100.0

        vat = _num(it.get("vat_amount"))
        if vat is not None and abs(vat) > 0:
            # Decide from the line's own VAT: does it match the gross reading
            # (VAT contained in total) better than the net reading (VAT on top)?
            vat_if_net = total * rate / 100.0
            vat_if_gross = total * rate / (100.0 + rate)
            err_net = abs(abs(vat) - abs(vat_if_net))
            err_gross = abs(abs(vat) - abs(vat_if_gross))
            t = _tol(vat)
            is_gross = err_gross <= t and err_gross <= err_net and err_net > t
        else:
            # No usable per-line VAT — defer to the document-level reading.
            is_gross = doc_looks_gross

        if not is_gross:
            continue

        net = round(total / factor, 2)
        it["total"] = net
        it["vat_amount"] = round(total - net, 2)
        unit_price = _num(it.get("unit_price"))
        if unit_price is not None:
            it["unit_price"] = round(unit_price / factor, 2)

    return data


# ---------------------------------------------------------------------------
# Top-level
# ---------------------------------------------------------------------------

_BLANK_VALUES = frozenset({"", "unknown", "necunoscut", "n/a", "na", "none", "null", "-"})


def _is_blank(value: Any) -> bool:
    """A model 'I couldn't read this' value: empty, or a sentinel like 'Unknown'."""
    return str(value if value is not None else "").strip().lower() in _BLANK_VALUES


def _is_degenerate_extraction(data: Dict[str, Any]) -> bool:
    """True when extraction returned essentially nothing to validate.

    No identifier, no monetary substance, and no row-bearing content of any
    document type. On such a document every structural check passes *tautologically*
    (0 = Σ0; a placeholder date like '01-01-2000' is format-valid and not in the
    future), so callers must not let those passes manufacture high confidence for a
    document that was never actually read. Real documents carry at least an
    identifier, a non-zero amount, or content rows, so this never fires on them.
    Dates are deliberately NOT treated as substance — a hallucinated placeholder
    date is exactly the signal we're trying to discount.
    """
    identifiers = (
        data.get("vendor"), data.get("buyer"),
        data.get("vendor_ein"), data.get("buyer_ein"), data.get("company_ein"),
        data.get("document_number"), data.get("invoice_number"),
        data.get("account_number"), data.get("company_name"),
        data.get("vin"), data.get("cmr_number"), data.get("mrn"),
        data.get("policy_number"), data.get("registration_number"),
    )
    # A "0"/"0.0" identifier is a model sentinel, never a real CUI / number, so it
    # must not rescue the document from the degeneracy check (the second Rompetrol
    # report emitted vendor_ein/buyer_ein = "0" and slipped through this gate).
    if any(not _is_blank(x) and str(x).strip() not in ("0", "0.0") for x in identifiers):
        return False
    for party in (data.get("parties") or []):
        if isinstance(party, dict) and (not _is_blank(party.get("name"))
                                        or not _is_blank(party.get("ein"))):
            return False
    # Monetary substance across document types (invoice/receipt total, Z-report
    # daily sales, disposition amount, contract value).
    for amt_field in ("total_amount", "daily_sales_total", "amount", "contract_value"):
        a = _num(data.get(amt_field))
        if a is not None and abs(a) > 0.005:
            return False
    if any((_num(it.get("total")) or 0) for it in (data.get("line_items") or [])
           if isinstance(it, dict)):
        return False
    # Row-bearing content of any type (bank txns, Z-report breakdowns/tenders).
    if data.get("transactions") or data.get("vat_breakdown") or data.get("payment_methods"):
        return False
    return True


def validate_extraction(
    document_type: str,
    data: Dict[str, Any],
    current_date: Optional[str] = None,
) -> Dict[str, Any]:
    checks: List[Dict[str, Any]] = []
    field_conf: Dict[str, float] = {}

    def add(field: str, rule: str, result: Optional[bool], detail: str = "") -> None:
        if result is None:
            return  # no opinion → leave confidence to the model
        checks.append({"field": field, "rule": rule, "passed": bool(result), "detail": detail})
        # A passing structural check is strong evidence; a failing one is strong
        # counter-evidence. Keep the *min* if multiple checks touch one field.
        score = 0.97 if result else 0.2
        field_conf[field] = min(field_conf.get(field, 1.0), score)

    # EIN / CUI fields by document type.
    for ein_field in ("vendor_ein", "buyer_ein", "company_ein"):
        if ein_field in data:
            add(ein_field, "RO CUI checksum", valid_cui(data.get(ein_field)),
                f"value={data.get(ein_field)!r}")
    if document_type in ("Invoice", "Receipt"):
        vendor_ein = _norm_ein_compare(data.get("vendor_ein"))
        buyer_ein = _norm_ein_compare(data.get("buyer_ein"))
        if vendor_ein and buyer_ein:
            parties_differ = vendor_ein != buyer_ein
            detail = f"vendor={vendor_ein!r}, buyer={buyer_ein!r}"
            add("vendor_ein", "vendor CUI differs from buyer CUI", parties_differ, detail)
            add("buyer_ein", "buyer CUI differs from vendor CUI", parties_differ, detail)
    for party in data.get("parties", []) or []:
        if isinstance(party, dict) and party.get("ein"):
            add("parties.ein", "RO CUI checksum", valid_cui(party.get("ein")), f"value={party.get('ein')!r}")

    # IBAN (bank statements).
    if data.get("account_number"):
        add("account_number", "IBAN mod-97", valid_iban(data.get("account_number")),
            f"value={data.get('account_number')!r}")

    if data.get("vin"):
        add("vin", "VIN format (17 chars, no I/O/Q)", valid_vin(data.get("vin")),
            f"value={data.get('vin')!r}")

    # Dates.
    for date_field in ("document_date", "issue_date", "closing_date",
                       "statement_period_start", "statement_period_end",
                       "contract_date", "first_registration_date",
                       "inspection_date", "loading_date"):
        if date_field in data and data.get(date_field):
            add(date_field, "DD-MM-YYYY, not future", valid_date(data.get(date_field), current_date),
                f"value={data.get(date_field)!r}")
    for date_field in ("due_date", "valid_until", "start_date", "end_date"):
        if date_field in data and data.get(date_field):
            add(date_field, "DD-MM-YYYY", valid_date_format(data.get(date_field)),
                f"value={data.get(date_field)!r}")

    # VAT arithmetic on line items.
    checks.extend(_check_line_item_vat(data.get("line_items", [])))
    checks.extend(_check_line_item_arithmetic(data.get("line_items", [])))
    checks.extend(_check_fuel_unit_price_plausible(data.get("line_items", [])))

    # Invoice/receipt total reconciles with the line items. Line `total` may be
    # net (VAT added on top) or gross (VAT already inside) — accept whichever
    # reading matches total_amount, so a gross line total (Σline already = the
    # VAT-inclusive document total) isn't double-taxed up to a phantom Σ+VAT.
    items = data.get("line_items") or []
    total = _num(data.get("total_amount"))
    if items and total is not None:
        line_sum = sum(_num(it.get("total")) or 0.0 for it in items)
        vat_sum = sum(_num(it.get("vat_amount")) or 0.0 for it in items)
        gross_if_net = line_sum + vat_sum
        passed = _money_close(line_sum, total) or _money_close(gross_if_net, total)
        checks.append({
            "field": "total_amount",
            "rule": "total = Σ(line.total) [+ Σ(line.vat) if net]",
            "passed": passed,
            "detail": f"Σline={line_sum:.2f}, Σline+Σvat={gross_if_net:.2f}, total_amount={total:.2f}",
        })
        field_conf["total_amount"] = min(field_conf.get("total_amount", 1.0), 0.97 if passed else 0.2)

        # Invoice-level vat_amount == sum(line vat), when the doc carries VAT.
        inv_vat = _num(data.get("vat_amount"))
        if inv_vat is not None and inv_vat > 0:
            passed_v = _money_close(vat_sum, inv_vat)
            checks.append({
                "field": "vat_amount",
                "rule": "vat = Σ(line.vat)",
                "passed": passed_v,
                "detail": f"Σvat={vat_sum:.2f}, vat_amount={inv_vat:.2f}",
            })
            field_conf["vat_amount"] = min(field_conf.get("vat_amount", 1.0), 0.97 if passed_v else 0.2)

    # Bank statement balance continuity: closing = opening + Σcredit − Σdebit.
    # This is what catches the opening-balance sign error — a balance printed in
    # the Debit column is negative, so extracting it positive (e.g. 25 instead of
    # −25) breaks this reconciliation and drops confidence instead of silently
    # passing at 97%. Balances are signed; credit/debit amounts are magnitudes.
    opening = _num(data.get("opening_balance"))
    closing = _num(data.get("closing_balance"))
    txns = data.get("transactions") or []
    if opening is not None and closing is not None and txns:
        credit_sum = sum(_num(t.get("credit_amount")) or 0.0 for t in txns)
        debit_sum = sum(_num(t.get("debit_amount")) or 0.0 for t in txns)
        expected_close = opening + credit_sum - debit_sum
        passed_b = _money_close(expected_close, closing)
        checks.append({
            "field": "closing_balance",
            "rule": "closing = opening + Σcredit − Σdebit",
            "passed": passed_b,
            "detail": (f"opening={opening:.2f} + Σcr={credit_sum:.2f} − Σdr={debit_sum:.2f}"
                       f" ⇒ {expected_close:.2f}, closing={closing:.2f}"),
        })
        bal_score = 0.97 if passed_b else 0.2
        field_conf["closing_balance"] = min(field_conf.get("closing_balance", 1.0), bal_score)
        field_conf["opening_balance"] = min(field_conf.get("opening_balance", 1.0), bal_score)

    # Z-report (fiscal day-close) internal arithmetic. A Z report restates the same
    # daily total three ways — over VAT rates, over payment methods, and as
    # base+VAT — so they must agree; each is a free correctness signal.
    if document_type == "Z Report":
        daily = _num(data.get("daily_sales_total"))
        vat_rows = [r for r in (data.get("vat_breakdown") or []) if isinstance(r, dict)]
        if vat_rows:
            sum_total = sum(_num(r.get("total_amount")) or 0.0 for r in vat_rows)
            sum_base = sum(_num(r.get("taxable_base")) or 0.0 for r in vat_rows)
            sum_vat = sum(_num(r.get("vat_amount")) or 0.0 for r in vat_rows)
            if daily is not None:
                passed_z = _money_close(sum_total, daily)
                checks.append({
                    "field": "daily_sales_total",
                    "rule": "daily_sales = Σ(vat_breakdown.total)",
                    "passed": passed_z,
                    "detail": f"Σtotal={sum_total:.2f}, daily_sales={daily:.2f}",
                })
                field_conf["daily_sales_total"] = min(field_conf.get("daily_sales_total", 1.0), 0.97 if passed_z else 0.2)
            passed_bv = _money_close(sum_base + sum_vat, sum_total)
            checks.append({
                "field": "vat_breakdown",
                "rule": "Σtaxable_base + Σvat = Σtotal",
                "passed": passed_bv,
                "detail": f"Σbase={sum_base:.2f} + Σvat={sum_vat:.2f} = {sum_base + sum_vat:.2f}, Σtotal={sum_total:.2f}",
            })
            for i, r in enumerate(vat_rows):
                rate = VAT_RATE_PCT.get(r.get("vat_rate"))
                base = _num(r.get("taxable_base"))
                vat = _num(r.get("vat_amount"))
                if rate is None or base is None or vat is None or rate == 0:
                    continue
                checks.append({
                    "field": f"vat_breakdown[{i}].vat_amount",
                    "rule": "vat = taxable_base * rate",
                    "passed": _money_close(base * rate / 100.0, vat),
                    "detail": f"{base:.2f} * {rate}% = {base * rate / 100.0:.2f}, vat={vat:.2f}",
                })
        pay_rows = [r for r in (data.get("payment_methods") or []) if isinstance(r, dict)]
        if pay_rows and daily is not None:
            sum_pay = sum(_num(r.get("amount")) or 0.0 for r in pay_rows)
            passed_p = _money_close(sum_pay, daily)
            checks.append({
                "field": "daily_sales_total",
                "rule": "daily_sales = Σ(payment_methods.amount)",
                "passed": passed_p,
                "detail": f"Σpayments={sum_pay:.2f}, daily_sales={daily:.2f}",
            })
            field_conf["daily_sales_total"] = min(field_conf.get("daily_sales_total", 1.0), 0.97 if passed_p else 0.2)

    # Degenerate/empty extraction guard. When the model returned essentially
    # nothing (e.g. a low-contrast photo it couldn't read → vendor/buyer 'Unknown',
    # total 0, a placeholder '01-01-2000' date), the checks above pass tautologically
    # and would otherwise stamp total_amount/document_date at 0.97 — which
    # merge_confidence then uses to override the model's own ~0 self-confidence. Pull
    # every validator-derived confidence down so an empty extraction reads as
    # low-confidence everywhere instead of falsely certain.
    if field_conf and _is_degenerate_extraction(data):
        field_conf = {k: min(v, 0.2) for k, v in field_conf.items()}

    passed_count = sum(1 for c in checks if c["passed"])
    overall = (passed_count / len(checks)) if checks else 1.0

    return {"checks": checks, "field_confidence": field_conf, "overall_score": round(overall, 3)}


def merge_confidence(
    model_confidence: Optional[Dict[str, float]],
    field_confidence: Dict[str, float],
) -> Dict[str, float]:
    """Deterministic value wins where a validator fired; else model estimate."""
    merged: Dict[str, float] = dict(model_confidence or {})
    merged.update(field_confidence)
    return merged


# ---------------------------------------------------------------------------
# Confidence calibration for the review UI (Wave 2: consume the signals)
# ---------------------------------------------------------------------------

# Below this categorization confidence, a document's TYPE is shaky enough that it
# should be routed to human review rather than silently cascading into the chosen
# type's extraction (task 2.5). Matches the UI's "medium" band floor.
PHASE0_CONFIDENCE_THRESHOLD = 0.7

# Free-text fields the model self-reports confidence on but NO deterministic
# validator can check. Models routinely claim 0.95+ here even when the value is
# wrong, so we cap them below the "high" band — an unverifiable value must never
# render as a green high-confidence badge (task 2.3).
UNCALIBRATED_FREETEXT_FIELDS = {
    "vendor", "buyer", "company_name", "bank_name", "person_name",
    "description", "payment_terms", "contract_type",
    "sender_name", "consignee_name", "carrier_name", "make", "model", "summary",
}
# Ceiling for uncalibrated free-text confidence — just under the 0.9 "high" band.
FREETEXT_CONFIDENCE_CAP = 0.85

_LINE_FIELD_RE = re.compile(r"line_items\[(\d+)\]")


def cap_uncalibrated_confidence(
    confidence: Optional[Dict[str, float]],
    validated_fields: Optional[set] = None,
) -> Dict[str, float]:
    """Pull self-reported free-text confidence below the high band.

    A field a deterministic validator actually fired on (``validated_fields``) is
    left alone — only the model's unverifiable self-reports are capped, so the UI
    never shows "high" on a value nothing could verify.
    """
    if not isinstance(confidence, dict):
        return confidence or {}
    validated = validated_fields or set()
    for field in UNCALIBRATED_FREETEXT_FIELDS:
        v = confidence.get(field)
        if field not in validated and isinstance(v, (int, float)) and v > FREETEXT_CONFIDENCE_CAP:
            confidence[field] = FREETEXT_CONFIDENCE_CAP
    return confidence


def _norm_ein_compare(v: Any) -> str:
    """EIN reduced to comparable digits: strip non-alphanumerics + the RO/R0
    (OCR-misread) VAT prefix. Mirrors the eval scorer's normalize_ein."""
    if v is None:
        return ""
    s = re.sub(r"[^0-9A-Za-z]", "", str(v)).upper()
    if s[:2] in ("RO", "R0"):
        s = s[2:]
    return s


def infer_direction(vendor_ein: Any, buyer_ein: Any, client_ein: Any) -> Optional[str]:
    """Deterministic invoice direction from which party is the client company.

    The client's EIN is known and both parties' EINs are extracted from the
    document, so direction is decidable without the model: client is the buyer →
    "incoming"; client is the vendor → "outgoing". Returns None when it can't tell
    (client EIN missing, or it matches neither/both party) so the caller keeps the
    model's value. This is the "free" fix for the top direction-cascade error.
    """
    c = _norm_ein_compare(client_ein)
    if not c:
        return None
    v = _norm_ein_compare(vendor_ein)
    b = _norm_ein_compare(buyer_ein)
    if b == c and v != c:
        return "incoming"
    if v == c and b != c:
        return "outgoing"
    return None


def attach_line_item_confidence(
    data: Dict[str, Any],
    checks: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Write a per-line ``_confidence`` onto each line item, from the validators.

    The frontend line-item table already reads ``item["_confidence"]`` (orange row
    highlight + a low-confidence count) but nothing ever wrote it (task 2.2).
    Derive it from the deterministic per-line checks emitted by
    ``_check_line_item_vat`` / ``_check_line_item_arithmetic`` (fields like
    ``line_items[3].vat_amount``): a line with any FAILING arithmetic check is
    low-confidence (0.2), an all-passing line is high (0.97), an uncheckable line
    (zero/absent numbers, no check fired) is left neutral (0.7 — medium, not a
    false "high"). Deterministic results override; a pre-existing value is only
    kept when no check covers that line. Mutates and returns ``data``.
    """
    items = data.get("line_items")
    if not isinstance(items, list) or not items:
        return data
    if checks is None:
        checks = (data.get("_validation") or {}).get("checks") or []

    per_line: Dict[int, List[bool]] = {}
    for c in checks:
        m = _LINE_FIELD_RE.match(str(c.get("field", "")))
        if m:
            per_line.setdefault(int(m.group(1)), []).append(bool(c.get("passed")))

    for i, it in enumerate(items):
        if not isinstance(it, dict):
            continue
        results = per_line.get(i)
        if results and all(results) and _is_degenerate_line(it):
            # The per-line checks "passed" only because the line is empty (blank
            # name, zero qty/price/total) — a tautology, not a real reading. Flag it
            # low so a placeholder line isn't shown as high-confidence.
            it["_confidence"] = 0.2
        elif results:
            it["_confidence"] = 0.2 if not all(results) else 0.97
        else:
            it.setdefault("_confidence", 0.7)
    return data


def _is_degenerate_line(it: Dict[str, Any]) -> bool:
    """A line item with no real content: blank/sentinel name and all-zero numbers."""
    if not _is_blank(it.get("name")):
        return False
    return all((_num(it.get(f)) or 0) == 0
               for f in ("quantity", "unit_price", "total", "vat_amount"))
