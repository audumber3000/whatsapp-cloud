const cron = require('node-cron');
const db = require('./db');
const { sendMessage, notifyUser } = require('./whatsapp');
const { sendEmail } = require('./email');

// Helper to log system notifications
async function logNotification(userId, type, category, recipient, content, status) {
    db.run(
        `INSERT INTO notification_logs (user_id, type, category, recipient, content, status) VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, type, category, recipient, content, status]
    );
}

// Helper to pause execution
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

cron.schedule('* * * * *', () => {
    console.log('Checking for scheduled assignments...');

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');

    const currentMinuteString = `${year}-${month}-${day} ${hours}:${minutes}`;

    // --- standard reminders ---
    db.all(`
        SELECT reminders.id, reminders.user_id, reminders.message, contacts.phone 
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
            const { id, user_id, message, phone } = row;
            const success = await sendMessage(user_id, phone, message);
            const newStatus = success ? 'sent' : 'failed';
            db.run(`UPDATE reminders SET status = ? WHERE id = ?`, [newStatus, id]);
        }
    });

    // --- advanced automations queue ---
    const currentIsoString = now.toISOString();
    db.all(`
        SELECT al.id as log_id, al.contact_id, al.automation_id, c.phone, a.user_id, a.message_template, a.status as auto_status, a.active_days, al.sent_time
        FROM automation_logs al
        JOIN contacts c ON al.contact_id = c.id
        JOIN automations a ON al.automation_id = a.id
        WHERE al.status = 'pending' AND al.sent_time <= ?
    `, [currentIsoString], async (err, rows) => {
        if (err) {
            console.error('Error querying automations:', err);
            return;
        }

        if (rows.length > 0) {
            console.log(`Found ${rows.length} pending automation messages to send.`);
        }

        for (const row of rows) {
            const { log_id, contact_id, automation_id, phone, user_id, message_template, auto_status, active_days, sent_time } = row;
            
            let messageBlocks = [];
            try {
                // Determine if it is a JSON array of blocks
                const parsed = JSON.parse(message_template);
                if (Array.isArray(parsed)) {
                    messageBlocks = parsed;
                } else {
                    messageBlocks = [{ variations: [String(message_template)] }];
                }
            } catch (e) {
                // Fallback to simple string
                messageBlocks = [{ variations: [String(message_template)] }];
            }

            let overallSuccess = true;

            // Send each block sequentially with a short delay for multi-message blocks
            for (let i = 0; i < messageBlocks.length; i++) {
                const block = messageBlocks[i];
                if (block.variations && block.variations.length > 0) {
                    const rndIndex = Math.floor(Math.random() * block.variations.length);
                    const msgText = block.variations[rndIndex];

                    if (msgText.trim()) {
                        const success = await sendMessage(user_id, phone, msgText);
                        if (!success) overallSuccess = false;

                        // Add small 2-5 second visual typewriter delay between multiple blocks targeting same user
                        if (i < messageBlocks.length - 1 && overallSuccess) {
                            const delayMs = Math.floor(Math.random() * 3000) + 2000;
                            await sleep(delayMs);
                        }
                    }
                }
            }

            // Update the log status and content
            const newStatus = overallSuccess ? 'delivered' : 'failed';
            const logReason = overallSuccess ? null : 'Failed to reach WhatsApp client or failure in dispatch sequence';
            const sentContent = messageBlocks.map(b => b.variations[0]).join('\n'); // Simplified for logging
            db.run(`UPDATE automation_logs SET status = ?, error_reason = ?, content = ? WHERE id = ?`, [newStatus, logReason, sentContent, log_id]);

            // Reschedule for tomorrow if the automation is still active
            if (auto_status === 'Active') {
                db.get(`SELECT start_time, end_time, active_days, timezone_offset FROM automations WHERE id = ?`, [automation_id], (errAuto, autoDetails) => {
                    if (errAuto || !autoDetails) return;

                    let daysArray;
                    try {
                        daysArray = JSON.parse(autoDetails.active_days) || [0,1,2,3,4,5,6];
                    } catch(e) {
                        daysArray = [0,1,2,3,4,5,6];
                    }

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

                    db.run(
                        `INSERT INTO automation_logs (automation_id, contact_id, status, sent_time) VALUES (?, ?, 'pending', ?)`, 
                        [automation_id, contact_id, nextScheduleUTC.toISOString()]
                    );
                });
            }
        }
    });

    // --- Daily Campaign Notifications & Summaries ---
    // We check this every minute to see if we should send a START alert or END summary
    db.all(`
        SELECT a.id, a.user_id, a.name, a.last_summary_sent_date, a.last_start_notified_date,
               a.start_time, a.end_time, a.timezone_offset, u.personal_whatsapp_number, u.email as user_email
        FROM automations a
        JOIN users u ON a.user_id = u.id
        WHERE a.status = 'Active' AND (u.personal_whatsapp_number IS NOT NULL OR u.email IS NOT NULL)
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
                    SUM(CASE WHEN status IN ('delivered', 'read', 'sent') THEN 1 ELSE 0 END) as sentCount,
                    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failedCount,
                    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pendingCount,
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
                                
                                // WhatsApp (Handle multiple numbers)
                                if (auto.personal_whatsapp_number) {
                                    const numbers = auto.personal_whatsapp_number.split(',').map(n => n.trim()).filter(Boolean);
                                    for (const num of numbers) {
                                        const waSuccess = await sendMessage(auto.user_id, num, startMsg);
                                        logNotification(auto.user_id, 'whatsapp', 'start_alert', num, startMsg, waSuccess ? 'sent' : 'failed');
                                    }
                                }
                                
                                // Email (Handle multiple emails)
                                if (auto.user_email) {
                                    const emails = auto.user_email.split(',').map(e => e.trim()).filter(Boolean);
                                    for (const e of emails) {
                                        const emailSuccess = await sendEmail(e, `🚀 Automation Starting: ${auto.name}`, startMsg);
                                        logNotification(auto.user_id, 'email', 'start_alert', e, startMsg, emailSuccess ? 'sent' : 'failed');
                                    }
                                }

                                notifyUser(auto.user_id, 'info', `Started automation "${auto.name}"`);
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
                                
                                // WhatsApp
                                if (auto.personal_whatsapp_number) {
                                    const numbers = auto.personal_whatsapp_number.split(',').map(n => n.trim()).filter(Boolean);
                                    for (const num of numbers) {
                                        const waSuccess = await sendMessage(auto.user_id, num, summaryMsg);
                                        logNotification(auto.user_id, 'whatsapp', 'daily_summary', num, summaryMsg, waSuccess ? 'sent' : 'failed');
                                    }
                                }
                                
                                // Email
                                if (auto.user_email) {
                                    const emails = auto.user_email.split(',').map(e => e.trim()).filter(Boolean);
                                    for (const e of emails) {
                                        const emailSuccess = await sendEmail(e, `🏁 Daily Summary: ${auto.name}`, summaryMsg);
                                        logNotification(auto.user_id, 'email', 'daily_summary', e, summaryMsg, emailSuccess ? 'sent' : 'failed');
                                    }
                                }

                                notifyUser(auto.user_id, 'success', `Sent summary for "${auto.name}"`);
                            }
                        });
                    });
                }
            });
        }
    });

});

console.log('Scheduler is running.');
