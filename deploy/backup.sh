#!/usr/bin/env bash
set -Eeuo pipefail

: "${POSTGRES_HOST:?POSTGRES_HOST is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
: "${S3_ACCESS_KEY:?S3_ACCESS_KEY is required}"
: "${S3_SECRET_KEY:?S3_SECRET_KEY is required}"

BACKUP_ROOT="${BACKUP_ROOT:-/backups}"
BACKUP_INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

case "$BACKUP_ROOT" in
  ""|"/"|"/backups/.."|"/backups/../"*) echo "Unsafe BACKUP_ROOT: $BACKUP_ROOT" >&2; exit 2 ;;
esac

mkdir -p "$BACKUP_ROOT/postgres" "$BACKUP_ROOT/minio"
export PGPASSWORD="$POSTGRES_PASSWORD"

run_backup() {
  local stamp pg_tmp pg_final object_dir
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  pg_tmp="$BACKUP_ROOT/postgres/${POSTGRES_DB}_${stamp}.dump.partial"
  pg_final="${pg_tmp%.partial}"
  object_dir="$BACKUP_ROOT/minio/${S3_BUCKET}_${stamp}"

  pg_dump \
    --host "$POSTGRES_HOST" \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    --format custom \
    --file "$pg_tmp"
  mv "$pg_tmp" "$pg_final"

  mc alias set source "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null
  mkdir -p "$object_dir"
  mc mirror --overwrite "source/$S3_BUCKET" "$object_dir"

  sha256sum "$pg_final" >"${pg_final}.sha256"
  find "$BACKUP_ROOT/postgres" -type f -mtime "+$BACKUP_RETENTION_DAYS" -delete
  find "$BACKUP_ROOT/minio" -mindepth 1 -maxdepth 1 -type d \
    -mtime "+$BACKUP_RETENTION_DAYS" -exec rm -rf -- {} +

  echo "Backup completed: $stamp"
}

if [[ "$BACKUP_INTERVAL_SECONDS" == "0" ]]; then
  run_backup
  exit 0
fi

while true; do
  run_backup
  sleep "$BACKUP_INTERVAL_SECONDS"
done
