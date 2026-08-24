-- WA Reach — initial Postgres schema (multi-tenant CRM)
--
-- Shape borrowed from Evolution API's own model, which solves the same domain:
--   * a tenant column on every owned table, FK with ON DELETE CASCADE
--   * unique constraints scoped to the tenant, never global
--   * jsonb where the shape is genuinely open (custom fields, templates)
--   * created_at / updated_at everywhere
--   * NON-SEQUENTIAL ids. The clinic_id enumeration hole we just closed existed
--     precisely because ids were small sequential integers.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Tenancy ──────────────────────────────────────────────────────────────────

CREATE TABLE organisations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    slug            TEXT UNIQUE NOT NULL,
    timezone        TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    locale          TEXT NOT NULL DEFAULT 'en',
    business_hours  JSONB,
    plan            TEXT NOT NULL DEFAULT 'free',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- users are identity only; everything owned belongs to an organisation
CREATE TABLE users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username            TEXT UNIQUE NOT NULL,
    email               TEXT UNIQUE,
    password_hash       TEXT NOT NULL,
    full_name           TEXT,
    avatar_url          TEXT,
    timezone            TEXT,
    locale              TEXT NOT NULL DEFAULT 'en',
    is_platform_admin   BOOLEAN NOT NULL DEFAULT FALSE,
    email_verified_at   TIMESTAMPTZ,
    last_login_at       TIMESTAMPTZ,
    last_login_ip       TEXT,
    failed_attempts     INT NOT NULL DEFAULT 0,
    locked_until        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ
);

CREATE TYPE member_role AS ENUM ('owner', 'manager', 'agent');

CREATE TABLE memberships (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        member_role NOT NULL DEFAULT 'agent',
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (org_id, user_id)
);
CREATE INDEX idx_memberships_user ON memberships(user_id);

CREATE TABLE invitations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    role        member_role NOT NULL DEFAULT 'agent',
    token_hash  TEXT NOT NULL,          -- never store the raw token
    invited_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_invitations_org ON invitations(org_id);

-- refresh tokens; makes logout and "sign out other devices" possible at all
CREATE TABLE sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash  TEXT UNIQUE NOT NULL,
    user_agent          TEXT,
    ip                  TEXT,
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL,
    revoked_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE audit_log (
    id            BIGSERIAL PRIMARY KEY,
    org_id        UUID REFERENCES organisations(id) ON DELETE CASCADE,
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action        TEXT NOT NULL,
    entity_type   TEXT,
    entity_id     TEXT,
    before        JSONB,
    after         JSONB,
    ip            TEXT,
    user_agent    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_org_time ON audit_log(org_id, created_at DESC);

-- ── WhatsApp connection ──────────────────────────────────────────────────────

CREATE TABLE wa_instances (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    instance_name  TEXT UNIQUE NOT NULL,   -- the name held in Evolution
    phone_number   TEXT,
    status         TEXT NOT NULL DEFAULT 'disconnected',
    last_status_at TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (org_id)                        -- one number per org, for now
);

-- ── Contacts ─────────────────────────────────────────────────────────────────

CREATE TABLE contacts (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    name           TEXT,
    phone          TEXT NOT NULL,
    email          TEXT,
    custom         JSONB NOT NULL DEFAULT '{}'::jsonb,
    opted_out      BOOLEAN NOT NULL DEFAULT FALSE,
    opted_out_at   TIMESTAMPTZ,
    wa_valid       BOOLEAN,
    wa_checked_at  TIMESTAMPTZ,
    last_contacted_at TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at     TIMESTAMPTZ,
    UNIQUE (org_id, phone)
);
CREATE INDEX idx_contacts_org ON contacts(org_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_contacts_phone ON contacts(org_id, phone);

CREATE TABLE tags (
    id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id  UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    name    TEXT NOT NULL,
    colour  TEXT NOT NULL DEFAULT '#00A884',
    UNIQUE (org_id, name)
);

CREATE TABLE contact_tags (
    contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    tag_id     UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (contact_id, tag_id)
);

CREATE TABLE contact_notes (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    contact_id     UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    body           TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_notes_contact ON contact_notes(contact_id, created_at DESC);

-- custom field definitions, per org; values live in contacts.custom
CREATE TABLE custom_fields (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id    UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    key       TEXT NOT NULL,
    label     TEXT NOT NULL,
    type      TEXT NOT NULL DEFAULT 'text',
    options   JSONB,
    position  INT NOT NULL DEFAULT 0,
    UNIQUE (org_id, key)
);

-- ── Media ────────────────────────────────────────────────────────────────────

CREATE TABLE media_attachments (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    contact_id     UUID REFERENCES contacts(id) ON DELETE SET NULL,
    uploaded_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    original_name  TEXT,
    stored_name    TEXT NOT NULL,
    mimetype       TEXT,
    size           BIGINT,
    direction      TEXT NOT NULL DEFAULT 'outbound',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_media_org ON media_attachments(org_id);

-- ── Automations ──────────────────────────────────────────────────────────────

CREATE TABLE automations (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                   UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    created_by               UUID REFERENCES users(id) ON DELETE SET NULL,
    name                     TEXT NOT NULL,
    start_time               TEXT NOT NULL,
    end_time                 TEXT NOT NULL,
    message_template         JSONB NOT NULL,
    status                   TEXT NOT NULL DEFAULT 'Active',
    active_days              JSONB NOT NULL DEFAULT '[1,2,3,4,5]'::jsonb,
    timezone_offset          INT NOT NULL DEFAULT 0,
    ask_confirmation         BOOLEAN NOT NULL DEFAULT FALSE,
    last_summary_sent_date   TEXT,
    last_start_notified_date TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at               TIMESTAMPTZ
);
CREATE INDEX idx_automations_org ON automations(org_id) WHERE deleted_at IS NULL;

CREATE TABLE automation_logs (
    id              BIGSERIAL PRIMARY KEY,
    org_id          UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    automation_id   UUID REFERENCES automations(id) ON DELETE CASCADE,
    contact_id      UUID REFERENCES contacts(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'pending',
    error_reason    TEXT,
    content         TEXT,
    sent_time       TIMESTAMPTZ,        -- the time it is scheduled FOR
    wa_message_id   TEXT,
    delivery_status TEXT,
    delivered_at    TIMESTAMPTZ,
    response        TEXT,
    responded_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_autolog_due ON automation_logs(status, sent_time);
CREATE INDEX idx_autolog_org ON automation_logs(org_id, sent_time DESC);
CREATE INDEX idx_autolog_waid ON automation_logs(wa_message_id);

CREATE TABLE reminders (
    id             BIGSERIAL PRIMARY KEY,
    org_id         UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    contact_id     UUID REFERENCES contacts(id) ON DELETE CASCADE,
    media_id       UUID REFERENCES media_attachments(id) ON DELETE SET NULL,
    message        TEXT NOT NULL,
    scheduled_time TIMESTAMPTZ NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_reminders_due ON reminders(status, scheduled_time);

-- ── Inbound ──────────────────────────────────────────────────────────────────

CREATE TABLE inbound_messages (
    id             BIGSERIAL PRIMARY KEY,
    org_id         UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    contact_id     UUID REFERENCES contacts(id) ON DELETE CASCADE,
    from_number    TEXT NOT NULL,
    wa_message_id  TEXT UNIQUE,
    body           TEXT,
    media_type     TEXT,
    media_path     TEXT,
    intent         TEXT,
    is_read        BOOLEAN NOT NULL DEFAULT FALSE,
    received_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_inbound_org_time ON inbound_messages(org_id, received_at DESC);
CREATE INDEX idx_inbound_contact ON inbound_messages(contact_id);

-- ── Programmable API ─────────────────────────────────────────────────────────
-- Multiple named keys per org, HASHED. The old single plaintext users.api_key
-- meant a database read disclosed live send credentials for every tenant.

CREATE TABLE api_keys (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    name         TEXT NOT NULL DEFAULT 'Default',
    key_hash     TEXT UNIQUE NOT NULL,
    key_prefix   TEXT NOT NULL,          -- shown in the UI so a key is identifiable
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_apikeys_org ON api_keys(org_id);

CREATE TABLE api_sends (
    id            BIGSERIAL PRIMARY KEY,
    org_id        UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    api_key_id    UUID REFERENCES api_keys(id) ON DELETE SET NULL,
    to_number     TEXT NOT NULL,
    body          TEXT,
    has_media     BOOLEAN NOT NULL DEFAULT FALSE,
    wa_message_id TEXT,
    status        TEXT NOT NULL DEFAULT 'sent',
    error_reason  TEXT,
    reference     TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_apisends_org ON api_sends(org_id, created_at DESC);
CREATE INDEX idx_apisends_waid ON api_sends(wa_message_id);

-- ── Operational ──────────────────────────────────────────────────────────────

CREATE TABLE notification_logs (
    id        BIGSERIAL PRIMARY KEY,
    org_id    UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    type      TEXT NOT NULL,
    category  TEXT NOT NULL,
    recipient TEXT NOT NULL,
    content   TEXT,
    status    TEXT NOT NULL,
    sent_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_notiflogs_org ON notification_logs(org_id, sent_at DESC);

CREATE TABLE health_alerts (
    id         BIGSERIAL PRIMARY KEY,
    org_id     UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    detail     TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_health_org_time ON health_alerts(org_id, created_at DESC);

-- keep updated_at honest without remembering to set it everywhere
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['organisations','users','contacts','automations','api_sends']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_touch BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t, t);
  END LOOP;
END $$;
