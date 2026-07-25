# Prisma migration baseline

`20260725143000_baseline_contract_aligned` is the first versioned migration and
creates the complete contract-aligned schema for a new database.

The PostgreSQL `vector` extension must be available on the server and must be
created by a database superuser (or managed-database administrator) before the
application migration role runs:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

The `pgvector/pgvector:pg16` production service does this through the initial
PostgreSQL superuser. Managed PostgreSQL installations may require a one-time
administrator action.

For a new environment:

```bash
npm run prisma:migrate
```

For an existing AutoImport database that was previously managed with
`prisma db push`, first back it up, verify that `prisma/schema.prisma` matches
the deployed schema, and mark the baseline as already applied:

```bash
npx prisma migrate resolve --applied 20260725143000_baseline_contract_aligned
npm run prisma:migrate
```

Do not run the baseline SQL directly against an existing populated database;
it intentionally contains the full set of `CREATE TABLE` statements.

The baseline is exercised in CI against an empty `pgvector/pgvector:pg16`
database. It was also validated locally against a separate scratch database;
the migration created all 21 application tables and Prisma recorded it as
successfully applied.
