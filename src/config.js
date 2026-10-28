'use strict';
require('dotenv').config();
const crypto = require('crypto');

const prod = process.env.NODE_ENV === 'production';
let secret = process.env.JWT_SECRET;
if (!secret) {
  if (prod) throw new Error('JWT_SECRET must be set when NODE_ENV=production');
  secret = crypto.randomBytes(32).toString('hex');
  console.warn('[config] JWT_SECRET not set - using a random secret for this run (logins reset on restart).');
}

module.exports = {
  port: Number(process.env.PORT) || 3000,
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/generator_monitor',
  jwtSecret: secret,
  prod,
  cookieName: 'gm_token',
};
