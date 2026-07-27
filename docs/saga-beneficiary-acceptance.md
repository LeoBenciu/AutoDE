# SAGA beneficiary acceptance

This is the final external acceptance test. It must be run in the beneficiary's
licensed SAGA installation by, or together with, the beneficiary's accountant.
Automated tests cannot substitute for this import.

## Test package

Use a dedicated tenant and an agreed date range containing at least:

- an incoming invoice with multiple VAT rates;
- a private-person vehicle purchase contract with a reviewed CNP/foreign identifier;
- a vehicle cost invoice with its reviewed category;
- an outgoing invoice;
- an independent incoming and outgoing receipt;
- a receipt linked to an invoice;
- a payment disposition and a collection disposition;
- a partial payment;
- foreign currency plus exchange rate;
- reverse charge or non-deductible VAT, when applicable to the beneficiary;
- one supplier, client, and article not already present in the SAGA test company.

Approve every selected document, review its balanced journal preview, then
generate all six export types from `/exporturi`. Record preview counts and
blocking/excluded items before downloading the ZIP.

## Import checklist

- [ ] Create or restore an isolated SAGA test company backup.
- [ ] Record the SAGA product and exact version.
- [ ] Import `F_<CUI>_<date>.xml`.
- [ ] Import `I_<date>.xml`.
- [ ] Import `P_<date>.xml`.
- [ ] Import `FUR_<date>.xml`.
- [ ] Import `CLI_<date>.xml`.
- [ ] Import `ART_<date>.xml`.
- [ ] Confirm empty XML types were omitted exactly as shown in preview.
- [ ] Confirm invoice numbers, dates, currency, VAT, deductibility, units,
      management, article, and partner analytics.
- [ ] Confirm the private purchase contract imports with the expected vehicle
      line and private-seller payable treatment.
- [ ] Confirm the reviewed vehicle-cost document imports once and its amount
      matches the landed-cost row in AutoImport.
- [ ] Confirm every receipt/disposition appears exactly once in Încasări or
      Plăți and never in both.
- [ ] Confirm partial payments reference the intended invoice.
- [ ] Compare debit/credit totals with AutoImport's read-only journal.
- [ ] Confirm there are no unexpected SAGA warnings or rejected rows.
- [ ] Restore the original SAGA company backup after testing.

## Evidence and sign-off

| Field | Value |
|---|---|
| AutoImport commit | |
| Tenant / company CUI | |
| Export date range | |
| ZIP SHA-256 | |
| SAGA product/version | |
| Imported row counts | |
| SAGA warnings/errors | |
| Tested by | |
| Test date | |
| Beneficiary approval | |

Attach the exported ZIP hash, AutoImport preview screenshot, SAGA import log,
and screenshots of representative imported documents. Do not commit the ZIP or
screenshots when they contain personal, fiscal, or banking data.
