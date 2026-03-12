module.exports = {
    apps: [{
        name: "whatsapp-automation",
        script: "./server.js",
        instances: 1, // EXACTLY 1 instance for whatsapp-web.js (no clustering)
        exec_mode: "fork",
        watch: false, // Do not watch for changes in production to avoid restart loops
        max_memory_restart: "1G",
        env: {
            NODE_ENV: "production",
            PORT: 3000
        }
    }]
}
