#!/usr/bin/env bash
# Write one secret into .env.prod without it ever appearing in a shell history,
# a process list, or a terminal transcript.
#
#   ssh ubuntu@<box> 'sudo /opt/wareach/ops/set-secret.sh EMAIL_PASS' <<< 'the-password'
#
# or interactively, from your own machine:
#
#   read -rsp 'password: ' P; echo
#   printf '%s' "$P" | ssh ubuntu@<box> 'sudo /opt/wareach/ops/set-secret.sh EMAIL_PASS'
#   unset P
#
# The value is read from stdin, never from argv, so `ps` cannot see it.
set -euo pipefail

KEY="${1:-}"
ENV_FILE="${ENV_FILE:-/opt/wareach/.env.prod}"

[ -n "$KEY" ] || { echo "usage: $0 <KEY>   (value on stdin)" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 2; }
[ -f "$ENV_FILE" ] || { echo "no such file: $ENV_FILE" >&2; exit 2; }

VALUE="$(cat)"
[ -n "$VALUE" ] || { echo "refusing to write an empty value for $KEY" >&2; exit 3; }

# Compose interpolates the file it is handed with --env-file, so a literal `$`
# in a secret is read as a variable reference and expands to nothing. A Zoho
# app password containing `$` would otherwise arrive at the SMTP server
# truncated, and the only symptom is authentication failing forever. This is
# the same trap that silently mangled the bcrypt admin hash.
# Done with sed, not bash substitution, and both were wrong first:
#   ${VALUE//$/$$}          -> bash expands $$ to its own PID
#   ${VALUE//"$D"/"$D$D"}   -> the quote characters land in the output
# In a sed replacement `$` is an ordinary character, and the value arrives on
# stdin so it never appears in argv.
ESCAPED="$(printf '%s' "$VALUE" | sed 's/\$/$$/g')"

# Written with awk rather than sed: a secret may contain any of sed's
# replacement metacharacters, and awk lets us pass the value as data.
TMP="$(mktemp)"
chmod 600 "$TMP"
if grep -q "^${KEY}=" "$ENV_FILE"; then
    awk -v k="$KEY" -v v="$ESCAPED" \
        'index($0, k "=") == 1 { print k "=" v; next } { print }' "$ENV_FILE" > "$TMP"
else
    cp "$ENV_FILE" "$TMP"
    printf '%s=%s\n' "$KEY" "$ESCAPED" >> "$TMP"
fi

# Write THROUGH the existing file rather than replacing it, so owner and mode
# are preserved by construction — no chown/chmod juggling, and portable to any
# coreutils. The file is only ever truncated after $TMP is known-complete.
cat "$TMP" > "$ENV_FILE"
rm -f "$TMP"

# Report only the shape, never the value.
printf '%s set (%d characters%s)\n' "$KEY" "${#VALUE}" \
    "$([ "$ESCAPED" != "$VALUE" ] && printf ', dollars escaped for compose')"
