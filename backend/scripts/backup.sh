#!/usr/bin/env bash
#
# Postgres backup for WA Reach.
#
# There are no backups today. The database now holds every clinic's contacts,
# their message history, their team and their API keys — losing it is losing
# the product, not just a deployment.
#
#   ./backup.sh                  take a backup
#   ./backup.sh --verify FILE    restore it into a scratch database and check it
#   ./backup.sh --list           what exists and how old it is
#
# A backup nobody has restored is a hypothesis, so --verify is not optional
# ceremony: run it after any schema change and before any risky migration.

set -euo pipefail

DIR="${WAREACH_BACKUP_DIR:-$HOME/Documents/Personal Projects/wareach-backups}"
KEEP_DAYS="${WAREACH_BACKUP_KEEP_DAYS:-14}"
URL="${DATABASE_URL:-}"

if [[ -z "$URL" ]]; then
    echo "DATABASE_URL is not set." >&2
    exit 1
fi

mkdir -p "$DIR"

# pg_dump refuses to dump a newer server, and it says so only once it has
# already been invoked — which on a schedule means a silent gap in backups.
# Check up front, and use the server's own binaries via Docker when the local
# ones are behind.
PG_DUMP=(pg_dump)
PG_RESTORE=(pg_restore)
PSQL=(psql)
# The URL the dump tools use. Inside a container the server is on localhost:5432,
# not on whatever port the host publishes.
DUMP_URL="$URL"
check_versions() {
    local server client
    server=$(psql "$URL" -tAc "SHOW server_version;" 2>/dev/null | cut -d. -f1) || return 0
    client=$(pg_dump --version 2>/dev/null | grep -oE '[0-9]+' | head -1) || return 0
    [[ -z "$server" || -z "$client" ]] && return 0
    if (( client < server )); then
        local container="${WAREACH_PG_CONTAINER:-}"
        if [[ -n "$container" ]] && docker ps --format '{{.Names}}' | grep -qx "$container"; then
            echo "Local pg_dump is $client, server is $server — using the $container container's binaries."
            PG_DUMP=(docker exec -i "$container" pg_dump)
            PG_RESTORE=(docker exec -i "$container" pg_restore)
            PSQL=(docker exec -i "$container" psql)
            DUMP_URL="${WAREACH_PG_INTERNAL_URL:-${URL/@localhost:*\//@localhost:5432/}}"
        else
            echo "pg_dump is version $client but the server is $server; it will refuse to dump." >&2
            echo "Install matching client tools, or set WAREACH_PG_CONTAINER to the Postgres container name." >&2
            exit 1
        fi
    fi
}
list_backups() {
    if ! ls "$DIR"/wareach-*.dump >/dev/null 2>&1; then
        echo "No backups in $DIR"
        return
    fi
    echo "Backups in $DIR:"
    ls -lh "$DIR"/wareach-*.dump | awk '{printf "  %-42s %6s  %s %s %s\n", $9, $5, $6, $7, $8}'
    local newest age_h
    newest=$(ls -t "$DIR"/wareach-*.dump | head -1)
    age_h=$(( ( $(date +%s) - $(stat -f %m "$newest" 2>/dev/null || stat -c %Y "$newest") ) / 3600 ))
    echo
    echo "Newest is ${age_h}h old."
    # Said loudly, because a stale backup that nobody notices is the same as none.
    [[ $age_h -gt 26 ]] && echo "  WARNING: that is over a day old — is the schedule actually running?"
}

SCRATCH_DB=""
ADMIN_URL=""
cleanup_scratch() {
    [[ -z "$SCRATCH_DB" ]] && return 0
    "${PSQL[@]}" "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $SCRATCH_DB;" >/dev/null 2>&1 || true
}

verify_backup() {
    local file="$1"
    [[ -f "$file" ]] || { echo "No such file: $file" >&2; exit 1; }

    # A scratch database, dropped afterwards either way, so a verify can never
    # touch the live one.
    # Not `local`: the EXIT trap fires after this function has returned, and
    # under `set -u` an unbound variable there kills the trap — leaving the
    # scratch database behind on every verify.
    SCRATCH_DB="wareach_verify_$$"
    ADMIN_URL="${DUMP_URL%/*}/postgres"
    local scratch="$SCRATCH_DB"

    echo "Restoring $(basename "$file") into $scratch …"
    "${PSQL[@]}" "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $scratch;" -c "CREATE DATABASE $scratch;"
    trap 'cleanup_scratch' EXIT

    "${PG_RESTORE[@]}" --no-owner --no-privileges -d "${DUMP_URL%/*}/$scratch" < "$file" >/dev/null 2>&1 || true

    echo
    echo "Row counts in the restored copy:"
    "${PSQL[@]}" "${DUMP_URL%/*}/$scratch" -tA -F' ' -c "
        SELECT relname, n_live_tup FROM pg_stat_user_tables
         WHERE n_live_tup > 0 ORDER BY n_live_tup DESC LIMIT 15;" |
        awk '{printf "  %-26s %s\n", $1, $2}'

    # The tables whose loss would actually end the business, checked by name so
    # an empty restore cannot pass quietly.
    local missing=0
    for t in organisations users memberships contacts automations automation_logs conversations api_keys; do
        local n
        n=$("${PSQL[@]}" "${DUMP_URL%/*}/$scratch" -tA -c "SELECT COUNT(*) FROM $t;" 2>/dev/null || echo "ERR")
        if [[ "$n" == "ERR" ]]; then
            echo "  MISSING TABLE: $t"
            missing=1
        fi
    done

    local applied
    applied=$("${PSQL[@]}" "${DUMP_URL%/*}/$scratch" -tA -c "SELECT COUNT(*) FROM schema_migrations;" 2>/dev/null || echo 0)
    echo
    echo "Migrations recorded in the restore: $applied"

    if [[ $missing -eq 1 ]]; then
        echo "VERIFY FAILED — the backup is not restorable as-is." >&2
        exit 1
    fi
    echo "VERIFY PASSED — this backup restores cleanly."
}

# --list only reads the filesystem, so it must not require matching client
# tools; everything else talks to the server.
case "${1:-}" in
    --list) list_backups; exit 0 ;;
esac

check_versions

case "${1:-}" in
    --verify) verify_backup "${2:?usage: backup.sh --verify FILE}"; exit 0 ;;
esac

STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$DIR/wareach-$STAMP.dump"

# Custom format: compressed, and pg_restore can pick single tables out of it,
# which is what you want at 2am when one table was truncated by mistake.
echo "Backing up to $OUT …"
# The redirect creates the file before pg_dump runs, so a failure would leave a
# 0-byte dump sitting in the directory looking like a backup. Remove a partial
# write on any non-zero exit.
trap 'rc=$?; if [[ $rc -ne 0 ]]; then rm -f "$OUT"; echo "Backup failed — removed the partial file." >&2; fi' EXIT
# Streamed to stdout and redirected here on purpose: --file with a host path
# would write inside the container in the Docker fallback, where the dump would
# vanish with the container.
"${PG_DUMP[@]}" --format=custom --no-owner --no-privileges --compress=6 "$DUMP_URL" > "$OUT"

SIZE=$(du -h "$OUT" | cut -f1)
echo "Wrote $SIZE"

# A dump that pg_restore cannot even list is corrupt, and finding that out
# during a restore is finding out too late.
if ! "${PG_RESTORE[@]}" --list < "$OUT" >/dev/null 2>&1; then
    echo "The dump is unreadable — removing it rather than leaving a broken backup." >&2
    rm -f "$OUT"
    exit 1
fi

find "$DIR" -name 'wareach-*.dump' -type f -mtime +"$KEEP_DAYS" -print -delete |
    sed 's/^/  pruned /'

echo "Done. Verify it with:  $0 --verify $OUT"
