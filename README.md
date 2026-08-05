# AutoImport — platformă pentru importatori de mașini second-hand

Back-office + operations SaaS for Romanian dealerships importing used cars from the EU:
document management, LLM document extraction, contract generation, and RO e-Transport
(cod UIT). Multi-tenant, Romanian-first UI, mobile-first.

## Architecture

| Piece | Stack | Path |
|---|---|---|
| API | NestJS + Prisma + PostgreSQL (pgvector) + S3 | `backend/` |
| Extraction worker | Finova Python engine: strict structured outputs + CrewAI fallback + Textract/vision | `worker/finova/` |
| Web app | React + Vite + TS + Redux Toolkit + Tailwind v4 | `frontend/` |
| Infra (local) | Postgres (pgvector) + MinIO | `docker-compose.yml` |
| Infra (production) | Immutable containers + migrations + backups | `docker-compose.production.yml`, `deploy/` |

### How extraction works
1. Upload lands in **S3 first**, then a `PendingUpload` row — the durable queue.
2. A cron worker claims rows via an **atomic compare-and-set** and runs Finova's separate,
   resumable **phase 0** classification and **phase 1** typed extraction subprocesses with
   independent bounded-concurrency lanes. The queue persists each phase result and exposes
   `QUEUED → PROCESSING → PHASE0_COMPLETE → PHASE1_COMPLETE → COMPLETED`, plus retry,
   cancellation and split-parent states.
3. The copied Finova engine runs strict Pydantic structured outputs, provider routing,
   PDF text + Textract Analyze/Expense + LLM vision, scoped repair, its 627-account
   embedding chart, deterministic validation and calibrated
   per-field confidence. AutoImport adds vehicle-aware invoice, receipt and private-purchase
   contract fields, plus strict CMR and vehicle registration schemas, to the same registry.
4. Deterministic validators (VIN format, VAT arithmetic and date sanity)
   cap per-field confidence and flag `needsReview`; the review drawer orders flagged fields
   first, displays validation evidence, and can hide high-confidence auto-accepted fields.
5. User corrections are persisted (`UserCorrection`) and fed back as examples on future
   extractions for every document type. A recovery sweep re-queues stuck rows with
   exponential backoff and a poison-pill retry cap.
6. Optional Finova batch-scan segmentation (`PENDING_UPLOAD_SPLIT_ENABLED=true`) detects
   document boundaries in combined PDFs and fans them out as independently processed children.

### Feature map
- **Vehicles**: a purchase invoice/private purchase contract creates or enriches the stock
  card by VIN; CMR and registration documents attach to the same car. Manual creation remains
  an exception path. Lifecycle SOURCED→…→DELIVERED, costs → landed cost → margin per car.
- **Documents**: dedupe by hash, side-by-side PDF/image review, line-level accounting
  corrections, proposed debit/credit notes, explicit approval and reversible reopening.
- **Accounting**: approval-only balanced journal entries, idempotent posting, partner/article/
  management catalogues and a read-only journal. Existing documents remain legacy; only
  documents uploaded after each tenant's accounting cutover enter this flow. Approved incoming
  invoices/independent receipts linked to a car also create document-backed landed-cost rows.
- **Contracts**: generate *contract de vânzare-cumpărare* / *proces-verbal* PDFs
  (embedded Unicode fonts, price in words in Romanian, per-tenant number sequences), stored
  back as documents. Full-text templates are editable per company in Settings, support safe
  data placeholders and PDF preview, and existing generated files can be regenerated in place. An
  uploaded private-person vehicle purchase contract creates the vehicle/seller catalogue
  records from extracted identity data and, after review, posts `371 = 462`.
- **SAGA export**: `/exporturi` previews and generates `SAGA_Export_<date>.zip` with
  Facturi, Încasări, Plăți, Furnizori, Clienți and Articole XML. Only approved post-cutover
  documents are included; approved private vehicle purchase contracts enter Facturi with
  a generated car line. Încasări/Plăți come from approved receipts and cash/payment
  dispositions in the journal—never from bank reconciliation. Empty selected files are
  omitted. The old invoice/partner endpoints remain temporary compatibility wrappers.
- **e-Transport**: declaration pre-filled from the acquisition invoice/contract, a pasted
  WhatsApp/email transport message, and the company's Drive table matched by VIN. The table
  supplies `MASA` and unloading `LOCATIE`; CMR and registration documents are not required
  for UIT. Includes XML build, ANAF OAuth2 (logincert), status polling → UIT and a printable
  UIT sheet. *Validate the XML against the current ANAF XSD before production.*
- **Cross-cutting**: JWT access+refresh, roles, tenant scoping on every query,
  audit log (e-Transport/contracts/deletes), graceful degradation when
  ANAF/LLM credentials are missing.

### User workflow

1. Complete company/CUI and accounting settings, then upload the acquisition invoice or
   private purchase contract in **Documents**.
2. Wait for extraction, verify VIN, make/model/year, seller, price, dates, VAT and accounting
   lines, and correct any flagged value.
3. Approve the document. The system confirms/updates the vehicle by VIN, posts the accounting
   entry, and makes the approved document eligible for SAGA.
4. For UIT, select the vehicle. The app combines its invoice/contract with the logistics row
   whose `SERIE SASIU` matches the VIN, then the user pastes the transporter WhatsApp/email
   message and verifies the completed declaration. CMR and registration papers may still be
   archived later, but they are not inputs to UIT.
5. Upload transport, registration, ITP, refurbishment and other supplier invoices/receipts,
   assign a vehicle if the VIN is not printed, select a document-wide cost category or one
   category per line, and explicitly confirm the category review before approval. Their
   economic amounts become categorized vehicle costs; ITP/customs/etc. remain cost
   categories, not special upload types.
6. Mark the vehicle **IN_STOCK** when physically received and ready, then export the approved
   period from **SAGA exports**. Use manual vehicle/cost entry only for missing source documents
   or exceptional adjustments.

## Local development

```bash
# 1. Infra (Postgres with pgvector + MinIO with auto-created bucket)
docker compose up -d

# 2. Backend
cd backend
cp ../.env.example .env          # fill in OPENAI_API_KEY (+ another provider key if selected)
npm install
npm run prisma:migrate           # versioned schema on a new database
npm run build && npm start       # or: npm run dev

# 3. Worker deps (used as a subprocess by the backend)
cd ../worker
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 4. Frontend (proxies /api → :3000) — needs Node ≥ 20 (Tailwind v4 native binding)
cd ../frontend
nvm use                          # picks up .nvmrc (22)
npm install
npm run dev                      # http://localhost:5173
```

Register a company from the login screen (the first user becomes ACCOUNTANT).

An older local database created with `prisma db push` must be baselined once;
follow [backend/prisma/BASELINING.md](backend/prisma/BASELINING.md) instead of
running the initial migration over its existing tables.

## Acceptance and parity tests

```bash
# Exact byte-for-byte parity for all six Finova SAGA XML files,
# accounting/posting coverage, authorization and HTTP workflows
cd backend
npm test

# Real extraction (optional; requires a real PDF/image and LLM/OCR credentials)
LIVE_EXTRACTION_FILE=/absolute/path/invoice.pdf npm run test:extraction:live

# Real browser acceptance: desktop + 360 px mobile, PDF review modal,
# documents/search, vehicles, e-Transport and SAGA re-export
cd ../frontend
npx playwright install chromium
npm run test:e2e
```

The SAGA golden fixture records the Finova source commit and compares both
formatters byte-for-byte for Facturi, Încasări, Plăți, Furnizori, Clienți and
Articole. See
[backend/test/fixtures/saga-finova/README.md](backend/test/fixtures/saga-finova/README.md).
CI repeats the clean migration, backend suite, production builds, and desktop/mobile
browser suite on every pull request.

The one non-automatable acceptance step is importing a representative ZIP in
the beneficiary's licensed SAGA installation. Use
[docs/saga-beneficiary-acceptance.md](docs/saga-beneficiary-acceptance.md) to
record that sign-off.

## Production delivery

Production uses the versioned Prisma migration before starting the API, waits
for PostgreSQL/MinIO readiness, and runs daily database plus document-store
backups with retention. Setup, upgrade, backup verification, and guarded restore
instructions are in
[docs/production-deployment.md](docs/production-deployment.md).

## Configuration notes
- **LLM**: the Finova default is the pinned `FINOVA_EXTRACTION_LLM_MODEL=gpt-4o-mini-2024-07-18`.
  `OPENAI_API_KEY` is required by the copied Finova preflight and embedding-based Romanian
  account shortlist. Claude, Gemini and OpenRouter model identifiers additionally need their
  matching provider key.
- **PDF runtime**: `pdf2image` needs Poppler installed on the host. Textract is optional and
  uses `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION`.
- **ANAF**: needs a qualified certificate enrolled in SPV; set `ANAF_CLIENT_ID/SECRET`
  and complete the OAuth2 flow per tenant. Defaults point at the ANAF **test** endpoint.
- **e-Transport Drive table**: enable the Google Drive API, create a service account and share
  the XLSX or native Google Sheet with its `client_email` as **Viewer**. Set
  `ETRANSPORT_DRIVE_FILE_ID` (a full Drive URL is also accepted) and put the one-line JSON key
  or its base64 representation in `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON`. If the workbook has
  several sheets, set `ETRANSPORT_DRIVE_SHEET_NAME`; otherwise the first sheet is used. The
  header row must contain `SERIE SASIU`, `MASA` and `LOCATIE`; `COD INTERN` is ignored because
  it is not part of the UIT declaration. `MASA` is interpreted as kilograms and `LOCATIE` as
  the Romanian unloading city. Data is cached for five minutes by default. An ACCOUNTANT can
  test or force refresh through `GET /api/etransport/drive/status` and
  `POST /api/etransport/drive/refresh`; responses never include credentials or the file ID.
- **Accuracy**: the deterministic Finova SAGA golden fixture protects XML parity.
  Add reviewed real documents to the live extraction acceptance corpus as beneficiary
  examples become available.

## Deliberately out of scope in this slice
Bank-statement reconciliation, transaction matching, Open Banking, manual journal entries,
financial reports, closing, payroll, stock, fixed assets, email/WhatsApp capture channels,
e-Factura/UBL, PWA manifest and e-signature.
