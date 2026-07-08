"""Deterministic post-extraction validators.

A field that fails a validator is never left "high confidence": the caller
caps its confidence and flags the document for review.
"""
import datetime
import re
from typing import Any, Dict, List

VIN_RE = re.compile(r"^[A-HJ-NPR-Z0-9]{17}$")
VIN_TRANSLIT = {c: v for c, v in zip("ABCDEFGHJKLMNPRSTUVWXYZ", [1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4, 5, 7, 9, 2, 3, 4, 5, 6, 7, 8, 9])}
VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2]


def validate(doc_type: str, fields: Dict[str, Any]) -> List[Dict[str, str]]:
    issues: List[Dict[str, str]] = []

    vin = fields.get("vin")
    if vin:
        vin = str(vin).strip().upper()
        if not VIN_RE.match(vin):
            issues.append({"field": "vin", "issue": "VIN invalid: trebuie 17 caractere, fără I/O/Q"})
        elif not _vin_check_digit_ok(vin):
            issues.append({"field": "vin", "issue": "Cifra de control VIN nu corespunde (posibilă eroare OCR)"})

    for key in ("invoice_date", "due_date", "date", "contract_date", "first_registration_date",
                "inspection_date", "valid_until", "start_date", "end_date", "loading_date",
                "period_start", "period_end"):
        value = fields.get(key)
        if value and not _date_sane(str(value)):
            issues.append({"field": key, "issue": f"Dată suspectă: {value}"})

    if doc_type == "Invoice":
        issues.extend(_invoice_arithmetic(fields))

    if doc_type == "Bank Statement":
        txns = fields.get("transactions") or []
        opening, closing = fields.get("opening_balance"), fields.get("closing_balance")
        if opening is not None and closing is not None and txns:
            total = sum(float(t.get("amount") or 0) for t in txns)
            if abs((float(opening) + total) - float(closing)) > 0.05:
                issues.append({
                    "field": "transactions",
                    "issue": "Soldul final nu corespunde: sold inițial + tranzacții ≠ sold final (posibil tranzacții lipsă)",
                })

    mileage = fields.get("mileage_km")
    if mileage is not None:
        try:
            if not (0 <= int(mileage) <= 1_500_000):
                issues.append({"field": "mileage_km", "issue": f"Kilometraj implauzibil: {mileage}"})
        except (TypeError, ValueError):
            issues.append({"field": "mileage_km", "issue": "Kilometrajul nu este numeric"})

    return issues


def _invoice_arithmetic(fields: Dict[str, Any]) -> List[Dict[str, str]]:
    issues = []
    net, vat, total = fields.get("net_amount"), fields.get("vat_amount"), fields.get("total_amount")
    if net is not None and vat is not None and total is not None:
        if abs((float(net) + float(vat)) - float(total)) > 0.05:
            issues.append({"field": "total_amount", "issue": "Aritmetică TVA: net + TVA ≠ total"})
    line_items = fields.get("line_items") or []
    if net is not None and line_items:
        line_sum = sum(float(li.get("net_amount") or 0) for li in line_items)
        if line_sum and abs(line_sum - float(net)) > 0.05:
            issues.append({"field": "line_items", "issue": "Suma liniilor (net) nu corespunde cu totalul net"})
    return issues


def _date_sane(value: str) -> bool:
    try:
        parsed = datetime.date.fromisoformat(value[:10])
    except ValueError:
        return False
    return datetime.date(1980, 1, 1) <= parsed <= datetime.date.today() + datetime.timedelta(days=366 * 3)


def _vin_check_digit_ok(vin: str) -> bool:
    """ISO 3779 check digit. Only authoritative for NA-market VINs, so treat a
    mismatch as a review flag, not a hard error."""
    try:
        total = 0
        for ch, weight in zip(vin, VIN_WEIGHTS):
            value = int(ch) if ch.isdigit() else VIN_TRANSLIT[ch]
            total += value * weight
        check = total % 11
        expected = "X" if check == 10 else str(check)
        return vin[8] == expected
    except (KeyError, ValueError):
        return False
