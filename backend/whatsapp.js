const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

let currentQR = '';
let isConnected = false;
let io;

const setIo = (socketIo) => {
    io = socketIo;
};

const emitStatus = () => {
    if (io) {
        console.log(`[WA] Emitting status via socket: isConnected=${isConnected}, qrLength=${currentQR.length}`);
        io.emit('wa_status', { isConnected, currentQR });
    } else {
        console.log('[WA] Cannot emit status: io is not set');
    }
};

// Factory — creates a fresh Client instance with all event listeners attached
function createClient() {
    // Clean up any stale Puppeteer lock files (safe to do on every create)
    const lockPath = path.join(__dirname, '.wwebjs_auth', 'session', 'SingletonLock');
    if (fs.existsSync(lockPath)) { try { fs.unlinkSync(lockPath); } catch(e) {} }
    const cookiePath = path.join(__dirname, '.wwebjs_auth', 'session', 'SingletonCookie');
    if (fs.existsSync(cookiePath)) { try { fs.unlinkSync(cookiePath); } catch(e) {} }

    const isARM = process.arch === 'arm64' || process.arch === 'aarch64';
    const defaultChromePath = isARM ? '/usr/bin/chromium-browser' : undefined;
    const executablePath = process.env.CHROME_PATH || defaultChromePath;

    const newClient = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            executablePath: executablePath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-extensions',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu'
            ]
        }
    });

    newClient.on('qr', (qr) => {
        console.log(`[WA] QR RECEIVED. Length: ${qr.length}`);
        qrcode.generate(qr, { small: true });
        currentQR = qr;
        console.log(`[WA] currentQR updated. Length now: ${currentQR.length}`);
        emitStatus();
    });

    newClient.on('ready', () => {
        console.log('[WA] WhatsApp Client is ready!');
        isConnected = true;
        currentQR = '';
        console.log('[WA] currentQR cleared (ready)');
        emitStatus();
    });

    newClient.on('authenticated', () => {
        console.log('[WA] WhatsApp Client Authenticated');
    });

    newClient.on('auth_failure', (msg) => {
        console.error('[WA] WhatsApp Authentication Failure', msg);
        isConnected = false;
        currentQR = '';
        console.log('[WA] currentQR cleared (auth_failure)');
        emitStatus();
    });

    newClient.on('disconnected', (reason) => {
        console.log('WhatsApp Client was disconnected:', reason);
        isConnected = false;
        emitStatus();
    });

    return newClient;
}

// Boot up on server start
console.log('Initializing WhatsApp Client...');
client = createClient();
client.initialize();

/**
 * Send a WhatsApp Message
 * Uses whichever client is currently active (even after a disconnect/reconnect cycle)
 */
const sendMessage = async (phone, message) => {
    try {
        await client.sendMessage(`${phone}@c.us`, message);
        console.log(`Message sent to ${phone}`);
        return true;
    } catch (error) {
        console.error('Error sending message:', error);
        return false;
    }
};

/**
 * Fully disconnect and reinitialize with a brand-new Client instance.
 * Calling initialize() on a destroyed client is unreliable in whatsapp-web.js —
 * a fresh instance guarantees a clean QR code screen every time.
 */
const disconnectClient = async () => {
    try {
        // Immediately reflect disconnected state to the frontend
        isConnected = false;
        currentQR = '';
        emitStatus();

        // Graceful logout + browser teardown (errors are non-fatal)
        try { await client.logout(); } catch(e) { console.log('logout skipped:', e.message); }
        try { await client.destroy(); } catch(e) { console.log('destroy skipped:', e.message); }

        // Wipe the entire session folder so the new client starts fresh
        const sessionPath = path.join(__dirname, '.wwebjs_auth');
        if (fs.existsSync(sessionPath)) {
            console.log('Clearing WhatsApp session files...');
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }

        // Spin up a completely fresh client — no shared state with the old one
        console.log('Creating fresh WhatsApp client for new QR...');
        client = createClient();
        client.initialize();

        return true;
    } catch (error) {
        console.error('Failed to disconnect client:', error);
        return false;
    }
};

module.exports = {
    sendMessage,
    disconnectClient,
    setIo,
    getStatus: () => ({ isConnected, currentQR })
};
