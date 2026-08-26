-- Outbound webhooks.
--
-- WA Reach has been a write-only pipe. Another product can send through a
-- clinic's number, but can never learn what happened afterwards: MolarPlus
-- books an appointment, WA Reach sends the reminder, the patient taps Cancel —
-- and MolarPlus still shows them as coming. The confirmation buttons are
-- decorative for anyone integrating.
--
-- `MOLARPLUS_URL` and `WAREACH_WEBHOOK_SECRET` have been sitting in .env since
-- before the Evolution migration, referenced by no code at all. This is the
-- feature they were named for.

CREATE TABLE webhook_endpoints (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    name          text NOT NULL,
    url           text NOT NULL,
    -- Shown once on creation, like an API key. The receiver uses it to verify
    -- the HMAC signature, so it must be a secret they hold, not one we display
    -- on a settings page forever.
    secret        text NOT NULL,
    -- Which events this endpoint wants. Empty means all of them.
    events        jsonb NOT NULL DEFAULT '[]'::jsonb,
    active        boolean NOT NULL DEFAULT TRUE,

    -- Health, so a dead endpoint is visible rather than silently retrying.
    last_success_at   timestamptz,
    last_failure_at   timestamptz,
    last_error        text,
    consecutive_fails integer NOT NULL DEFAULT 0,

    created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_webhook_endpoints_org ON webhook_endpoints (org_id) WHERE active;

-- One row per (event, endpoint). Kept rather than fired-and-forgotten, because
-- "did the reminder confirmation reach our system?" is exactly the question an
-- integrator asks, and a log is the only honest answer.
CREATE TABLE webhook_deliveries (
    id              bigserial PRIMARY KEY,
    endpoint_id     uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
    org_id          uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    event           text NOT NULL,
    payload         jsonb NOT NULL,

    status          text NOT NULL DEFAULT 'pending',
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    response_status integer,
    error           text,

    created_at      timestamptz NOT NULL DEFAULT now(),
    delivered_at    timestamptz,
    CONSTRAINT webhook_deliveries_status_chk CHECK (status IN ('pending', 'delivered', 'failed'))
);
-- The worker's pickup query.
CREATE INDEX idx_webhook_due ON webhook_deliveries (next_attempt_at)
    WHERE status = 'pending';
CREATE INDEX idx_webhook_deliveries_org ON webhook_deliveries (org_id, created_at DESC);
