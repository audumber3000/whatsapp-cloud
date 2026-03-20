const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: process.env.EMAIL_PORT == 465, // true for 465, false for other ports
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

/**
 * Send an email
 * @param {string} to - Recipient email
 * @param {string} subject - Email subject
 * @param {string} text - Plain text body
 * @param {string} html - HTML body (optional)
 */
async function sendEmail(to, subject, text, html) {
    if (!to) return;
    
    try {
        const info = await transporter.sendMail({
            from: process.env.EMAIL_FROM,
            to,
            subject,
            text,
            html: html || text.replace(/\n/g, '<br>'),
        });
        console.log(`[Email] Sent to ${to}: ${info.messageId}`);
        return true;
    } catch (error) {
        console.error(`[Email] Failed to send to ${to}:`, error.message);
        return false;
    }
}

module.exports = { sendEmail };
