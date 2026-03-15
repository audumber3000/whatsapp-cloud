const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const clients = new Map();
let io;

const setIo = (socketIo) => {
    io = socketIo;
};

const emitStatus = (userId) => {
    const data = getStatus(userId);
    if (io) {
        console.log(`[WA] Emitting status via socket for user ${userId}: isConnected=${data.isConnected}, qrLength=${data.currentQR ? data.currentQR.length : 0}`);
        io.to(`user_${userId}`).emit('wa_status', data);
    } else {
        console.log(`[WA] Cannot emit status: io is not set for user ${userId}`);
    }
};

const getStatus = (userId) => {
    const session = clients.get(userId);
    if (!session) {
        return { isConnected: false, currentQR: '', phone: null };
    }
    return { 
        isConnected: session.isConnected, 
        currentQR: session.currentQR,
        // wid.user contains the phone number
        phone: session.info && session.info.wid ? session.info.wid.user : null 
    };
};

function createClient(userId) {
    if (clients.has(userId)) {
        return clients.get(userId).client;
    }

    const sessionDirName = path.join('sessions', `.wwebjs_auth_user_${userId}`);
    
    // Ensure sessions directory exists
    const sessionsRoot = path.join(__dirname, 'sessions');
    if (!fs.existsSync(sessionsRoot)) {
        fs.mkdirSync(sessionsRoot, { recursive: true });
    }

    // Clean up locks
    const sessionPath = path.join(__dirname, sessionDirName, 'session');
    if (fs.existsSync(sessionPath)) {
        const files = fs.readdirSync(sessionPath);
        files.forEach(file => {
            if (file.startsWith('Singleton')) {
                try { fs.unlinkSync(path.join(sessionPath, file)); } catch(e) {}
            }
        });
    }

    const isLinuxARM = process.platform === 'linux' && (process.arch === 'arm64' || process.arch === 'aarch64' || process.arch === 'arm');
    const defaultChromePath = isLinuxARM ? '/usr/bin/chromium-browser' : undefined;
    const executablePath = process.env.CHROME_PATH || defaultChromePath;

    const newClient = new Client({
        authStrategy: new LocalAuth({
            dataPath: path.join(__dirname, sessionDirName)
        }),
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
            ],
            protocolTimeout: 60000
        }
    });

    const sessionData = {
        client: newClient,
        isConnected: false,
        currentQR: '',
        info: null
    };

    clients.set(userId, sessionData);

    newClient.on('qr', (qr) => {
        console.log(`[WA User ${userId}] QR RECEIVED. Length: ${qr.length}`);
        qrcode.generate(qr, { small: true });
        sessionData.currentQR = qr;
        emitStatus(userId);
    });

    newClient.on('ready', () => {
        console.log(`[WA User ${userId}] WhatsApp Client is ready!`);
        sessionData.isConnected = true;
        sessionData.currentQR = '';
        sessionData.info = newClient.info;
        emitStatus(userId);
    });

    newClient.on('authenticated', () => {
        console.log(`[WA User ${userId}] WhatsApp Client Authenticated`);
    });

    newClient.on('auth_failure', (msg) => {
        console.error(`[WA User ${userId}] WhatsApp Authentication Failure`, msg);
        sessionData.isConnected = false;
        sessionData.currentQR = '';
        emitStatus(userId);
    });

    newClient.on('disconnected', (reason) => {
        console.log(`[WA User ${userId}] WhatsApp Client was disconnected:`, reason);
        sessionData.isConnected = false;
        sessionData.currentQR = '';
        sessionData.info = null;
        emitStatus(userId);
    });

    newClient.initialize();
    return newClient;
}

const initializeUserClient = (userId) => {
    if (!clients.has(userId)) {
        createClient(userId);
    }
};

const sendMessage = async (userId, phone, message) => {
    try {
        const session = clients.get(userId);
        if (!session || !session.isConnected) {
            console.error(`[WA] User ${userId} is not connected to WhatsApp`);
            return false;
        }
        await session.client.sendMessage(`${phone}@c.us`, message);
        console.log(`Message sent to ${phone} by user ${userId}`);
        return true;
    } catch (error) {
        console.error(`Error sending message for user ${userId}:`, error);
        return false;
    }
};

const disconnectClient = async (userId) => {
    try {
        const session = clients.get(userId);
        if (!session) return false;

        session.isConnected = false;
        session.currentQR = '';
        session.info = null;
        emitStatus(userId);

        try { await session.client.logout(); } catch(e) { console.log('logout skipped:', e.message); }
        try { await session.client.destroy(); } catch(e) { console.log('destroy skipped:', e.message); }

        clients.delete(userId);
 
        const sessionPath = path.join(__dirname, 'sessions', `.wwebjs_auth_user_${userId}`);
        if (fs.existsSync(sessionPath)) {
            console.log(`Clearing WhatsApp session files for user ${userId}...`);
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }

        console.log(`Creating fresh WhatsApp client for new QR for user ${userId}...`);
        createClient(userId);

        return true;
    } catch (error) {
        console.error(`Failed to disconnect client for user ${userId}:`, error);
        return false;
    }
};

module.exports = {
    sendMessage,
    disconnectClient,
    setIo,
    getStatus,
    initializeUserClient
};
