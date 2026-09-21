-- Whether an incoming message is marked read the moment it arrives.
--
-- On by default, because a workspace that answers from the Inbox wants the
-- sender to see blue ticks. A workspace that answers on the phone itself wants
-- it off: WhatsApp syncs read state across linked devices, so a message this
-- box marks read a second after it lands shows up on the phone as already
-- handled, and the phone never raises a notification for it.
ALTER TABLE organisations
    ADD COLUMN auto_read_receipts boolean NOT NULL DEFAULT TRUE;
