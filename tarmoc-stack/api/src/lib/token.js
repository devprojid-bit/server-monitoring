const crypto = require('crypto');

function generateToken() {
  return 'tmk_live_' + crypto.randomBytes(24).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { generateToken, hashToken };
