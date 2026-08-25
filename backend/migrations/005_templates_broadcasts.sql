-- Templates, segments and broadcasts.
--
-- Message text has lived inline in `automations.message_template` and nowhere
-- else, so the same reminder wording was retyped for every automation and
-- could not be reused by the inbox or by a one-off send. A template is that
-- wording, named once and rendered anywhere.
--
-- A broadcast is a template plus an audience plus a schedule, and — unlike the
-- current "paste a comma-separated list of numbers" flow — it keeps a row per
-- recipient so "43 failures" is answerable without SQL.

CREATE TABLE templates (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    name        text NOT NULL,
    -- WhatsApp's own split. It does not gate anything here yet, but a clinic
    -- reminder and a promotion are different things and the report should say
    -- which it was sending.
    category    text NOT NULL DEFAULT 'utility',
    body        text NOT NULL,
    footer      text,
    -- Optional media header, scoped to the org by the same check the reminder
    -- path uses — one tenant's attachment must never go out over another's number.
    media_id    uuid REFERENCES media_attachments(id) ON DELETE SET NULL,
    -- [{ id, text }] — rendered as tappable buttons when present.
    buttons     jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    use_count   integer NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz,
    CONSTRAINT templates_category_chk CHECK (category IN ('utility', 'marketing', 'service')),
    CONSTRAINT templates_org_name_key UNIQUE (org_id, name)
);
CREATE INDEX idx_templates_org ON templates (org_id) WHERE deleted_at IS NULL;

-- A segment is a saved contact filter. Broadcasts and automations target one
-- instead of the pasted number lists they use today.
CREATE TABLE segments (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id     uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    name       text NOT NULL,
    -- { tag, search, invalid, has_replied } — evaluated live, never frozen, so
    -- a segment picks up contacts added after it was saved.
    filter     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT segments_org_name_key UNIQUE (org_id, name)
);

CREATE TABLE broadcasts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    name          text NOT NULL,
    template_id   uuid REFERENCES templates(id) ON DELETE SET NULL,
    -- The wording is copied in at send time. Editing a template later must not
    -- rewrite the history of what was actually sent.
    body          text NOT NULL,
    footer        text,
    media_id      uuid REFERENCES media_attachments(id) ON DELETE SET NULL,
    buttons       jsonb NOT NULL DEFAULT '[]'::jsonb,
    segment_id    uuid REFERENCES segments(id) ON DELETE SET NULL,
    audience      jsonb NOT NULL DEFAULT '{}'::jsonb,
    variables     jsonb NOT NULL DEFAULT '{}'::jsonb,

    status        text NOT NULL DEFAULT 'draft',
    scheduled_at  timestamptz,
    started_at    timestamptz,
    finished_at   timestamptz,

    total_count     integer NOT NULL DEFAULT 0,
    sent_count      integer NOT NULL DEFAULT 0,
    failed_count    integer NOT NULL DEFAULT 0,
    skipped_count   integer NOT NULL DEFAULT 0,

    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT broadcasts_status_chk
        CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed'))
);
CREATE INDEX idx_broadcasts_org ON broadcasts (org_id, created_at DESC);
-- The scheduler's pickup query.
CREATE INDEX idx_broadcasts_due ON broadcasts (status, scheduled_at) WHERE status = 'scheduled';

-- One row per recipient, resolved when the broadcast starts. This is what makes
-- a delivery report possible at all: today a failed automation send leaves only
-- a count.
CREATE TABLE broadcast_recipients (
    id              bigserial PRIMARY KEY,
    broadcast_id    uuid NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
    contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    status          text NOT NULL DEFAULT 'pending',
    -- Why this person was never messaged: opted_out, not_on_whatsapp, no_number.
    skip_reason     text,
    error_reason    text,
    wa_message_id   text,
    delivery_status text,
    body            text,
    sent_at         timestamptz,
    delivered_at    timestamptz,
    CONSTRAINT broadcast_recipients_status_chk
        CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
    CONSTRAINT broadcast_recipients_key UNIQUE (broadcast_id, contact_id)
);
CREATE INDEX idx_bcast_recipients ON broadcast_recipients (broadcast_id, status);
-- Delivery receipts arrive by wa_message_id, the same way automation acks do.
CREATE INDEX idx_bcast_waid ON broadcast_recipients (wa_message_id);
