# Production deployment, migration, and backup

## Prerequisites

- Docker Engine with Compose v2
- a host volume strategy appropriate for production
- TLS termination in front of port `8080`
- outbound access to the configured LLM provider and, when enabled, ANAF/AWS
- PostgreSQL `vector` extension support

Copy the example outside version control and replace every placeholder:

```bash
cp deploy/.env.production.example .env.production
chmod 600 .env.production
```

Keep `.env.production` in the deployment secret store, not in Git. Use a
minimum 32-byte random `JWT_SECRET`; rotate database and object-store
credentials according to the beneficiary's operational policy.

## First deployment

Validate configuration without starting services:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  config --quiet
```

Build and start:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  up --detach --build
```

Startup order is enforced:

1. PostgreSQL and MinIO become healthy.
2. The object bucket is created.
3. `prisma migrate deploy` applies versioned migrations.
4. The API becomes healthy.
5. nginx exposes the frontend and `/api`.
6. The backup service begins its schedule.

Check readiness:

```bash
curl --fail http://127.0.0.1:8080/healthz
curl --fail http://127.0.0.1:8080/api/health/ready
```

### Frontend and backend on separate services

The bundled Docker Compose deployment needs no `VITE_API_URL`: nginx proxies
same-origin `/api` requests to the backend container.

When the frontend is hosted separately (for example, as a static site), set
this build-time variable on the **frontend** service:

```dotenv
VITE_API_URL=https://autoimport-api.example.com
```

The `/api` suffix is optional. Vite embeds this value into the JavaScript
bundle, so trigger a clean frontend rebuild and redeploy after changing it.
For Docker builds, pass the same value as the `VITE_API_URL` build argument.

Without this setting or a platform proxy for `/api`, the static host may apply
its SPA fallback and return `index.html` with HTTP 200 to API requests. In the
browser this appears as a JSON parsing error, and the backend receives no
request or log.

Verify the public backend independently:

```bash
curl --fail https://autoimport-api.example.com/api/health/ready
```

Then use the browser Network panel to confirm requests such as
`/api/accounting/company` are sent to the backend host rather than the
frontend host.

For an existing database previously managed with `prisma db push`, complete
the one-time process in
[`backend/prisma/BASELINING.md`](../backend/prisma/BASELINING.md) before
starting the production stack.

## Upgrade

Take and verify a backup first, then deploy the new immutable images:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  run --rm -e BACKUP_INTERVAL_SECONDS=0 backup

docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  up --detach --build
```

Never run `prisma db push` in production. The `migrate` one-shot service must
complete successfully before the API is replaced.

## Backup policy

The backup service writes to the named `backups` volume:

- a PostgreSQL custom-format dump and SHA-256 checksum;
- a timestamped mirror of the document bucket;
- default schedule: every 24 hours;
- default retention: 30 days.

Set `BACKUP_INTERVAL_SECONDS` and `BACKUP_RETENTION_DAYS` in the deployment
environment. Copy backups to a separate encrypted/off-site location; a volume
on the same host is not disaster recovery.

List generated files:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  exec backup find /backups -maxdepth 3 -type f
```

At least monthly, restore the latest snapshot into an isolated staging
environment and verify:

- `/api/health/ready`;
- login and tenant isolation;
- one archived document download;
- the SAGA preview and ZIP generation.

## Guarded restore

Restoration overwrites database objects, so stop the application and point the
command at the exact snapshot. The restore script refuses to run without the
explicit confirmation value.

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  stop backend frontend backup

docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  run --rm \
  --entrypoint /usr/local/bin/restore.sh \
  -e CONFIRM_RESTORE=RESTORE_AUTOIMPORT \
  -e POSTGRES_BACKUP_FILE=/backups/postgres/autoimport_YYYYMMDDTHHMMSSZ.dump \
  -e MINIO_BACKUP_DIR=/backups/minio/autoimport-documents_YYYYMMDDTHHMMSSZ \
  backup
```

The object restore overwrites matching files but deliberately does not delete
newer objects absent from the snapshot. Start services again only after
checking the restore output and health endpoints.

## Operational notes

- TLS, firewall rules, external backup replication, and secret rotation belong
  to the beneficiary's infrastructure platform.
- ANAF production URLs and the qualified certificate flow must be configured
  separately; the example intentionally uses the ANAF test endpoint.
- Real extraction acceptance requires provider credentials and beneficiary
  document fixtures; it is not run with secrets in normal pull-request CI.
