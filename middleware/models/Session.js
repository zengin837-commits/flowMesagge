const mongoose = require('mongoose');

const SessionSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  phone:      { type: String, default: null },
  status:     { type: String, enum: ['pending','qr_ready','connected','disconnected'], default: 'pending' },
  authFolder: { type: String },
  createdAt:  { type: Date, default: Date.now }
});

module.exports = mongoose.model('Session', SessionSchema);
