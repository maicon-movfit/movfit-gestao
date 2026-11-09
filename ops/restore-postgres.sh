#!/bin/sh
set -eu
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "Uso: $0 backups/arquivo.dump.gz" >&2
  exit 1
fi
echo "ATENÇÃO: restaure somente em manutenção e após validar o arquivo."
gzip -dc "$1" | docker compose exec -T db pg_restore --username "${POSTGRES_USER:-movfit}" --dbname "${POSTGRES_DB:-movfit_gestao}" --clean --if-exists --no-owner
