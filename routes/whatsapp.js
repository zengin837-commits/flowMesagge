const router  = require('express').Router();
const auth    = require('../middleware/auth');
const Session = require('../models/Session');
const qrcode  = require('qrcode');
const path    = require('path');
const fs      = require('fs');

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino    = require('pino');

async function startSocket(userId, method, phoneNumber) {
  const authFolder = path.join(__dirname, '../sessions', userId.toString());
  if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    mobile: method === 'phone'
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
        global.io.to(userId.toString()).emit('pairing_code', { code });
      } catch (e) {
        global.io.to(userId.toString()).emit('error', { message: e.message });
      }
    }, 3000);
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && method === 'qr') {
      try {
        const qrImage = await qrcode.toDataURL(qr);
        global.io.to(userId.toString()).emit('qr', { qr: qrImage });
        await Session.findOneAndUpdate({ userId }, { status: 'qr_ready' });
      } catch (e) { console.error(e); }
    }

    if (connection === 'open') {
      await Session.findOneAndUpdate({ userId }, { status: 'connected', phone: sock.user?.id });
      global.io.to(userId.toString()).emit('connected', { phone: sock.user?.id });
    }

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      await Session.findOneAndUpdate({ userId }, { status: 'disconnected' });
      global.io.to(userId.toString()).emit('disconnected', {});
      delete global.activeSockets[userId];

      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => startSocket(userId, 'qr'), 5000);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
  return sock;
}

// QR ile bağlan
router.post('/connect/qr', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    if (global.activeSockets[userId])
      return res.json({ message: 'Zaten bağlanıyor' });
    await startSocket(userId, 'qr');
    res.json({ message: 'QR bekleniyor...' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Telefon kodu ile bağlan
router.post('/connect/phone', auth, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Telefon numarası zorunlu' });
    const userId = req.user.id;
    if (global.activeSockets[userId])
      return res.json({ message: 'Zaten bağlanıyor' });
    await startSocket(userId, 'phone', phone);
    res.json({ message: 'Eşleştirme kodu gönderiliyor...' });
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

// Bağlantıyı kes
router.post('/disconnect', auth, async (req, res) => {
  try {
    const sock = global.activeSockets[req.user.id];
    if (sock) {
      await sock.logout();
      delete global.activeSockets[req.user.id];
    }
    await Session.findOneAndUpdate({ userId: req.user.id }, { status: 'disconnected' });
    res.json({ message: 'Bağlantı kesildi' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Grupları getir
router.get('/groups', auth, async (req, res) => {
  try {
    const sock = global.activeSockets[req.user.id];
    if (!sock) return res.status(400).json({ error: 'WhatsApp bağlı değil' });
    const chats  = await sock.groupFetchAllParticipating();
    const groups = Object.values(chats).map(g => ({
      id:      g.id,
      name:    g.subject,
      members: g.participants?.length || 0,
      desc:    g.desc || ''
    }));
    res.json({ groups });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, startSocket };
