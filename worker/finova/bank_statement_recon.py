"""Deterministic post-extraction reconciliation for Banca Transilvania statements.

A BT "Extras de cont" prints control totals that pin the ledger down exactly:

    SOLD ANTERIOR                       -> opening balance
    <date> RULAJ ZI <debit> <credit>    -> that day's debit / credit turnover
    SOLD FINAL ZI <balance>             -> end-of-day running balance
    <date> RULAJ TOTAL CONT <deb> <cr>  -> statement debit / credit totals
    SOLD FINAL CONT <balance>           -> the true closing balance

Whether a transaction amount is a debit or a credit is encoded *only* by which
column it sits in, and that column position is destroyed when the page is
linearized to text for the model. So the model guesses the direction and flips
rows — e.g. a run of POS card payments (debits) booked as credits, or an
"Incasare" (a credit) booked as a debit. The printed totals let us repair this
deterministically:

  * a day whose RULAJ ZI credit is 0.00 can contain no credits -> every row that
    day is a debit (and symmetrically for a 0.00 debit day);
  * a mixed day is reconciled by finding the subset of its rows that sums to the
    printed credit turnover — those are the credits, the rest debits;
  * the closing balance is anchored to SOLD FINAL CONT (not a mid-statement
    SOLD FINAL ZI, the classic "first day's balance" misread);
  * a day whose extracted rows can't be made to match its RULAJ ZI (a row the
    model missed or invented) is *flagged*, never silently rewritten.

Pure function (no I/O): given the extracted dict + the OCR/text the model saw,
return the corrected dict and a report. No-ops on non-BT statements (the markers
are absent), so it is safe to call on every bank statement.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

try:
    from .debug_trace import TRACE
except ImportError:
    from debug_trace import TRACE  # type: ignore

# Money tolerance: statements print 2 decimals, so a cent of slack absorbs
# float noise without ever merging two genuinely different amounts.
_TOL = 0.011

_NUM_RE = r"-?\d[\d.,]*"


def _parse_money(raw: str) -> Optional[float]:
    """Parse a Romanian/US-formatted money token to float.

    BT prints US-style ("1,148.07" — comma thousands, dot decimal); be tolerant
    of European ("1.148,07") too. Returns None if it isn't a number.
    """
    if raw is None:
        return None
    s = raw.strip().replace(" ", "")
    if not s or not re.search(r"\d", s):
        return None
    has_comma, has_dot = "," in s, "." in s
    if has_comma and has_dot:
        # The rightmost separator is the decimal point; the other groups digits.
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif has_comma:
        # Lone comma: decimal separator if it looks like ",dd", else thousands.
        s = s.replace(",", ".") if re.search(r",\d{1,2}$", s) else s.replace(",", "")
    try:
        return float(s)
    except ValueError:
        return None


def _date_key(raw: Any) -> Optional[Tuple[int, int, int]]:
    """Normalize a DD-MM-YYYY / DD/MM/YYYY date string to a (d, m, y) tuple."""
    if not isinstance(raw, str):
        return None
    m = re.search(r"(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})", raw)
    if not m:
        return None
    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    return (d, mo, y)


def parse_bt_controls(text: str) -> Optional[Dict[str, Any]]:
    """Extract BT control totals from the statement text.

    Returns ``{opening, closing, total_debit, total_credit, days}`` where ``days``
    maps a (d, m, y) date key to ``{debit, credit, sold_final}``. Returns None if
    the statement is not a BT layout (no RULAJ ZI / SOLD markers found).
    """
    if not text or "RULAJ" not in text.upper():
        return None

    opening = closing = total_debit = total_credit = None
    days: Dict[Tuple[int, int, int], Dict[str, Optional[float]]] = {}
    last_day_key: Optional[Tuple[int, int, int]] = None

    two_nums = re.compile(rf"({_NUM_RE})\s+({_NUM_RE})\s*$")
    one_num = re.compile(rf"({_NUM_RE})\s*$")

    for line in text.splitlines():
        up = line.upper()

        if "RULAJ TOTAL CONT" in up:
            mt = two_nums.search(line)
            if mt:
                total_debit = _parse_money(mt.group(1))
                total_credit = _parse_money(mt.group(2))
            continue
        if "SOLD FINAL CONT" in up:
            mo = one_num.search(line)
            if mo:
                closing = _parse_money(mo.group(1))
            continue
        if "SOLD ANTERIOR" in up:
            mo = one_num.search(line)
            if mo:
                opening = _parse_money(mo.group(1))
            continue
        if "SOLD FINAL ZI" in up:
            mo = one_num.search(line)
            if mo and last_day_key is not None:
                days[last_day_key]["sold_final"] = _parse_money(mo.group(1))
            continue
        if "RULAJ ZI" in up:
            dk = _date_key(line)
            mt = two_nums.search(line)
            if dk is not None and mt is not None:
                days[dk] = {
                    "debit": _parse_money(mt.group(1)),
                    "credit": _parse_money(mt.group(2)),
                    "sold_final": None,
                }
                last_day_key = dk
            continue

    if not days and opening is None and closing is None:
        return None
    return {
        "opening": opening,
        "closing": closing,
        "total_debit": total_debit,
        "total_credit": total_credit,
        "days": days,
    }


def _valid_cui(v: Any) -> bool:
    try:
        from .validators import valid_cui
    except ImportError:
        from validators import valid_cui  # type: ignore
    try:
        return bool(valid_cui(v))
    except Exception:
        return False


def _valid_iban(v: Any) -> bool:
    try:
        from .validators import valid_iban
    except ImportError:
        from validators import valid_iban  # type: ignore
    try:
        return bool(valid_iban(v))
    except Exception:
        return False


def _recover_bt_header(data: Dict[str, Any], text: str) -> List[str]:
    """Fix company_ein / account_number from the statement header when the
    model's value is clearly wrong (fails CUI checksum / isn't a valid IBAN).

    BT prints the account holder's fiscal code as ``CUI: <digits>`` in the page
    header — distinct from the bank's own ``C.U.I. 5022670`` footer (dotted) and
    the ``C.I.F.:`` codes inside transaction lines — and the IBAN as
    ``Cod IBAN: RO...``. Conservative: only overrides a value that fails its
    validator, and only with a recovered value that passes. Returns field names
    fixed.
    """
    fixed: List[str] = []
    head = text[:4000]  # header lives at the top; avoid footer/transaction noise

    if not _valid_cui(data.get("company_ein")):
        # "CUI:" with a colon and no dots — not "C.U.I." (bank) or "C.I.F.:" (txn).
        for m in re.finditer(r"(?<![.\w])CUI\s*:?\s*(\d{2,10})", head):
            if _valid_cui(m.group(1)):
                data["company_ein"] = m.group(1)
                fixed.append("company_ein")
                break

    if not _valid_iban(data.get("account_number")):
        m = re.search(r"\bIBAN\s*:?\s*([A-Z]{2}\d{2}[A-Z0-9]{10,30})", head, re.IGNORECASE)
        if m and _valid_iban(m.group(1)):
            data["account_number"] = m.group(1).upper()
            fixed.append("account_number")

    return fixed


# Romanian IBAN bank code (chars 5–8) → display name, to derive bank_name from
# the account IBAN deterministically. Common banks only; unknown codes are left
# for the model's value.
_IBAN_BANK_NAMES = {
    "BTRL": "Banca Transilvania", "BRDE": "BRD", "BACX": "UniCredit Bank",
    "RNCB": "BCR", "RZBR": "Raiffeisen Bank", "INGB": "ING Bank",
    "CECE": "CEC Bank", "BREL": "Libra Internet Bank", "WBAN": "Intesa Sanpaolo",
    "OTPV": "OTP Bank", "PIRB": "First Bank", "UGBI": "Garanti BBVA",
    "BPOS": "BancPost", "CRCO": "Banca Comerciala Carpatica", "TREZ": "Trezorerie",
    "BCYP": "Bank of Cyprus", "FNNB": "Credit Europe Bank", "MIRO": "ProCredit Bank",
    "VBBU": "Patria Bank", "DAFB": "Alpha Bank", "BPOR": "Banca Romaneasca",
}


def recover_bank_header(data: Dict[str, Any], text: str) -> List[str]:
    """Fill empty/invalid bank-statement header fields deterministically — generic
    (any bank), unlike the BT-specific ``_recover_bt_header``.

    Targets the chunk-recovery header-loss case: when the full-document pass
    truncates, header scalars are seeded empty and the chunked pass only refills
    transactions (the 49-page UniCredit failure: 306 rows recovered, header blank).
    The account IBAN is still in the page-1 text, the bank follows from the IBAN
    code, and the statement period is the span of the transaction dates — recover
    those rather than persisting blanks. Conservative: only fills a field that is
    empty (or, for the IBAN, fails mod-97), and only with a value that validates.
    Also recovers company_name / company_ein from the page-1 header block ONLY
    (the account holder's name + CUI are printed at the very top; counterparty CUIs
    live in later-page transaction lines, so the small header window keeps this
    safe). Returns fields filled.
    """
    if not isinstance(data, dict):
        return []
    fixed: List[str] = []
    head_raw = (text or "")[:3000]      # case-preserving header (holder block)
    head = (text or "")[:6000].upper()  # account details live on page 1

    # company_name: the account holder, printed under a label in the page-1 header
    # ("DENUMIRE COMPANIE: X", "Titular cont: X", "Client: X", ...). Cut at the
    # company-form suffix when present so trailing OCR noise doesn't ride along.
    if not str(data.get("company_name") or "").strip():
        # Priority-ordered labels (most specific first), each searched on its own so a
        # stray earlier "Client" in the letterhead can't outrank "Denumire companie".
        for label in (r"DENUMIRE\s+COMPANIE", r"DENUMIRE\s+CLIENT", r"TITULAR(?:\s+CONT)?",
                      r"NUME\s*/?\s*DENUMIRE", r"NUME\s+CLIENT", r"CLIENT"):
            nm = re.search(label + r"\s*:?\s*([^\n\r]{2,80})", head_raw, re.IGNORECASE)
            if not nm:
                continue
            cand = nm.group(1).strip()
            suf = re.search(
                r"^(.*?\b(?:S\.?R\.?L|S\.?A|P\.?F\.?A|S\.?N\.?C|S\.?C\.?S|S\.?C\.?A|I\.?I|I\.?F)\b\.?)",
                cand, re.IGNORECASE,
            )
            cand = (suf.group(1) if suf else cand[:60]).strip(" :.-")
            if len(cand) >= 2 and re.search(r"[A-Za-zĂÂÎȘŢȚ]", cand):
                data["company_name"] = cand
                fixed.append("company_name")
                break

    # company_ein: the holder's CUI, preferring one printed right after the company
    # name (ties it to the holder, not the bank's letterhead CUI or a counterparty).
    if not _valid_cui(data.get("company_ein")):
        cui_re = re.compile(
            r"(?:C\.?U\.?I|C\.?I\.?F|COD\s+FISCAL|COD\s+UNIC(?:\s+DE\s+INREGISTRARE)?)"
            r"\s*:?\s*(?:RO\s*)?(\d{2,10})",
            re.IGNORECASE,
        )
        name_pos = head_raw.upper().find(str(data.get("company_name") or "").upper()) if data.get("company_name") else -1
        windows = []
        if name_pos >= 0:
            windows.append(head_raw[name_pos:name_pos + 300])  # adjacent to holder name first
        windows.append(head_raw)
        for win in windows:
            hit = next((m.group(1) for m in cui_re.finditer(win) if _valid_cui(m.group(1))), None)
            if hit:
                data["company_ein"] = hit
                fixed.append("company_ein")
                break

    # account_number: first valid IBAN in the header (counterparty IBANs sit in
    # later-page transaction lines, beyond the header window).
    if not _valid_iban(data.get("account_number")):
        for m in re.finditer(r"\bRO\d{2}[A-Z0-9]{16,26}\b", head):
            if _valid_iban(m.group(0)):
                data["account_number"] = m.group(0)
                fixed.append("account_number")
                break

    # account_number: first valid IBAN in the header (counterparty IBANs sit in
    # later-page transaction lines, beyond the header window).
    if not _valid_iban(data.get("account_number")):
        for m in re.finditer(r"\bRO\d{2}[A-Z0-9]{16,26}\b", head):
            if _valid_iban(m.group(0)):
                data["account_number"] = m.group(0)
                fixed.append("account_number")
                break

    # bank_name: from the (extracted or just-recovered) IBAN bank code.
    if not str(data.get("bank_name") or "").strip():
        iban = str(data.get("account_number") or "").upper().replace(" ", "")
        if len(iban) >= 8 and iban.startswith("RO"):
            name = _IBAN_BANK_NAMES.get(iban[4:8])
            if name:
                data["bank_name"] = name
                fixed.append("bank_name")

    # statement period: the span of the transaction dates, when the header lacked it.
    dks = [
        _date_key(t.get("transaction_date"))
        for t in (data.get("transactions") or [])
        if isinstance(t, dict)
    ]
    dks = [d for d in dks if d]
    if dks:
        order = sorted(dks, key=lambda d: (d[2], d[1], d[0]))
        fmt = lambda dk: f"{dk[0]:02d}-{dk[1]:02d}-{dk[2]}"  # noqa: E731
        if not str(data.get("statement_period_start") or "").strip():
            data["statement_period_start"] = fmt(order[0])
            fixed.append("statement_period_start")
        if not str(data.get("statement_period_end") or "").strip():
            data["statement_period_end"] = fmt(order[-1])
            fixed.append("statement_period_end")

    return fixed


def recover_balances_from_chain(
    data: Dict[str, Any], tol: float = 0.5
) -> List[str]:
    """Fill opening/closing balance from the transaction running-balance chain when
    extraction left them at 0.

    Targets the truncated-vision + chunk-recovery case (BRD RO95: the full-document
    pass hit max_tokens before emitting the header balances, so opening/closing
    persisted as the schema default 0.0 while the 52 rows were recovered by the
    page-chunk pass). The running balance still pins them down:

      * closing = the printed ``balance_after_transaction`` of the LAST row;
      * opening = the balance BEFORE the first row
                = ``balance_after`` of row 1 − (credit₁ − debit₁).

    Only INDEPENDENT evidence (the printed per-row balances) is used — never algebra
    from the other balance, which would force the statement identity to hold and mask
    missing/misread rows. Endpoints must be meaningfully non-zero: an all-zero balance
    column (the model never read it — the UniCredit case) yields bogus ~0 candidates
    and is skipped. When BOTH balances are missing they are filled only if the chain
    endpoints satisfy ``opening + Σcredit − Σdebit = closing`` (so we never invent a
    pair out of an unreconcilable chain). Returns the field names filled.
    """
    if not isinstance(data, dict):
        return []
    txns = [t for t in (data.get("transactions") or []) if isinstance(t, dict)]
    if not txns:
        return []

    def _is_set(v: Any) -> bool:
        f = _f(v)
        return f is not None and abs(f) > _TOL

    have_open = _is_set(data.get("opening_balance"))
    have_close = _is_set(data.get("closing_balance"))
    if have_open and have_close:
        return []

    sc = sd = 0.0
    for t in txns:
        d = _f(t.get("debit_amount"))
        c = _f(t.get("credit_amount"))
        if d:
            sd += abs(d)
        if c:
            sc += abs(c)

    # closing: the printed running balance after the LAST row.
    close_cand = _f(txns[-1].get("balance_after_transaction"))
    close_usable = close_cand is not None and abs(close_cand) > _TOL

    # opening: the balance just BEFORE the first row.
    bf = _f(txns[0].get("balance_after_transaction"))
    open_cand: Optional[float] = None
    if bf is not None and abs(bf) > _TOL:
        c0 = abs(_f(txns[0].get("credit_amount")) or 0.0)
        d0 = abs(_f(txns[0].get("debit_amount")) or 0.0)
        open_cand = bf - (c0 - d0)
    open_usable = open_cand is not None

    fixed: List[str] = []
    if not have_open and not have_close:
        # Fill both only when the chain endpoints reconcile — otherwise a partial /
        # misread chain would silently produce a "balanced" pair that means nothing.
        if open_usable and close_usable and abs(open_cand + sc - sd - close_cand) <= max(tol, _TOL):
            data["opening_balance"] = round(open_cand, 2)
            data["closing_balance"] = round(close_cand, 2)
            fixed.extend(["opening_balance", "closing_balance"])
        return fixed

    # Exactly one side missing: the other is the model's own (independent) value, so
    # the chain endpoint is corroboration — fill it and let the reconciliation check
    # judge truthfully.
    if not have_open and open_usable:
        data["opening_balance"] = round(open_cand, 2)
        fixed.append("opening_balance")
    if not have_close and close_usable:
        data["closing_balance"] = round(close_cand, 2)
        fixed.append("closing_balance")
    return fixed


# Printed-balance labels Romanian banks use in the header / summary block. Opening
# first, then closing — the closing list is ordered most-specific-first so e.g. a
# UniCredit "Sold final cont" wins over a per-day "Sold final".
_OPENING_BAL_LABELS = (
    "SOLD INITIAL", "SOLD PRECEDENT", "SOLD ANTERIOR", "SOLD REPORTAT",
    "SOLD LA INCEPUTUL", "SOLD DESCHIDERE", "SOLD ANTERIOR CONT",
)
_CLOSING_BAL_LABELS = (
    "SOLD FINAL CONT", "SOLD LA SFARSITUL", "SOLD FINAL LA", "SOLD INCHIDERE",
    "SOLD FINAL", "SOLD CONT", "SOLD CURENT", "SOLD DISPONIBIL", "SOLD LA ZI",
)


def parse_statement_balances_from_text(text: str) -> Dict[str, Any]:
    """Best-effort opening/closing from the printed 'Sold ...' labels (any RO bank).

    Pure parser — returns ``{opening, closing, opening_label, closing_label}`` with
    None where a label wasn't found. The caller decides whether to apply (we gate on
    reconciliation, since a label can sit next to a date the regex might grab). The
    labels and parsed values are logged so an un-applied parse still tells us whether
    the balance is even present in the OCR text.
    """
    res: Dict[str, Any] = {"opening": None, "closing": None,
                           "opening_label": None, "closing_label": None}
    if not text:
        return res
    up = _norm_diacritics(text).upper()

    def _first(labels):
        for label in labels:
            pat = label.replace(" ", r"\s+") + r"[^\d\-]{0,40}?(" + _NUM_RE + r")"
            m = re.search(pat, up)
            if m:
                v = _parse_money(m.group(1))
                if v is not None:
                    return v, label
        return None, None

    res["opening"], res["opening_label"] = _first(_OPENING_BAL_LABELS)
    res["closing"], res["closing_label"] = _first(_CLOSING_BAL_LABELS)
    return res


# Strip Romanian diacritics + the ﬁ/ﬂ OCR ligatures so printed labels match
# regardless of how the OCR rendered them (UniCredit prints "Sold inițial" /
# "Sold ﬁnal" — the ț and the ﬁ ligature defeated a plain .upper() match).
_DIACRITICS = str.maketrans({
    "ă": "a", "â": "a", "î": "i", "ș": "s", "ş": "s", "ț": "t", "ţ": "t",
    "Ă": "A", "Â": "A", "Î": "I", "Ș": "S", "Ş": "S", "Ț": "T", "Ţ": "T",
    "ﬁ": "fi", "ﬂ": "fl",
})


def _norm_diacritics(s: Any) -> str:
    return str(s or "").translate(_DIACRITICS)


# Account-summary control totals (UniCredit "SUMAR CONT" and similar): the printed
# Σdebit / Σcredit / opening / closing. Each value is the first number AFTER its
# label (the OCR often glues it onto the next line). Labels are matched on the
# diacritic/ligature-normalized text.
_SUMMARY_TOTAL_LABELS = {
    "opening": ("SOLD INITIAL", "SOLD PRECEDENT", "SOLD ANTERIOR", "SOLD LA INCEPUTUL"),
    "closing": ("SOLD FINAL", "SOLD LA SFARSITUL", "SOLD INCHIDERE"),
    "total_debit": ("SUME DEBITATE", "TOTAL DEBIT", "RULAJ DEBITOR", "TOTAL DEBITE"),
    "total_credit": ("SUME CREDITATE", "TOTAL CREDIT", "RULAJ CREDITOR", "TOTAL CREDITE"),
}


def parse_account_summary_totals(text: str) -> Dict[str, Any]:
    """Parse the printed account-summary control totals (opening, closing,
    Σdebit, Σcredit). Diacritic/ligature tolerant. Returns a dict with None where a
    label wasn't found. These are the ground truth a statement must sum to — the
    UniCredit analogue of BT's RULAJ totals.

    Handles two OCR layouts of the same SUMAR CONT block:
      * interleaved  "Sold inițial 5,836.54  Sume debitate 49,382.48 …" (PyPDF2)
      * table        "Sold inițial Sume debitate Sume creditate Sold final\n
                      5,836.54 49,382.48 43,546.19 0.25"                (Textract)
    The table layout is why a naive "first number after the label" grabbed the same
    first value (5,836.54) for ALL FOUR labels — so here we map values to labels by
    POSITION when the labels cluster ahead of the numbers."""
    res: Dict[str, Any] = {"opening": None, "closing": None,
                           "total_debit": None, "total_credit": None}
    if not text:
        return res
    up = _norm_diacritics(text).upper()

    # First occurrence (start, end) of each total's label, using its earliest synonym.
    found: Dict[str, Tuple[int, int]] = {}
    for key, labels in _SUMMARY_TOTAL_LABELS.items():
        best: Optional[Tuple[int, int]] = None
        for label in labels:
            m = re.search(label.replace(" ", r"\s+"), up)
            if m and (best is None or m.start() < best[0]):
                best = (m.start(), m.end())
        if best:
            found[key] = best
    if not found:
        return res

    region_start = min(s for s, _ in found.values())
    region = up[region_start:region_start + 600]
    last_label_end = max(e for _, e in found.values()) - region_start
    nums = [
        (m.start(), _parse_money(m.group(1)))
        for m in re.finditer(r"(" + _NUM_RE + r")", region)
        if _parse_money(m.group(1)) is not None
    ]
    labels_sorted = sorted((s - region_start, key) for key, (s, _e) in found.items())

    if nums and nums[0][0] >= last_label_end:
        # Table layout: every value sits after every label → map by position.
        for (_lp, key), (_np, val) in zip(labels_sorted, nums):
            res[key] = val
    else:
        # Interleaved: each label's value is the first number before the next label.
        for i, (lp, key) in enumerate(labels_sorted):
            nxt = labels_sorted[i + 1][0] if i + 1 < len(labels_sorted) else 10 ** 9
            res[key] = next((v for pos, v in nums if lp <= pos < nxt), None)

    # Degenerate guard: a real summary's four numbers aren't all identical. All-equal
    # means the parse collapsed (e.g. grabbed the first value for every label) — drop
    # it rather than letting a bogus "control total" clobber a correct closing balance.
    vals = [res[k] for k in ("opening", "total_debit", "total_credit", "closing")]
    present = [v for v in vals if v is not None]
    if len(present) >= 3 and len(set(present)) == 1:
        return {"opening": None, "closing": None, "total_debit": None, "total_credit": None}
    return res


def _row_mag(t: Dict[str, Any]) -> float:
    """A row's amount magnitude regardless of the (possibly wrong) side it's on."""
    d = _f(t.get("debit_amount"))
    c = _f(t.get("credit_amount"))
    return abs(d) if d else (abs(c) if c else 0.0)


def _set_direction(t: Dict[str, Any], direction: str) -> bool:
    """Force a row onto ``debit`` or ``credit`` keeping its magnitude. Returns True
    if the side actually changed."""
    mag = _row_mag(t)
    if mag == 0:
        return False
    before_d, before_c = _f(t.get("debit_amount")), _f(t.get("credit_amount"))
    if direction == "debit":
        t["debit_amount"], t["credit_amount"] = mag, None
        return not (before_d and not before_c)
    t["credit_amount"], t["debit_amount"] = mag, None
    return not (before_c and not before_d)


def repair_directions_from_control_totals(
    data: Dict[str, Any], total_debit: Optional[float], total_credit: Optional[float],
    tol: float = 1.0,
) -> Dict[str, Any]:
    """Fix debit/credit DIRECTIONS the OCR column-linearization destroyed, using the
    printed control totals as ground truth.

    UniCredit card statements encode direction in the row TYPE — an "Amount …" line
    is a credit (card sale in), a "Fee/Amount …" line is a debit (settlement out) —
    but PyPDF2 glues the Debit|Credit columns, so the model guesses and flips some.
    We partition rows by that type, try BOTH type→direction mappings, and apply the
    one that reproduces BOTH printed totals within ``tol``. Self-validating: applied
    only when it makes Σdebit/Σcredit match the statement, so it can never worsen a
    statement whose amounts (not just sides) are wrong. No-op unless control totals
    are present and the rows currently disagree with them."""
    txns = [t for t in (data.get("transactions") or []) if isinstance(t, dict)]
    if not txns or total_debit is None or total_credit is None:
        return {"applied": False, "reason": "no control totals"}

    cur_d = sum(abs(_f(t.get("debit_amount")) or 0.0) for t in txns)
    cur_c = sum(abs(_f(t.get("credit_amount")) or 0.0) for t in txns)
    if abs(cur_d - total_debit) <= tol and abs(cur_c - total_credit) <= tol:
        return {"applied": False, "reason": "rows already match control totals"}

    def _kind(t: Dict[str, Any]) -> str:
        desc = _norm_diacritics(t.get("description")).lower().replace(" ", "")
        if "fee/amount" in desc:
            return "fee"
        if "amount" in desc:
            return "amount"
        return "other"

    groups = {"fee": [], "amount": [], "other": []}
    for t in txns:
        groups[_kind(t)].append(t)
    sum_fee = sum(_row_mag(t) for t in groups["fee"])
    sum_amount = sum(_row_mag(t) for t in groups["amount"])
    other_d = sum(abs(_f(t.get("debit_amount")) or 0.0) for t in groups["other"])
    other_c = sum(abs(_f(t.get("credit_amount")) or 0.0) for t in groups["other"])

    # mapping A: Amount→credit, Fee/Amount→debit ; mapping B is the mirror.
    dA, cA = sum_fee + other_d, sum_amount + other_c
    dB, cB = sum_amount + other_d, sum_fee + other_c

    def _ok(d, c):
        return abs(d - total_debit) <= tol and abs(c - total_credit) <= tol

    if _ok(dA, cA) and not _ok(dB, cB):
        amount_dir, fee_dir = "credit", "debit"
    elif _ok(dB, cB) and not _ok(dA, cA):
        amount_dir, fee_dir = "debit", "credit"
    else:
        return {
            "applied": False, "reason": "no unambiguous mapping reconciles to totals",
            "cur": (round(cur_d, 2), round(cur_c, 2)),
            "target": (round(total_debit, 2), round(total_credit, 2)),
            "mapA": (round(dA, 2), round(cA, 2)), "mapB": (round(dB, 2), round(cB, 2)),
            "rows": {k: len(v) for k, v in groups.items()},
        }

    flips = sum(_set_direction(t, amount_dir) for t in groups["amount"])
    flips += sum(_set_direction(t, fee_dir) for t in groups["fee"])
    return {
        "applied": True, "amount_dir": amount_dir, "fee_dir": fee_dir, "flips": flips,
        "rows": {k: len(v) for k, v in groups.items()},
    }


# CUIs that belong to the BANK itself (printed in the page-1 letterhead), never the
# account holder — the model sometimes grabs these as company_ein.
_KNOWN_BANK_CUIS = {"361536"}  # UniCredit Bank S.A.
_BANK_LETTERHEAD_MARKERS = (
    "REGISTRUL COMERTULUI", "CAPITAL SOCIAL", "SWIFT", "REGISTRUL BANCAR",
    "MEMBRA A", "UNICREDIT GROUP",
)


def strip_bank_own_company_ein(data: Dict[str, Any], text: str) -> bool:
    """Blank ``company_ein`` when it's the BANK's own CUI rather than the holder's.

    On UniCredit the holder's CUI isn't printed in the header at all, so the model
    grabs the bank's (361536, in the "Cod unic de înregistrare: 361536" letterhead).
    Showing the bank's CUI as the company's is worse than showing none. Drop it if
    it's a known bank CUI, or if every occurrence in the text sits in a bank
    letterhead line. Returns True if blanked."""
    ein = str(data.get("company_ein") or "").strip()
    if not ein:
        return False
    if ein in _KNOWN_BANK_CUIS:
        data["company_ein"] = ""
        return True
    norm = _norm_diacritics(text or "").upper()
    occ = [m.start() for m in re.finditer(re.escape(ein), norm)]
    if occ and all(
        any(mk in norm[max(0, p - 130):p + 130] for mk in _BANK_LETTERHEAD_MARKERS)
        for p in occ
    ):
        data["company_ein"] = ""
        return True
    return False


def _row_amount(row: Dict[str, Any]) -> Optional[float]:
    """The transaction magnitude regardless of which side the model assigned."""
    for key in ("debit_amount", "credit_amount"):
        v = row.get(key)
        if isinstance(v, (int, float)):
            return abs(float(v))
    return None


def _subset_summing_to(amounts: List[float], target: float) -> Optional[List[int]]:
    """Indices of a subset of ``amounts`` summing to ``target`` (in cents), or None.

    Small per-day row counts keep this DP cheap; capped as a runaway guard.
    """
    if target < 0:
        return None
    cents = [int(round(a * 100)) for a in amounts]
    tgt = int(round(target * 100))
    if tgt == 0:
        return []
    if len(cents) > 40 or tgt > 100_000_00:
        return None
    # reachable sum -> list of indices producing it (first one wins).
    reachable: Dict[int, List[int]] = {0: []}
    for i, c in enumerate(cents):
        for s, idxs in list(reachable.items()):
            ns = s + c
            if ns <= tgt and ns not in reachable:
                reachable[ns] = idxs + [i]
        if tgt in reachable:
            break
    return reachable.get(tgt)


def _desc_prefix(row: Dict[str, Any], n: int = 32) -> str:
    """A short, single-line description prefix for compact trace payloads."""
    s = " ".join(str(row.get("description", "") or "").split())
    return s if len(s) <= n else (s[:n] + "…")


def _set_side(row: Dict[str, Any], amount: float, *, credit: bool) -> bool:
    """Force a row to the debit or credit side; return True if it changed sides."""
    had_credit = isinstance(row.get("credit_amount"), (int, float))
    had_debit = isinstance(row.get("debit_amount"), (int, float))
    changed = (credit and had_debit and not had_credit) or (
        not credit and had_credit and not had_debit
    )
    if changed and TRACE.enabled:
        try:
            TRACE.stage(
                "bt_recon_signflip",
                row=f"{row.get('transaction_date')} {amount} {_desc_prefix(row)}",
                from_side="credit" if had_credit else "debit",
                to_side="credit" if credit else "debit",
                amount=amount,
            )
        except Exception:
            pass
    if credit:
        row["credit_amount"] = amount
        row["debit_amount"] = None
        if changed or row.get("transaction_type") not in ("deposit", "transfer"):
            row["transaction_type"] = "deposit"
    else:
        row["debit_amount"] = amount
        row["credit_amount"] = None
        if changed:
            desc = str(row.get("description", "")).lower()
            row["transaction_type"] = (
                "withdrawal"
                if any(k in desc for k in ("atm", "numerar", "retragere"))
                else "payment"
            )
    return changed


def reconcile_bt_statement(
    data: Dict[str, Any], text: str
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Repair debit/credit signs and the closing balance from BT control totals.

    Mutates and returns ``data`` (so callers can ignore the return) plus a report.
    Safe and side-effect-free on non-BT statements: returns ``{"applied": False}``.
    """
    report: Dict[str, Any] = {"applied": False}
    controls = parse_bt_controls(text or "")
    if controls is None:
        return data, report

    # Anchor the balances to the printed control figures.
    if controls.get("opening") is not None:
        data["opening_balance"] = controls["opening"]
    if controls.get("closing") is not None:
        data["closing_balance"] = controls["closing"]

    header_fixed = _recover_bt_header(data, text or "")

    txns = data.get("transactions") or []
    days_meta = controls["days"]

    # Group transaction indices by day.
    by_day: Dict[Tuple[int, int, int], List[int]] = {}
    for i, t in enumerate(txns):
        dk = _date_key(t.get("transaction_date"))
        if dk is not None:
            by_day.setdefault(dk, []).append(i)

    signs_corrected = 0
    reconciled_days: List[Tuple[int, int, int]] = []
    unreconciled: List[Tuple[int, int, int]] = []

    for dk, idxs in by_day.items():
        ctrl = days_meta.get(dk)
        if not ctrl:
            continue
        td, tc = ctrl.get("debit"), ctrl.get("credit")
        if td is None or tc is None:
            continue
        rows = [txns[i] for i in idxs]
        amounts = [_row_amount(r) or 0.0 for r in rows]

        if abs(tc) <= _TOL:
            # No credits printed that day -> every row is a debit.
            for r, a in zip(rows, amounts):
                signs_corrected += _set_side(r, a, credit=False)
        elif abs(td) <= _TOL:
            # No debits printed that day -> every row is a credit.
            for r, a in zip(rows, amounts):
                signs_corrected += _set_side(r, a, credit=True)
        elif abs(sum(amounts) - (td + tc)) <= _TOL:
            # Mixed, complete day: the subset summing to the credit turnover are
            # the credits, the rest debits.
            subset = _subset_summing_to(amounts, tc)
            if subset is not None:
                cred = set(subset)
                for j, (r, a) in enumerate(zip(rows, amounts)):
                    signs_corrected += _set_side(r, a, credit=(j in cred))
            else:
                unreconciled.append(dk)
                continue
        else:
            # A row the model missed or invented — can't trust the day; flag it.
            unreconciled.append(dk)
            continue

        # Verify the (now-signed) rows match the printed turnover.
        ds = sum(a for r, a in zip(rows, amounts) if r.get("debit_amount") is not None)
        cs = sum(a for r, a in zip(rows, amounts) if r.get("credit_amount") is not None)
        if abs(ds - td) <= _TOL and abs(cs - tc) <= _TOL:
            reconciled_days.append(dk)
        else:
            unreconciled.append(dk)

        # Observability: per reconciled-day summary of the side assignment the loop
        # just made — which rows ended up credit vs debit, against the printed RULAJ.
        if TRACE.enabled:
            try:
                d, m, y = dk
                credits_assigned = [
                    f"{a} {_desc_prefix(r)}"
                    for r, a in zip(rows, amounts)
                    if r.get("credit_amount") is not None
                ]
                debits_assigned = [
                    f"{a} {_desc_prefix(r)}"
                    for r, a in zip(rows, amounts)
                    if r.get("debit_amount") is not None
                ]
                TRACE.stage(
                    "bt_recon_day",
                    date=f"{d:02d}-{m:02d}-{y}",
                    rulaj_debit=td,
                    rulaj_credit=tc,
                    rows=len(rows),
                    credits_assigned=credits_assigned,
                    debits_assigned=debits_assigned,
                )
            except Exception:
                pass

    _rewalk_balances(txns, by_day, days_meta, controls.get("opening"), set(reconciled_days))

    report.update(
        applied=True,
        opening_balance=controls.get("opening"),
        closing_balance=controls.get("closing"),
        header_fixed=header_fixed,
        signs_corrected=signs_corrected,
        days_total=sum(1 for dk in by_day if dk in days_meta),
        days_reconciled=len(reconciled_days),
        unreconciled_days=[f"{d:02d}-{m:02d}-{y}" for (d, m, y) in unreconciled],
    )
    data["_recon"] = report
    return data, report


def _rewalk_balances(
    txns: List[Dict[str, Any]],
    by_day: Dict[Tuple[int, int, int], List[int]],
    days_meta: Dict[Tuple[int, int, int], Dict[str, Optional[float]]],
    opening: Optional[float],
    reconciled_days: set,
) -> None:
    """Recompute balance_after_transaction for reconciled days by walking the
    running balance from each day's opening (prior day's SOLD FINAL ZI)."""
    if not reconciled_days:
        return
    ordered = sorted(d for d in days_meta if days_meta[d].get("sold_final") is not None)
    # Day-start balance = opening for the first day, else prior day's SOLD FINAL ZI.
    start_of: Dict[Tuple[int, int, int], Optional[float]] = {}
    prev = opening
    for dk in ordered:
        start_of[dk] = prev
        prev = days_meta[dk].get("sold_final")

    for dk in reconciled_days:
        bal = start_of.get(dk)
        if bal is None:
            continue
        for i in by_day.get(dk, []):
            t = txns[i]
            bal = bal - (t.get("debit_amount") or 0.0) + (t.get("credit_amount") or 0.0)
            t["balance_after_transaction"] = round(bal, 2)


# ---------------------------------------------------------------------------
# Balance-chain reconciliation (provider/bank-agnostic)
#
# Every statement is arithmetically over-determined: closing == opening + Σcredit
# − Σdebit, and each row's printed running balance == previous ± its amount. We use
# that to (a) judge whether an extraction is trustworthy and (b) deterministically
# drop phantom/duplicate rows — without a model call, and without ever fabricating
# or reordering rows.
# ---------------------------------------------------------------------------

def _f(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).replace(",", "").strip())
    except (ValueError, TypeError):
        return None


def statement_sum_gap(data: Dict[str, Any]) -> Optional[float]:
    """|opening + Σcredit − Σdebit − closing|, using positive magnitudes.

    The discrepancy between the statement's printed closing balance and what its
    rows actually sum to. 0 ⇒ reconciles. None when opening/closing aren't both
    present (nothing to check against)."""
    opening = _f(data.get("opening_balance"))
    closing = _f(data.get("closing_balance"))
    txns = data.get("transactions")
    if opening is None or closing is None or not isinstance(txns, list):
        return None
    sd = sc = 0.0
    for t in txns:
        if not isinstance(t, dict):
            continue
        d = _f(t.get("debit_amount"))
        c = _f(t.get("credit_amount"))
        if d:
            sd += abs(d)
        if c:
            sc += abs(c)
    return abs(opening + sc - sd - closing)


def statement_reconciles(data: Dict[str, Any], tol: float = 0.5) -> bool:
    gap = statement_sum_gap(data)
    return gap is not None and gap <= tol


def reconcile_balance_chain(data: Dict[str, Any], tol: float = 0.02) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Drop phantom/duplicate rows using each row's printed running balance.

    A genuine row moves the running balance by (credit − debit); a row whose
    ``balance_after_transaction`` is UNCHANGED from the prior row yet carries a
    nonzero amount is a re-booked / duplicated movement (e.g. an ATM withdrawal
    listed twice) — it inflates the totals and breaks reconciliation, so it is
    dropped. Conservative: never fabricates, reorders, or edits amounts; if the
    statement doesn't print usable running balances it does nothing. Reports whether
    the result reconciles (sum check) and how many unexplained balance jumps remain
    (a proxy for missing/misread rows the chain can flag but not safely invent).

    Returns ``(data, info)``.
    """
    txns = data.get("transactions")
    if not isinstance(txns, list) or not txns:
        return data, {"applied": False, "reason": "no transactions",
                      "reconciled": statement_reconciles(data)}

    rows = [t for t in txns if isinstance(t, dict)]
    bals = [_f(t.get("balance_after_transaction")) for t in rows]
    present = [b for b in bals if b is not None]
    # Need running balances on most rows AND real variation; otherwise the chain is
    # unusable (e.g. a statement that doesn't print per-row balances) — do nothing.
    if len(present) < 0.8 * len(rows) or len(set(present)) < max(2, len(present) // 2):
        return data, {"applied": False, "reason": "no usable running balances",
                      "reconciled": statement_reconciles(data)}

    running = _f(data.get("opening_balance"))
    kept: List[Dict[str, Any]] = []
    dropped = breaks = 0
    for t in rows:
        d = abs(_f(t.get("debit_amount")) or 0.0)
        c = abs(_f(t.get("credit_amount")) or 0.0)
        amt = c - d
        bal = _f(t.get("balance_after_transaction"))
        if running is not None and bal is not None and abs(bal - running) <= tol and abs(amt) > tol:
            dropped += 1            # phantom: balance didn't move despite an amount
            continue
        kept.append(t)
        if bal is not None:
            if running is not None and abs(bal - (running + amt)) > tol:
                breaks += 1
            running = bal           # trust the printed balance; resync after a break
        elif running is not None:
            running += amt

    if dropped:
        # Closing-balance anchor: a row whose printed running balance the model MISREAD
        # (e.g. two near-identical adjacent ATM withdrawals where the second copied the
        # first's balance) looks like a phantom here, but it is a REAL transaction —
        # dropping it makes the statement stop summing to the printed closing balance.
        # A true duplicate inflates the totals, so removing it REDUCES the gap to the
        # printed closing; a misread-but-real row does the opposite. The printed closing
        # is the oracle: only commit the drops if they don't worsen reconciliation.
        kept_data = dict(data)
        kept_data["transactions"] = kept
        orig_gap = statement_sum_gap(data)
        kept_gap = statement_sum_gap(kept_data)
        if orig_gap is not None and (kept_gap is None or kept_gap > orig_gap + tol):
            kept, dropped = rows, 0            # drops broke reconciliation → real rows
        else:
            data = kept_data

    info = {
        "applied": dropped > 0,
        "dropped": dropped,
        "breaks": breaks,
        "row_count": len(kept),
        "reconciled": statement_reconciles(data),
        "final_balance": running,
        "closing": _f(data.get("closing_balance")),
    }
    return data, info
