#!/bin/sh
set -eu
backup_dir="${BACKUP_DIR:-./backups}"
retention_days="${BACKUP_RETENTION_DAYS:-14}"
timestamp="$(date +%Y%m%d_%H%M%S)"
mkdir -p "$backup_dir"
docker compose exec -T db pg_dump --username "${POSTGRES_USER:-movfit}" --dbname "${POSTGRES_DB:-movfit_gestao}" --format=custom | gzip > "$backup_dir/movfit_${timestamp}.dump.gz"
find "$backup_dir" -type f -name 'movfit_*.dump.gz' -mtime "+$retention_days" -delete
echo "Backup criado: $backup_dir/movfit_${timestamp}.dump.gz"
