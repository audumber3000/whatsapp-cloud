const cron = require('node-cron');
const db = require('./db');
const { sendMessage } = require('./whatsapp');

// We will check the database every minute for reminders
// We assume scheduled_time is in 'YYYY-MM-DD HH:mm' format
// In a real app, you might want more robust time parsing (e.g. using moment or date-fns)
cron.schedule('* * * * *', () => {
    console.log('Checking for scheduled remainders...');

    // Get the current time string in 'YYYY-MM-DD HH:mm' format local time
    // For simplicity of this basic demo, we use ISO substring and replace T with space
    // and remove seconds. Depending on your timezone logic, this might need adjustments.

    const now = new Date();
    // A quick hack for zero-padded local time string like '2023-10-24 14:30'
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');

    const currentMinuteString = `${year}-${month}-${day} ${hours}:${minutes}`;

    // Query Pending reminders for exactly this minute (or earlier if they were missed)
    db.all(`
        SELECT reminders.id, reminders.message, contacts.phone 
        FROM reminders 
        JOIN contacts ON reminders.contact_id = contacts.id
        WHERE status = 'pending' AND scheduled_time <= ?
    `, [currentMinuteString], async (err, rows) => {
        if (err) {
            console.error('Error querying reminders:', err);
            return;
        }

        if (rows.length > 0) {
            console.log(`Found ${rows.length} pending standard reminders to send.`);
        }

        for (const row of rows) {
            const { id, message, phone } = row;
            // Send WhatsApp message
            const success = await sendMessage(phone, message);

            // Update status
            const newStatus = success ? 'sent' : 'failed';
            db.run(`UPDATE reminders SET status = ? WHERE id = ?`, [newStatus, id]);
        }
    });

    // Handle Advanced Automations queue 
    // We check for any automation_logs that are pending and their sent_time has arrived
    const currentIsoString = now.toISOString();
    db.all(`
        SELECT al.id, al.contact_id, al.automation_id, c.phone, a.message_template, a.status as auto_status, a.active_days, al.sent_time
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
            const { id, contact_id, automation_id, phone, message_template, auto_status, active_days, sent_time } = row;
            // Execute send
            const success = await sendMessage(phone, message_template);

            // Update the log status
            const newStatus = success ? 'delivered' : 'failed';
            const logReason = success ? null : 'Failed to reach WhatsApp client';
            db.run(`UPDATE automation_logs SET status = ?, error_reason = ? WHERE id = ?`, [newStatus, logReason, id]);

            // Reschedule for tomorrow if the automation is still active and it sent successfully
            if (auto_status === 'Active' && success) {
                let daysArray;
                try {
                    daysArray = JSON.parse(active_days) || [0,1,2,3,4,5,6];
                } catch(e) {
                    daysArray = [0,1,2,3,4,5,6];
                }

                // Parse the original scheduled time so it's reliably 24 hours later,
                // rather than 24 hours from "now" which creeps forward slowly
                const oldDate = new Date(sent_time);
                
                // Add exactly 24 hours at least once
                oldDate.setDate(oldDate.getDate() + 1);

                // Fast forward if the next day is not active
                while (!daysArray.includes(oldDate.getDay())) {
                    oldDate.setDate(oldDate.getDate() + 1);
                }

                // Add up to +/- 10 minutes of daily jitter to make it seem human
                const jitterMs = (Math.random() * 20 - 10) * 60 * 1000;
                const nextSchedule = new Date(oldDate.getTime() + jitterMs);

                db.run(
                    `INSERT INTO automation_logs (automation_id, contact_id, status, sent_time) VALUES (?, ?, 'pending', ?)`, 
                    [automation_id, contact_id, nextSchedule.toISOString()]
                );
            }
        }
    });
});

console.log('Scheduler is running.');
