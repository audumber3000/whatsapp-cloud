# Operational scripts

## `backup.sh`

The database holds every clinic's contacts, message history, team and API keys.
There were no backups before this.

```bash
export DATABASE_URL=postgres://…
./backup.sh                    # take one
./backup.sh --list             # what exists, and a warning if the newest is stale
./backup.sh --verify FILE      # restore into a scratch DB and check it
```

**Run `--verify` after every schema change.** A backup nobody has restored is a
hypothesis. It restores into a throwaway database, prints the row counts, checks
the tables whose loss would end the business, and drops the scratch DB either way.

Notes worth knowing before 2am:

- `pg_dump` refuses to dump a **newer** server and only says so once invoked —
  on a schedule that is a silent gap. The script checks up front and, if the
  local client is behind, uses the Postgres container's own binaries. Set
  `WAREACH_PG_CONTAINER` to that container's name.
- The dump is streamed to stdout rather than written with `--file`, because in
  the container fallback `--file` would write *inside* the container.
- A failed dump removes its own partial file, so a 0-byte leftover never sits in
  the directory looking like a backup.
- Custom format, so `pg_restore` can pull out a single table — which is what you
  actually want when one table was truncated by mistake.

Environment: `WAREACH_BACKUP_DIR` (default `~/Documents/Personal Projects/wareach-backups`),
`WAREACH_BACKUP_KEEP_DAYS` (default 14), `WAREACH_PG_CONTAINER`.

Suggested cron on the host — hourly is cheap at this data size:

```
0 * * * * cd /srv/wareach/backend && DATABASE_URL=… ./scripts/backup.sh >> /var/log/wareach-backup.log 2>&1
```

## Running the API without the worker

`SCHEDULER_DISABLED=1` starts the web process without the cron loop. Use it to
scale the API without duplicating every send, and locally when the database
holds real queued messages that must not be dispatched.
