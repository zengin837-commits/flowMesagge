const router  = require('express').Router();
const auth    = require('../middleware/auth');
const Session = require('../models/Session');
const qrcode  = require('qrcode');
const path    = require('path');
const fs      = require('fs');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');

async function startSocket(userId, method, phoneNumber) {
  const authFolder = path.join('/tmp/sessions', userId.toString());
  if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  let version;
  try {
    const result = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
    ]);
    version = result.version;
    console.log('Baileys version:', version);
  } catch (e) {
    version = [2, 3000, 1015901307];
    console.log('Baileys version fallback kullanildi:', version);
  }

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    browser: ['MessageFlow', 'Chrome', '1.0.0'],
  });

  global.activeSockets[userId] = { sock, lastQR: null };

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
    console.log('connection.update:', JSON.stringify(update));
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const qrImage = await qrcode.toDataURL(qr);
        if (global.activeSockets[userId]) {
          global.activeSockets[userId].lastQR = qrImage;
        }
        global.io.to(userId.toString()).emit('qr', { qr: qrImage });
        await Session.findOneAndUpdate({ userId }, { status: 'qr_ready' });
        console.log('QR emit edildi, userId:', userId);
      } catch (e) {
        console.error('QR hatasi:', e.message);
      }
    }

    if (connection === 'open') {
      if (global.activeSockets[userId]) {
        global.activeSockets[userId].lastQR = null;
      }
      await Session.findOneAndUpdate(
        { userId },
        { status: 'connected', phone: sock.user?.id }
      );
      global.io.to(userId.toString()).emit('connected', { phone: sock.user?.id });
      console.log('WhatsApp baglandi, userId:', userId);
    }

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      await Session.findOneAndUpdate({ userId }, { status: 'disconnected' });
      global.io.to(userId.toString()).emit('disconnected', {});
      delete global.activeSockets[userId];
      console.log('Baglanti kapandi, kod:', code);
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => startSocket(userId, 'qr'), 5000);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
  return sock;
}

router.post('/connect/qr', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Eski socket kapat
    if (global.activeSockets[userId]) {
      try { global.activeSockets[userId].sock?.end(); } catch(e) {}
      delete global.activeSockets[userId];
    }

    // Eski session dosyalarını temizle (QR üretilmesi için şart)
    const authFolder = path.join('/tmp/sessions', userId.toString());
    if (fs.existsSync(authFolder)) {
      fs.rmSync(authFolder, { recursive: true });
      console.log('Eski session temizlendi:', userId);
    }

    await startSocket(userId, 'qr');
    res.json({ message: 'QR olusturuluyor...' });
  } catch (e) {
    console.error('connect/qr hatasi:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/connect/phone', auth, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Telefon numarasi zorunlu' });

    const userId = req.user.id;

    if (global.activeSockets[userId]) {
      try { global.activeSockets[userId].sock?.end(); } catch(e) {}
      delete global.activeSockets[userId];
    }

    const authFolder = path.join('/tmp/sessions', userId.toString());
    if (fs.existsSync(authFolder)) {
      fs.rmSync(authFolder, { recursive: true });
    }

    await startSocket(userId, 'phone', phone);
    res.json({ message: 'Eslestirme kodu gonderiliyor...' });
  } catch (e) {
    console.error('connect/phone hatasi:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/status', auth, async (req, res) => {
  try {
    const session = await Session.findOne({ userId: req.user.id });
    const live = !!global.activeSockets[req.user.id];
    res.json({ session, live });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/disconnect', auth, async (req, res) => {
  try {
    const active = global.activeSockets[req.user.id];
    if (active?.sock) {
      try { await active.sock.logout(); } catch(e) {}
      delete global.activeSockets[req.user.id];
    }
    await Session.findOneAndUpdate(
      { userId: req.user.id },
      { status: 'disconnected' }
    );
    res.json({ message: 'Baglanti kesildi' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/groups', auth, async (req, res) => {
  try {
    const active = global.activeSockets[req.user.id];
    if (!active?.sock) return res.status(400).json({ error: 'WhatsApp bagli degil' });
    const chats = await active.sock.groupFetchAllParticipating();
    const groups = Object.values(chats).map(g => ({
      id: g.id,
      name: g.subject,
      members: g.participants?.length || 0,
      desc: g.desc || ''
    }));
    res.json({ groups });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, startSocket };