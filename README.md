# AutoImport — platformă pentru importatori de mașini second-hand

Back-office + operations SaaS for Romanian dealerships importing used cars from the EU:
document management, LLM document extraction, contract generation, and RO e-Transport
(cod UIT). Multi-tenant, Romanian-first UI, mobile-first.

## Architecture

| Piece | Stack | Path |
|---|---|---|
| API | NestJS + Prisma + PostgreSQL (pgvector) + S3 | `backend/` |
| Extraction worker | Python 3.11 + Anthropic structured outputs + pypdf (+ optional Textract) | `worker/` |
| Web app | React + Vite + TS + Redux Toolkit + Tailwind v4 | `frontend/` |
| Infra (local) | Postgres (pgvector) + MinIO | `docker-compose.yml` |

### How extraction works
1. Upload lands in **S3 first**, then a `PendingUpload` row — the durable queue.
2. A cron worker claims rows via an **atomic compare-and-set**, spawns `worker/main.py`
   (bounded concurrency lane), which runs: multi-source OCR (PDF text layer with per-page
   char floor → optional Textract with a **ratio guard** → LLM vision fallback) →
   **phase 0** categorization → **phase 1** typed extraction (Pydantic schema registry:
   Invoice, CMR, Customs, Registration Certificate, ITP, Insurance, Bank Statement, …).
3. Deterministic validators (VIN format+check digit, VAT arithmetic, date sanity,
   statement balance) cap per-field confidence and flag `needsReview`.
4. User corrections are persisted (`UserCorrection`) and fed back as context on future
   extractions; a recovery sweep re-queues stuck rows with a poison-pill retry cap.

### Feature map
- **Vehicles**: lifecycle SOURCED→…→DELIVERED, costs → landed cost → margin per car.
- **Documents**: dedupe by hash, needs-review UI with inline field corrections.
- **Contracts**: generate *contract de vânzare-cumpărare* / *proces-verbal* PDFs
  (price in words in Romanian, per-tenant number sequences), stored back as documents.
- **SAGA export**: processed invoices export to the SAGA C XML import format
  (`GET /api/saga/export.xml?from&to`, plus CSV) — Furnizor/Client mapped from the
  extracted fields so SAGA routes Intrări/Ieșiri by CIF itself; non-RO suppliers are
  marked taxare inversă. *Confirm the date format against the client's SAGA build on
  the first import test.*
- **e-Transport**: declaration pre-filled from extracted CMR/invoice, XML build,
  ANAF OAuth2 (logincert) client with proactive token refresh, status polling → UIT,
  printable UIT sheet. *Validate the XML against the current ANAF XSD before production.*
- **Cross-cutting**: JWT access+refresh, roles, tenant scoping on every query,
  audit log (e-Transport/contracts/deletes), graceful degradation when
  ANAF/LLM credentials are missing.

## Local development

```bash
# 1. Infra (Postgres with pgvector + MinIO with auto-created bucket)
docker compose up -d

# 2. Backend
cd backend
cp ../.env.example .env          # fill in ANTHROPIC_API_KEY at minimum
npm install
npm run prisma:push              # creates schema + vector extension
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

Register a company from the login screen (first user becomes OWNER).

## Configuration notes
- **LLM**: `EXTRACTION_MODEL=claude-opus-4-8` (default) or `claude-sonnet-4-6` for
  cost-sensitive volume. Without `ANTHROPIC_API_KEY`, uploads queue and fail with a clear error.
- **ANAF**: needs a qualified certificate enrolled in SPV; set `ANAF_CLIENT_ID/SECRET`
  and complete the OAuth2 flow per tenant. Defaults point at the ANAF **test** endpoint.
- **Accuracy**: build the golden set early — mint golden cases from review-UI corrections;
  a 20-doc eval is noise.

## Deliberately out of scope in this slice
Multi-document PDF segmentation into child uploads, email/WhatsApp capture channels,
pgvector similarity retrieval for corrections (recency heuristic in place), e-Factura/UBL,
PWA manifest, e-signature. Seams for each exist where the spec calls for them.
