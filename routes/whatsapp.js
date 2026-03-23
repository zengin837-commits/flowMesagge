const router  = require('express').Router();
const auth    = require('../middleware/auth');
const Session = require('../models/Session');
const qrcode  = require('qrcode');
const path    = require('path');
const fs      = require('fs');

let Baileys;
try {
  Baileys = require('@whiskeysockets/baileys');
} catch(e) {
  Baileys = require('@adiwajshing/baileys');
}

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = Baileys;

const { Boom } = require('@hapi/boom');
const pino = require('pino');

async function startSocket(userId, method, phoneNumber) {
  try {
    const authFolder = path.join('/tmp/sessions', userId.toString());
    if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();

    console.log('Baileys version:', version);

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: true,
      browser: ['MessageFlow', 'Chrome', '1.0.0'],
    });

    global.activeSockets[userId] = sock;

    await Session.findOneAndUpdate(
      { userId },
      { userId, status: 'pending', authFolder },
      { upsert: true, new: true }
    );

    if (method === 'phone' && phoneNumber && !sock.authState.creds.registered) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(phoneNumber.replace(/\D/g, ''));
          console.log('Pairing code:', code);
          global.io.to(userId.toString()).emit('pairing_code', { code });
        } catch (e) {
          console.error('Pairing code error:', e.message);
          global.io.to(userId.toString()).emit('error', { message: e.message });
        }
      }, 3000);
    }

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      console.log('Connection update:', connection, qr ? 'QR var' : 'QR yok');

      if (qr) {
        try {
          const qrImage = await qrcode.toDataURL(qr);
          console.log('QR olusturuldu, socket gonderiliyor:', userId);
          global.io.to(userId.toString()).emit('qr', { qr: qrImage });
          await Session.findOneAndUpdate({ userId }, { status: 'qr_ready' });
        } catch (e) {
          console.error('QR olusturma hatasi:', e.message);
        }
      }

      if (connection === 'open') {
        console.log('WhatsApp baglandi:', userId);
        await Session.findOneAndUpdate({ userId }, { 
          status: 'connected', 
          phone: sock.user?.id 
        });
        global.io.to(userId.toString()).emit('connected', { phone: sock.user?.id });
      }

      if (connection === 'close') {
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        console.log('Baglanti kapandi, kod:', code);
        await Session.findOneAndUpdate({ userId }, { status: 'disconnected' });
        global.io.to(userId.toString()).emit('disconnected', {});
        delete global.activeSockets[userId];

        if (code !== DisconnectReason.loggedOut) {
          console.log('Yeniden baglaniliyor...');
          setTimeout(() => startSocket(userId, 'qr'), 5000);
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);
    return sock;

  } catch(e) {
    console.error('startSocket hatasi:', e.message);
    throw e;
  }
}

// QR ile baglan
router.post('/connect/qr', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('QR baglantisi istendi:', userId);

    if (global.activeSockets[userId]) {
      delete global.activeSockets[userId];
    }

    await startSocket(userId, 'qr');
    res.json({ message: 'QR olusturuluyor...' });
  } catch (e) {
    console.error('connect/qr hatasi:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Telefon kodu ile baglan
router.post('/connect/phone', auth, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Telefon numarasi zorunlu' });
    const userId = req.user.id;

    if (global.activeSockets[userId]) {
      delete global.activeSockets[userId];
    }

    await startSocket(userId, 'phone', phone);
    res.json({ message: 'Eslestirme kodu gonderiliyor...' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Durum
router.get('/status', auth, async (req, res) => {
  try {
    const session = await Session.findOne({ userId: req.user.id });
    const live    = !!global.activeSockets[req.user.id];
    res.json({ session, live });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Baglantıyi kes
router.post('/disconnect', auth, async (req, res) => {
  try {
    const sock = global.activeSockets[req.user.id];
    if (sock) {
      try { await sock.logout(); } catch(e) {}
      delete global.activeSockets[req.user.id];
    }
    await Session.findOneAndUpdate({ userId: req.user.id }, { status: 'disconnected' });
    res.json({ message: 'Baglanti kesildi' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Gruplari getir
router.get('/groups', auth, async (req, res) => {
  try {
    const sock = global.ac
