/**
 * Outbound email — the transport behind every alert this product sends:
 * WhatsApp disconnection, send failures, daily summaries, password reset.
 *
 * Why this file is defensive out of proportion to its size: in September 2026
 * these five variables were blank in production. Every alert was dropped for
 * ten days while a clinic's number was dead and 95 reminders a day failed, and
 * nothing anywhere said so. An unconfigured or misauthenticated mailer is not
 * a quiet edge case here — it is the failure that hides every other failure.
 *
 * So: configuration is checked at boot, not on first use; the state is exposed
 * for /api/health to report; and a dropped message is logged as an error
 * naming what was lost, never swallowed.
 */

const nodemailer = require('nodemailer');
require('dotenv').config();

const HOST = process.env.EMAIL_HOST || '';
const PORT = Number(process.env.EMAIL_PORT) || 587;
const USER = process.env.EMAIL_USER || '';
const PASS = process.env.EMAIL_PASS || '';
// Zoho (and most providers) reject a From that is not the authenticated
// mailbox or a verified alias, so default it to the login rather than empty.
const FROM = process.env.EMAIL_FROM || USER;

const isConfigured = () => Boolean(HOST && USER && PASS);

/** 'not-configured' | 'unverified' | 'ok' | 'failed' */
let smtpState = isConfigured() ? 'unverified' : 'not-configured';
let lastError = null;

const getState = () => smtpState;
const getLastError = () => lastError;

const transporter = isConfigured()
    ? nodemailer.createTransport({
        host: HOST,
        port: PORT,                 // Number(), not the raw string
        secure: PORT === 465,       // 465 is implicit TLS; 587 upgrades via STARTTLS
        auth: { user: USER, pass: PASS },
    })
    : null;

/**
 * Prove the credentials work at startup rather than discovering it on the
 * first alert — which, for a disconnection alert, is the one moment someone
 * is relying on it.
 */
async function verify() {
    if (!transporter) {
        smtpState = 'not-configured';
        console.warn('[Email] NOT CONFIGURED — disconnection alerts, send-failure alerts, '
            + 'daily summaries and password reset cannot be delivered. '
            + 'Set EMAIL_HOST, EMAIL_USER, EMAIL_PASS in .env.prod.');
        return false;
    }
    try {
        await transporter.verify();
        smtpState = 'ok';
        lastError = null;
        console.log(`[Email] SMTP ready — ${USER} via ${HOST}:${PORT} (secure=${PORT === 465})`);
        return true;
    } catch (err) {
        smtpState = 'failed';
        lastError = err.message;
        console.error(`[Email] SMTP VERIFY FAILED — ${HOST}:${PORT} as ${USER}: ${err.message}`);
        console.error('[Email] No alert or password-reset mail will be delivered until this is fixed.');
        return false;
    }
}

/**
 * Send an email.
 * @param {string} to      Recipient
 * @param {string} subject Subject line
 * @param {string} text    Plain-text body
 * @param {string} [html]  HTML body; defaults to `text` with newlines as <br>
 * @returns {Promise<boolean>} whether it was accepted by the server
 */
async function sendEmail(to, subject, text, html) {
    if (!to) return false;

    if (!transporter) {
        // Loud on purpose: this is a lost notification, not a no-op.
        console.error(`[Email] DROPPED "${subject}" to ${to} — SMTP is not configured`);
        return false;
    }

    try {
        const info = await transporter.sendMail({
            from: FROM,
            to,
            subject,
            text,
            html: html || String(text).replace(/\n/g, '<br>'),
        });
        if (smtpState !== 'ok') { smtpState = 'ok'; lastError = null; }
        console.log(`[Email] Sent to ${to}: ${info.messageId}`);
        return true;
    } catch (error) {
        smtpState = 'failed';
        lastError = error.message;
        console.error(`[Email] FAILED "${subject}" to ${to}: ${error.message}`);
        return false;
    }
}

module.exports = { sendEmail, verify, getState, getLastError, isConfigured };
