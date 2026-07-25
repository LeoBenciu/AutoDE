#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${CONFIRM_RESTORE:-}" != "RESTORE_AUTOIMPORT" ]]; then
  echo "Restore changes live data. Set CONFIRM_RESTORE=RESTORE_AUTOIMPORT to continue." >&2
  exit 2
fi

: "${POSTGRES_HOST:?POSTGRES_HOST is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
: "${S3_ACCESS_KEY:?S3_ACCESS_KEY is required}"
: "${S3_SECRET_KEY:?S3_SECRET_KEY is required}"
: "${POSTGRES_BACKUP_FILE:?POSTGRES_BACKUP_FILE is required}"
: "${MINIO_BACKUP_DIR:?MINIO_BACKUP_DIR is required}"

[[ -f "$POSTGRES_BACKUP_FILE" ]] || { echo "Missing database backup: $POSTGRES_BACKUP_FILE" >&2; exit 2; }
[[ -d "$MINIO_BACKUP_DIR" ]] || { echo "Missing object backup: $MINIO_BACKUP_DIR" >&2; exit 2; }

if [[ -f "${POSTGRES_BACKUP_FILE}.sha256" ]]; then
  sha256sum --check "${POSTGRES_BACKUP_FILE}.sha256"
fi

export PGPASSWORD="$POSTGRES_PASSWORD"
pg_restore \
  --host "$POSTGRES_HOST" \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --clean \
  --if-exists \
  --no-owner \
  "$POSTGRES_BACKUP_FILE"

mc alias set destination "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null
mc mb --ignore-existing "destination/$S3_BUCKET"
mc mirror --overwrite "$MINIO_BACKUP_DIR" "destination/$S3_BUCKET"
echo "Restore completed. Existing object-store files not present in the snapshot were preserved."
