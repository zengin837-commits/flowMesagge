require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mongoose   = require('mongoose');
const cors       = require('cors');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

global.io            = io;
global.activeSockets = {};

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const { router: waRouter } = require('./routes/whatsapp');

app.use('/api/auth',     require('./routes/auth'));
app.use('/api/whatsapp', waRouter);
app.use('/api/messages', require('./routes/messages'));

app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

io.on('connection', socket => {
  console.log('Yeni socket baglantisi:', socket.id);

  socket.on('join', token => {
    try {
      const jwt  = require('jsonwebtoken');
      const user = jwt.verify(token, process.env.JWT_SECRET);
      socket.join(user.id.toString());
      console.log('Kullanici odaya katildi:', user.id.toString());
      socket.emit('joined', { userId: user.id });

      // Bekleyen QR varsa hemen gönder
      const active = global.activeSockets[user.id];
      if (active?.lastQR) {
        socket.emit('qr', { qr: active.lastQR });
      }
    } catch(e) {
      console.log('Join hatasi:', e.message);
    }
  });
});

const MONGO_URI = process.env.MONGO_URI
              || process.env.MONGO_URL
              || process.env.MONGODB_URL
              || process.env.MONGODB_URI
              || process.env.DATABASE_URL;

mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB baglandi'))
  .catch(err => console.error('MongoDB hatasi:', err.message));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Sunucu ' + PORT + ' portunda calisiyor'));