#!/bin/sh
# Create WA Reach's own database and role alongside Evolution's.
#
# One Postgres instance serves both on this box: Evolution owns `evolution`,
# WA Reach owns `wareach`. Separate roles so neither can read the other's
# tables. pgcrypto is trusted in PG13+, so migration 001 can create it as the
# database owner without superuser rights.
#
# NOTE: the postgres image runs this ONLY when the data directory is empty —
# i.e. on a brand-new volume. If you are adding WA Reach to a box that already
# has an Evolution database, run the two statements below by hand instead:
#   docker compose -f docker-compose.prod.yml exec postgres \
#     psql -U evolution -d evolution -c "CREATE USER wareach WITH PASSWORD '...';" \
#     -c "CREATE DATABASE wareach OWNER wareach;"
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE USER wareach WITH PASSWORD '${WAREACH_DB_PASSWORD}';
    CREATE DATABASE wareach OWNER wareach;
EOSQL

echo "[init] created database 'wareach' owned by role 'wareach'"
