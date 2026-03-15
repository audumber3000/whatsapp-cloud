const cron = require('node-cron');
const db = require('./db');
const { sendMessage } = require('./whatsapp');

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

            // Update the log status
            const newStatus = overallSuccess ? 'delivered' : 'failed';
            const logReason = overallSuccess ? null : 'Failed to reach WhatsApp client or failure in dispatch sequence';
            db.run(`UPDATE automation_logs SET status = ?, error_reason = ? WHERE id = ?`, [newStatus, logReason, log_id]);

            // Reschedule for tomorrow if the automation is still active and it sent successfully
            if (auto_status === 'Active' && overallSuccess) {
                let daysArray;
                try {
                    daysArray = JSON.parse(active_days) || [0,1,2,3,4,5,6];
                } catch(e) {
                    daysArray = [0,1,2,3,4,5,6];
                }

                const oldDate = new Date(sent_time);
                oldDate.setDate(oldDate.getDate() + 1);

                while (!daysArray.includes(oldDate.getDay())) {
                    oldDate.setDate(oldDate.getDate() + 1);
                }

                const jitterMs = (Math.random() * 20 - 10) * 60 * 1000;
                const nextSchedule = new Date(oldDate.getTime() + jitterMs);

                db.run(
                    `INSERT INTO automation_logs (automation_id, contact_id, status, sent_time) VALUES (?, ?, 'pending', ?)`, 
                    [automation_id, contact_id, nextSchedule.toISOString()]
                );
            }
        }
    });

    // --- Daily Campaign Summaries ---
    // Runs every minute, but we'll check against last_summary_sent_date
    db.all(`
        SELECT a.id, a.user_id, a.name, a.last_summary_sent_date, u.personal_whatsapp_number
        FROM automations a
        JOIN users u ON a.user_id = u.id
        WHERE a.status = 'Active' AND u.personal_whatsapp_number IS NOT NULL AND u.personal_whatsapp_number != ''
    `, async (err, automations) => {
        if (err) return console.error('Error querying for summaries:', err);
        
        const todayStr = new Date().toISOString().split('T')[0];

        for (const auto of automations) {
            // Already sent today
            if (auto.last_summary_sent_date === todayStr) continue;

            // Stats for today (start of day to end of day)
            const todayStart = todayStr + 'T00:00:00.000Z';
            const todayEnd = todayStr + 'T23:59:59.999Z';
            
            db.get(`
                SELECT 
                    SUM(CASE WHEN status IN ('delivered', 'read', 'sent') THEN 1 ELSE 0 END) as sentCount,
                    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failedCount,
                    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pendingTodayCount,
                    MIN(sent_time) as startTime,
                    MAX(sent_time) as endTime
                FROM automation_logs 
                WHERE automation_id = ? AND sent_time >= ? AND sent_time <= ?
            `, [auto.id, todayStart, todayEnd], async (err3, stats) => {
                if (err3 || !stats) return;

                const processedCount = (stats.sentCount || 0) + (stats.failedCount || 0);
                const pendingCount = stats.pendingTodayCount || 0;
                
                // Only send summary if:
                // 1. We have actually processed at least one message today
                // 2. There are NO messages left to send for the rest of today
                if (processedCount > 0 && pendingCount === 0) {
                    // Prevent duplicate sends by updating db right away
                    db.run(`UPDATE automations SET last_summary_sent_date = ? WHERE id = ?`, [todayStr, auto.id], async (updateErr) => {
                        if (!updateErr) {
                            // Send summary to their personal number
                            const summaryMsg = `*Daily Summary: ${auto.name}*\n\n✅ Sent: ${stats.sentCount || 0}\n❌ Failed: ${stats.failedCount || 0}\n\nStarted: ${new Date(stats.startTime).toLocaleTimeString()}\nEnded: ${new Date(stats.endTime).toLocaleTimeString()}`;
                            
                            await sendMessage(auto.user_id, auto.personal_whatsapp_number, summaryMsg);
                        }
                    });
                }
            });
        }
    });

});

console.log('Scheduler is running.');
