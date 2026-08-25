-- Workspace settings.
--
-- The only configuration a clinic can change today is a notification email and
-- a WhatsApp number, both on one inline tab. Everything else — the workspace's
-- own name, its hours, what it says when nobody is there, who else can log in —
-- has no home in the product at all.

ALTER TABLE organisations
    ADD COLUMN logo_url      text,
    -- Sent once per conversation when a patient writes outside business hours,
    -- so silence at 11pm is not mistaken for being ignored.
    ADD COLUMN away_message  text,
    ADD COLUMN away_enabled  boolean NOT NULL DEFAULT FALSE,
    -- Per-event, per-channel: { "daily_summary": {"email": true, "whatsapp": false}, … }
    -- The old flat notify_emails/notify_whatsapp columns stay as the delivery
    -- addresses; this is which events reach them.
    ADD COLUMN notify_events jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Away replies are once per conversation per day, not once per message —
-- otherwise a patient sending three lines gets three identical auto-replies.
ALTER TABLE conversations
    ADD COLUMN away_sent_at timestamptz;

-- The audit log needs to be readable in reverse chronological order per org,
-- which is the only way it is ever queried.
CREATE INDEX IF NOT EXISTS idx_audit_org_time ON audit_log (org_id, created_at DESC);

-- Invitations are looked up by their hashed token on acceptance.
CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations (token_hash)
    WHERE accepted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_invitations_org ON invitations (org_id, created_at DESC);

-- A key can be named and revoked individually; the dashboard only ever
-- exposed one at a time even though the table always allowed several.
CREATE INDEX IF NOT EXISTS idx_apikeys_org ON api_keys (org_id, created_at DESC);
