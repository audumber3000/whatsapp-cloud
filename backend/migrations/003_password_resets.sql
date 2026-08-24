-- Password reset and email verification tokens.
--
-- Neither existed: there was no way to change a password at all, let alone
-- recover a forgotten one. Tokens are stored hashed and single-use — the raw
-- value only ever exists in the email.

CREATE TABLE auth_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose     TEXT NOT NULL,            -- 'password_reset' | 'email_verify'
    token_hash  TEXT UNIQUE NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_ip  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_authtokens_user ON auth_tokens(user_id, purpose);

-- Changing a password must be able to invalidate every other session, so we
-- need to know when it last changed relative to when a token was issued.
ALTER TABLE users ADD COLUMN password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
