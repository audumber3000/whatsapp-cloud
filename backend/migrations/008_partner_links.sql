-- Partner workspaces.
--
-- MolarPlus lets a clinic connect its own WhatsApp number from inside
-- MolarPlus. The clinic never signs up here and never logs in here: MolarPlus
-- creates the workspace, shows the QR in its own UI, and sends through the
-- workspace's API key. The old way to do that was the unauthenticated
-- /api/sessions stack removed in 5d2edda. This is its authenticated
-- replacement, and this table is how a partner's own id for a customer maps to
-- one of our organisations.

CREATE TABLE partner_links (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Which partner owns the workspace, e.g. 'molarplus'. Matches config.js.
    partner     text NOT NULL,
    -- The partner's id for its customer (a MolarPlus clinic id), as text.
    external_id text NOT NULL,
    org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    -- The key the partner currently holds. Re-provisioning revokes it and
    -- issues a new one, so there is never more than one live partner key.
    api_key_id  uuid REFERENCES api_keys(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (partner, external_id),
    UNIQUE (org_id)
);

-- Delivery receipts for API sends are matched on the WhatsApp message id.
-- Nothing updated api_sends before, so nothing needed this index.
CREATE INDEX IF NOT EXISTS idx_apisends_wamsg ON api_sends (wa_message_id);
