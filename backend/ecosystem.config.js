module.exports = {
    apps: [{
        name: "whatsapp-automation",
        script: "./server.js",
        // Still exactly 1 — but for a different reason than before. Chromium is
        // gone, so whatsapp-web.js no longer forces this; the scheduler does.
        // scheduler.js runs in-process via require('./scheduler'), so a second
        // instance would run a second cron loop and send every message twice.
        instances: 1,
        exec_mode: "fork",
        watch: false, // Do not watch for changes in production to avoid restart loops
        // Raised from 1G: that cap existed to paper over the Chromium memory
        // leak. Without a browser, steady-state is a fraction of it, so this is
        // now a genuine runaway guard rather than a routine restart.
        max_memory_restart: "512M",
        env: {
            NODE_ENV: "production",
            PORT: 3000
        }
    }]
}
