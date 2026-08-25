-- Team inbox.
--
-- Until now a "conversation" existed only as a GROUP BY over inbound_messages:
-- there was nothing to assign, nothing to resolve, and no place to record that
-- an agent had already picked something up. Two people sharing a number could
-- only coordinate by talking to each other.
--
-- A conversation is one row per (org, contact). It carries the operational
-- state — who owns it, what state it is in, when the customer last wrote — and
-- the messages themselves stay where they already live: inbound_messages for
-- what the patient sent, automation_logs for what we sent.

CREATE TABLE conversations (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    contact_id        uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

    -- open: needs attention. pending: waiting on the patient. resolved: done.
    status            text NOT NULL DEFAULT 'open',
    assignee_id       uuid REFERENCES users(id) ON DELETE SET NULL,
    assigned_at       timestamptz,

    last_message_at   timestamptz,
    -- The 24-hour service window is measured from the patient's last message.
    -- Outside it WhatsApp permits only template messages, so the composer has
    -- to say so rather than letting an agent type into a void.
    last_inbound_at   timestamptz,
    last_outbound_at  timestamptz,
    -- Cleared whenever a new inbound arrives, so the SLA timer is per-round,
    -- not per-conversation-lifetime.
    first_response_at timestamptz,
    unread_count      integer NOT NULL DEFAULT 0,

    resolved_at       timestamptz,
    resolved_by       uuid REFERENCES users(id) ON DELETE SET NULL,

    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT conversations_status_chk CHECK (status IN ('open', 'pending', 'resolved')),
    CONSTRAINT conversations_org_contact_key UNIQUE (org_id, contact_id)
);

-- The inbox list is always "this org, newest activity first", optionally
-- narrowed by status or assignee.
CREATE INDEX idx_conversations_org_recent ON conversations (org_id, last_message_at DESC);
CREATE INDEX idx_conversations_assignee   ON conversations (org_id, assignee_id) WHERE status <> 'resolved';
CREATE INDEX idx_conversations_status     ON conversations (org_id, status);

-- Labels are conversation-level and org-defined, separate from contact tags:
-- "needs X-ray" describes this exchange, "Implant patient" describes the person.
CREATE TABLE labels (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id     uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    name       text NOT NULL,
    colour     text NOT NULL DEFAULT '#00A884',
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT labels_org_name_key UNIQUE (org_id, name)
);

CREATE TABLE conversation_labels (
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    label_id        uuid NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (conversation_id, label_id)
);

-- Internal notes never leave the building. They render in the thread beside
-- the messages but are visibly not messages.
CREATE TABLE conversation_notes (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    author_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    body            text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_conv_notes ON conversation_notes (conversation_id, created_at);

-- Assignment and status changes are shown inline in the thread, the way
-- WhatsApp shows its own system lines, so the history explains itself.
CREATE TABLE conversation_events (
    id              bigserial PRIMARY KEY,
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
    kind            text NOT NULL,      -- assigned | unassigned | status | label
    detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_conv_events ON conversation_events (conversation_id, created_at);

-- Canned replies. `shortcut` is what an agent types after "/" in the composer.
CREATE TABLE canned_replies (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id     uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    shortcut   text NOT NULL,
    title      text NOT NULL,
    body       text NOT NULL,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    use_count  integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT canned_replies_org_shortcut_key UNIQUE (org_id, shortcut)
);

-- Who sent it. Automation sends leave this null; an agent reply from the inbox
-- sets it, so the thread can say "Priya replied" rather than just "sent".
ALTER TABLE automation_logs ADD COLUMN sent_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- Backfill: every contact that has ever written in, or been written to, already
-- has a conversation in practice. Create the rows so nothing appears only after
-- the next message arrives.
INSERT INTO conversations (org_id, contact_id, last_inbound_at, last_outbound_at, last_message_at, unread_count)
SELECT c.org_id,
       c.id,
       i.last_in,
       o.last_out,
       GREATEST(COALESCE(i.last_in, 'epoch'::timestamptz), COALESCE(o.last_out, 'epoch'::timestamptz)),
       COALESCE(i.unread, 0)
  FROM contacts c
  LEFT JOIN (
        SELECT contact_id, MAX(received_at) AS last_in,
               COUNT(*) FILTER (WHERE NOT is_read) AS unread
          FROM inbound_messages WHERE contact_id IS NOT NULL GROUP BY contact_id
  ) i ON i.contact_id = c.id
  LEFT JOIN (
        SELECT contact_id, MAX(sent_time) AS last_out
          FROM automation_logs WHERE contact_id IS NOT NULL AND sent_time IS NOT NULL
         GROUP BY contact_id
  ) o ON o.contact_id = c.id
 WHERE c.deleted_at IS NULL
   AND (i.last_in IS NOT NULL OR o.last_out IS NOT NULL)
ON CONFLICT (org_id, contact_id) DO NOTHING;

-- A backfilled conversation with no unread replies is not waiting on anyone.
UPDATE conversations SET status = 'resolved', resolved_at = last_message_at
 WHERE unread_count = 0 AND last_inbound_at IS NULL;
