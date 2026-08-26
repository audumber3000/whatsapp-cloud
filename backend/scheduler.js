const cron = require('node-cron');
const notify = require('./notify');
const path = require('path');
const db = require('./db');
const { sendMessage, sendMedia, notifyUser, getStatus, sendConfirmation, showTyping } = require('./whatsapp');
const { sendEmail } = require('./email');

// Promise helpers
const allP = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows || [])));
const runP = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));

// Look up a stored media attachment by id -> info needed to send it.
const MEDIA_DIR = path.join(__dirname, 'uploads', 'media');
/**
 * Scoped to the owner on purpose. Without the org_id filter, a reminder or
 * automation could reference another tenant's attachment id and the scheduler
 * would happily read that file and send it out over WhatsApp.
 */
function getMediaById(id, orgId) {
    return new Promise((resolve) => {
        db.get('SELECT * FROM media_attachments WHERE id = ? AND org_id = ?', [id, orgId], (e, row) => {
            if (e || !row) return resolve(null);
            resolve({ filePath: path.join(MEDIA_DIR, row.stored_name), mimetype: row.mimetype, filename: row.original_name });
        });
    });
}

// Helper to log system notifications
async function logNotification(orgId, type, category, recipient, content, status) {
    db.run(
        `INSERT INTO notification_logs (org_id, type, category, recipient, content, status) VALUES (?, ?, ?, ?, ?, ?)`,
        [orgId, type, category, recipient, content, status]
    );
}

/* ── failure alerting ──────────────────────────────────────────────────────
 * On 20 Aug a WhatsApp logout produced 43 consecutive failures over nearly
 * four hours and nobody found out until the next morning, because nothing in
 * this app ever raised an alarm. This is that alarm.
 *
 * Counting is per-user and in-memory; the DB row exists to rate-limit repeats
 * across restarts, not to drive the logic.
 */
const FAIL_THRESHOLD = 3;
const ALERT_COOLDOWN_MIN = 60;
const failStreak = new Map();

async function recordSendOutcome(orgId, ok) {
    if (ok) { failStreak.set(orgId, 0); return; }

    const n = (failStreak.get(orgId) || 0) + 1;
    failStreak.set(orgId, n);
    if (n !== FAIL_THRESHOLD) return; // fire once per streak, not every failure

    // Don't re-alert about the same thing all night.
    const recent = await new Promise((res) => db.get(
        `SELECT id FROM health_alerts WHERE org_id = ? AND kind = 'send_failures'
           AND created_at > ?`,
        [orgId, new Date(Date.now() - ALERT_COOLDOWN_MIN * 60000)], (e, r) => res(r)
    ));
    if (recent) return;

    const detail = `${n} consecutive send failures`;
    db.run('INSERT INTO health_alerts (org_id, kind, detail) VALUES (?, ?, ?)',
        [orgId, 'send_failures', detail]);

    // This used to look up `users WHERE id = orgId` — an org id in a user id
    // column, so it always found nobody and the alert emailed no one. The
    // recipients live on the organisation, which notify.dispatch reads.
    const org = await new Promise((res) => db.get(
        'SELECT name FROM organisations WHERE id = ?', [orgId], (e, r) => res(r)));

    const status = getStatus(orgId);
    const cause = status.isConnected
        ? 'WhatsApp still reports connected, so this may be bad numbers or rate limiting.'
        : 'WhatsApp is NOT connected — the phone most likely needs to be linked again.';

    const subject = '⚠️ WA Reach: messages are failing';
    const body =
        `${detail} for "${org?.name || orgId}".\n\n` +
        `${cause}\n\n` +
        `Nothing further will be delivered until this is fixed. ` +
        `Open WA Reach and check the connection status.`;

    console.error(`[ALERT] user ${orgId}: ${detail}. ${cause}`);
    notifyUser(orgId, 'error', `${detail} — check your WhatsApp connection`);

    // Which of the two advertised events this actually is depends on why the
    // sends failed. Both were previously filed as 'health_alert', a category
    // no toggle on the settings page has ever matched.
    const event = status.isConnected ? 'send_failure' : 'disconnected';
    await notify.dispatch(orgId, event, {
        subject,
        body,
        // No point WhatsApping someone to tell them WhatsApp is down.
        sendWhatsApp: status.isConnected ? sendMessage : null,
    });
}


/**
 * Read a message template into blocks, whatever shape it arrives in.
 *
 * Under SQLite this column was TEXT holding a JSON string. It is jsonb now and
 * node-pg returns a parsed value, so JSON.parse throws — and the old fallback
 * was String(value), which for an array of blocks is the literal text
 * "[object Object]". Real patients received that.
 *
 * Never returns a block whose text is not a string, so a malformed template
 * degrades to sending nothing rather than to sending garbage.
 */
/** Tolerates a parsed jsonb array or a legacy JSON string. */
function toDays(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { const p = JSON.parse(v); if (Array.isArray(p)) return p; } catch { /* fall through */ } }
    return [0, 1, 2, 3, 4, 5, 6];
}

function toBlocks(template) {
    let v = template;
    if (typeof v === 'string') {
        try { v = JSON.parse(v); } catch { return [{ variations: [template] }]; }
    }
    if (Array.isArray(v)) {
        return v
            .map((b) => (b && typeof b === 'object')
                ? { ...b, variations: (b.variations || []).filter((x) => typeof x === 'string') }
                : null)
            .filter(Boolean);
    }
    // A bare object with variations is still usable; anything else is not.
    if (v && typeof v === 'object' && Array.isArray(v.variations)) {
        return [{ ...v, variations: v.variations.filter((x) => typeof x === 'string') }];
    }
    if (v && typeof v === 'object' && typeof v.text === 'string') {
        return [{ variations: [v.text] }];
    }
    return [];
}

// Helper to pause execution
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A web instance can run without the worker.
 *
 * Useful in production (scale the API without duplicating every send) and
 * necessary in development, where this database holds real clinics' queued
 * messages and starting the app must not dispatch them.
 */
if (process.env.SCHEDULER_DISABLED === '1') {
    console.log('[scheduler] disabled by SCHEDULER_DISABLED=1 — nothing will be dispatched.');
} else {

cron.schedule('* * * * *', () => {
    console.log('Checking for scheduled assignments...');

    // Broadcasts due to go out. Deliberately not awaited: a broadcast paces
    // itself over minutes, and the reminder sweep must not wait behind it.
    require('./broadcasts').processDue().catch((e) =>
        console.error('[scheduler] broadcast sweep failed:', e.message));

    // Outbound webhooks waiting to go, including retries.
    require('./webhooks').processDue().catch((e) =>
        console.error('[scheduler] webhook sweep failed:', e.message));

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');

    const currentMinuteString = `${year}-${month}-${day} ${hours}:${minutes}`;

    // --- standard reminders ---
    db.all(`
        SELECT reminders.id, reminders.org_id, reminders.message, reminders.media_id, contacts.phone
        FROM reminders
        JOIN contacts ON reminders.contact_id = contacts.id
        WHERE reminders.status = 'pending' AND reminders.scheduled_time <= ?
    `, [currentMinuteString], async (err, rows) => {
        if (err) {
            console.error('Error querying reminders:', err);
            return;
        }

        if (rows.length > 0) {
            console.log(`Found ${rows.length} pending standard reminders to send.`);
        }

        for (const row of rows) {
          // One bad row must never kill the process: scheduler.js runs inside
          // the API server, so an uncaught throw here takes the whole app down.
          // A missing import did exactly that on 24 Aug.
          try {
              const { id, org_id, message, media_id, phone } = row;
              let success;
              if (media_id) {
                  const media = await getMediaById(media_id, org_id);
                  success = media
                      ? await sendMedia(org_id, phone, { ...media, caption: message })
                      : await sendMessage(org_id, phone, message); // attachment gone — send text only
              } else {
                  success = await sendMessage(org_id, phone, message);
              }
              const newStatus = success ? 'sent' : 'failed';
              db.run(`UPDATE reminders SET status = ? WHERE id = ?`, [newStatus, id]);
          } catch (rowErr) {
            console.error(`[scheduler] reminder failed (id ${row && row.id}):`, rowErr && rowErr.stack || rowErr);
            try { db.run(`UPDATE reminders SET status='failed' WHERE id=?`, [row && row.id]); } catch (_) {}
          }
        }
    });

    // --- advanced automations queue ---
    const currentIsoString = now.toISOString();
    db.all(`
        SELECT al.id as log_id, al.contact_id, al.automation_id, c.phone, a.org_id, a.message_template, a.status as auto_status, a.active_days, al.sent_time, a.name as auto_name, COALESCE(a.ask_confirmation, FALSE) as ask_confirmation
        FROM automation_logs al
        JOIN contacts c ON al.contact_id = c.id
        JOIN automations a ON al.automation_id = a.id
        WHERE al.status = 'pending' AND al.sent_time <= ?
          AND COALESCE(c.opted_out, FALSE) = FALSE
    `, [currentIsoString], async (err, rows) => {
        if (err) {
            console.error('Error querying automations:', err);
            return;
        }

        if (rows.length > 0) {
            console.log(`Found ${rows.length} pending automation messages to send.`);
        }

        for (const row of rows) {
          // Same protection as the reminders loop above: an uncaught throw in
          // here would take the API server down with it.
          try {
              const { log_id, contact_id, automation_id, phone, org_id, message_template, auto_status, active_days, sent_time, auto_name, ask_confirmation } = row;
              let lastMessageId = null;
            
              // message_template is jsonb, so node-pg hands back a parsed value.
              // JSON.parse on an array throws, and the old fallback then did
              // String(array) — which is literally "[object Object]". That is
              // what went out over WhatsApp instead of the clinic's message.
              const messageBlocks = toBlocks(message_template);

              let overallSuccess = true;

              // Send each block sequentially with a short delay for multi-message blocks
              for (let i = 0; i < messageBlocks.length; i++) {
                  const block = messageBlocks[i];

                  // Pick a random caption/message variation (may be empty for media-only blocks)
                  const variations = (block.variations || []).filter(v => typeof v === 'string');
                  const msgText = variations.length ? variations[Math.floor(Math.random() * variations.length)] : '';

                  let didSend = false;
                  if (block.media_id) {
                      // Media block: send the attachment with the chosen variation as caption
                      const media = await getMediaById(block.media_id, org_id);
                      if (media) {
                          const success = await sendMedia(org_id, phone, { ...media, caption: msgText });
                          if (typeof success === 'string') lastMessageId = success;
                          if (!success) overallSuccess = false;
                          didSend = true;
                      } else {
                          overallSuccess = false; // attachment missing
                      }
                  } else if (msgText.trim()) {
                      // "typing…" first — cheap, and it serves the same instinct as
                      // the send jitter and variation rotation: look human.
                      await showTyping(org_id, phone, 1200).catch(() => {});

                      // When the automation asks for confirmation, the LAST text
                      // block goes out with tappable Confirm / Reschedule / Cancel
                      // rather than plain text. The button id comes back on the
                      // reply, so the answer is structured instead of parsed.
                      const isLast = i === messageBlocks.length - 1;
                      const success = (ask_confirmation && isLast)
                          ? await sendConfirmation(org_id, phone, {
                              title: auto_name || 'Appointment',
                              body: msgText,
                              footer: 'Tap an option below',
                            })
                          : await sendMessage(org_id, phone, msgText);
                      if (typeof success === 'string') lastMessageId = success;
                      if (!success) overallSuccess = false;
                      didSend = true;
                  }

                  // Human-like gap between sequential blocks to the same contact
                  if (didSend && i < messageBlocks.length - 1) {
                      const delayMs = Math.floor(Math.random() * 3000) + 2000;
                      await sleep(delayMs);
                  }
              }

              // Update the log status and content
              const newStatus = overallSuccess ? 'delivered' : 'failed';
              // Tell whoever integrated with us. Never awaited into the send
              // path's success: a webhook must not change whether we recorded
              // the message correctly.
              require('./webhooks').emit(org_id,
                  overallSuccess ? 'message.sent' : 'message.failed',
                  {
                      message_id: typeof lastMessageId === 'string' ? lastMessageId : null,
                      log_id, automation: auto_name, to: phone, contact_id,
                      status: newStatus,
                  }).catch(() => {});
              const logReason = overallSuccess ? null : 'Failed to reach WhatsApp client or failure in dispatch sequence';
              const sentContent = messageBlocks.map(b => {
                  const firstVar = (b.variations && b.variations[0]) ? b.variations[0] : '';
                  if (b.media_id) return (b.media_name ? `📎 ${b.media_name}` : '📎 [attachment]') + (firstVar ? ` — ${firstVar}` : '');
                  return firstVar;
              }).filter(Boolean).join('\n'); // Simplified for logging
              // lastMessageId lets the MESSAGES_UPDATE webhook attach a real ack
              // to this row later. Until now "delivered" only meant "handed over".
              db.run(`UPDATE automation_logs SET status = ?, error_reason = ?, content = ?, wa_message_id = ? WHERE id = ?`,
                  [newStatus, logReason, sentContent, (typeof lastMessageId === 'string' ? lastMessageId : null), log_id]);

              recordSendOutcome(org_id, overallSuccess);

              // Reschedule for tomorrow if the automation is still active
              if (auto_status === 'Active') {
                  db.get(`SELECT start_time, end_time, active_days, timezone_offset FROM automations WHERE id = ?`, [automation_id], (errAuto, autoDetails) => {
                      if (errAuto || !autoDetails) return;

                      // Same jsonb trap: JSON.parse on the parsed array threw and
                      // silently fell back to "every day", so the next run
                      // ignored the schedule the clinic actually set.
                      const daysArray = toDays(autoDetails.active_days);

                      const offsetMins = autoDetails.timezone_offset || 0;
                      const [startH, startM] = autoDetails.start_time.split(':').map(Number);
                      const [endH, endM] = autoDetails.end_time.split(':').map(Number);

                      // Move to the next day in the user's timezone
                      const oldDateUTC = new Date(sent_time);
                      let clientNextDate = new Date(oldDateUTC.getTime() - (offsetMins * 60000));
                      clientNextDate.setUTCDate(clientNextDate.getUTCDate() + 1);
                      clientNextDate.setUTCHours(startH, startM, 0, 0);

                      while (!daysArray.includes(clientNextDate.getDay())) {
                          clientNextDate.setUTCDate(clientNextDate.getUTCDate() + 1);
                      }

                      // Calculate jitter within the window
                      let startTotalMins = startH * 60 + startM;
                      let endTotalMins = endH * 60 + endM;
                      if (endTotalMins <= startTotalMins) endTotalMins += 24 * 60;
                      const windowSizeMins = endTotalMins - startTotalMins;
                    
                      const randomOffsetMins = Math.random() * windowSizeMins;
                      const nextScheduleClient = new Date(clientNextDate.getTime() + (randomOffsetMins * 60 * 1000));
                      const nextScheduleUTC = new Date(nextScheduleClient.getTime() + (offsetMins * 60000));

                      // org_id is NOT NULL — without it this insert fails and the
                      // automation never queues its next occurrence, so even one
                      // that fired once would silently stop for good. No callback
                      // meant nothing ever reported it.
                      db.run(
                          `INSERT INTO automation_logs (org_id, automation_id, contact_id, status, sent_time)
                           VALUES (?, ?, ?, 'pending', ?)`,
                          [org_id, automation_id, contact_id, nextScheduleUTC.toISOString()],
                          (errNext) => {
                              if (errNext) console.error('[scheduler] could not queue the next run:', errNext.message);
                          }
                      );
                  });
              }
          } catch (rowErr) {
            console.error(`[scheduler] automation row failed (log ${row && row.log_id}):`, rowErr && rowErr.stack || rowErr);
            try { db.run(`UPDATE automation_logs SET status='failed', error_reason=? WHERE id=?`,
              [String(rowErr && rowErr.message || rowErr).slice(0,200), row && row.log_id]); } catch (_) {}
          }
        }
    });

    // --- Daily Campaign Notifications & Summaries ---
    // We check this every minute to see if we should send a START alert or END summary
    db.all(`
        SELECT a.id, a.org_id, a.name, a.last_summary_sent_date, a.last_start_notified_date,
               a.start_time, a.end_time, a.timezone_offset,
               o.notify_whatsapp AS personal_whatsapp_number, o.notify_emails AS user_email
        FROM automations a
        JOIN organisations o ON o.id = a.org_id
        WHERE a.status = 'Active' AND (o.notify_whatsapp IS NOT NULL OR o.notify_emails IS NOT NULL)
    `, async (err, automations) => {
        if (err) return console.error('Error querying for notifications:', err);
        
        for (const auto of automations) {
            const offsetMins = auto.timezone_offset || 0;
            const todayStr = new Date(Date.now() - (offsetMins * 60000)).toISOString().split('T')[0];

            const localStart = new Date(todayStr + 'T00:00:00.000Z');
            const localEnd = new Date(todayStr + 'T23:59:59.999Z');
            const utcStartRange = new Date(localStart.getTime() + (offsetMins * 60000)).toISOString();
            const utcEndRange = new Date(localEnd.getTime() + (offsetMins * 60000)).toISOString();
            
            db.get(`
                SELECT 
                    SUM(CASE WHEN status IN ('delivered', 'read', 'sent') THEN 1 ELSE 0 END)::int as sentCount,
                    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int as failedCount,
                    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)::int as pendingCount,
                    MIN(sent_time) as firstSentTime
                FROM automation_logs 
                WHERE automation_id = ? AND sent_time >= ? AND sent_time <= ?
            `, [auto.id, utcStartRange, utcEndRange], async (err3, stats) => {
                if (err3 || !stats) return;

                const pendingCount = stats.pendingCount || 0;
                const processedCount = (stats.sentCount || 0) + (stats.failedCount || 0);
                
                // 1. --- START NOTIFICATION ---
                if (pendingCount > 0 && auto.last_start_notified_date !== todayStr) {
                    const firstMsgTimeUTC = new Date(stats.firstSentTime);
                    const nowUTC = new Date();
                    
                    if (firstMsgTimeUTC <= nowUTC || (firstMsgTimeUTC.getTime() - nowUTC.getTime()) < 3600000) {
                        db.run(`UPDATE automations SET last_start_notified_date = ? WHERE id = ?`, [todayStr, auto.id], async (updateErr) => {
                            if (!updateErr) {
                                const startMsg = `🚀 *Automation Starting: ${auto.name}*\n\n🕒 *Window:* ${auto.start_time} - ${auto.end_time}\n📱 *Contact Count:* ${processedCount + pendingCount}\n\nI will send you a summary once all messages are dispatched.`;
                                
                                // Routed through notify.dispatch so the Settings
                                // toggles actually govern this, which they never did.
                                await notify.dispatch(auto.org_id, 'start_alert', {
                                    subject: `Automation starting: ${auto.name}`,
                                    body: startMsg,
                                    sendWhatsApp: sendMessage,
                                });

                                notifyUser(auto.org_id, 'info', `Started automation "${auto.name}"`);
                            }
                        });
                    }
                }

                // 2. --- END SUMMARY ---
                if (processedCount > 0 && pendingCount === 0 && auto.last_summary_sent_date !== todayStr) {
                    db.get(`SELECT MIN(sent_time) as nextRun FROM automation_logs WHERE automation_id = ? AND status = 'pending'`, [auto.id], async (errNext, nextData) => {
                        let nextRunStr = "Not scheduled";
                        if (!errNext && nextData && nextData.nextRun) {
                            nextRunStr = new Date(nextData.nextRun).toLocaleString();
                        }

                        db.run(`UPDATE automations SET last_summary_sent_date = ? WHERE id = ?`, [todayStr, auto.id], async (updateErr) => {
                            if (!updateErr) {
                                const summaryMsg = `🏁 *Daily Summary: ${auto.name}*\n\n✅ Sent: ${stats.sentCount || 0}\n❌ Failed: ${stats.failedCount || 0}\n⏱️ Window: ${auto.start_time} to ${auto.end_time}\n\n📅 *Next Run:* ${nextRunStr}`;
                                
                                await notify.dispatch(auto.org_id, 'daily_summary', {
                                    subject: `Daily summary: ${auto.name}`,
                                    body: summaryMsg,
                                    sendWhatsApp: sendMessage,
                                });

                                notifyUser(auto.org_id, 'success', `Sent summary for "${auto.name}"`);
                            }
                        });
                    });
                }
            });
        }
    });

});

}   // end SCHEDULER_DISABLED guard

console.log(process.env.SCHEDULER_DISABLED === '1'
    ? 'Scheduler is NOT running (SCHEDULER_DISABLED=1).'
    : 'Scheduler is running.');
