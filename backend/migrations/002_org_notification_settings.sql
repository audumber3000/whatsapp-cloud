-- Who gets told when this workspace's automations start, finish or fail.
--
-- These lived on users as comma-joined multi-value strings (users.email,
-- users.personal_whatsapp_number) — a de-facto "notify several people" hack
-- standing in for shared access. They are a property of the workspace, not of
-- a person's identity, so they belong here.

ALTER TABLE organisations ADD COLUMN notify_emails   TEXT;
ALTER TABLE organisations ADD COLUMN notify_whatsapp TEXT;

COMMENT ON COLUMN organisations.notify_emails   IS 'Comma-separated alert recipients';
COMMENT ON COLUMN organisations.notify_whatsapp IS 'Comma-separated WhatsApp numbers for alerts';
