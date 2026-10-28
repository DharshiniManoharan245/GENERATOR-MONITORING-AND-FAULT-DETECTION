'use strict';
const jwt = require('jsonwebtoken');
const config = require('./config');
const { User } = require('./models');

function sign(user) {
  return jwt.sign({ id: String(user._id) }, config.jwtSecret, { expiresIn: '8h' });
}

function setCookie(res, token) {
  res.cookie(config.cookieName, token, {
    httpOnly: true, sameSite: 'strict', secure: config.prod, maxAge: 8 * 3600 * 1000,
  });
}

/** Loads the user from the DB on every request, so role changes / removals apply immediately. */
async function loadUser(req) {
  const token = req.cookies && req.cookies[config.cookieName];
  if (!token) return null;
  try {
    const { id } = jwt.verify(token, config.jwtSecret);
    return await User.findById(id).select('-passwordHash').lean();
  } catch (e) { return null; }
}

async function requireAuth(req, res, next) {
  try {
    const user = await loadUser(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    req.user = user;
    next();
  } catch (e) { next(e); }
}

/** Page guard: redirect browsers to the login page instead of returning JSON. */
async function requirePage(req, res, next) {
  try {
    const user = await loadUser(req);
    if (!user) return res.redirect('/login');
    req.user = user;
    next();
  } catch (e) { next(e); }
}

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: 'You do not have permission to do this' });
  next();
};
const requireAdminPage = (req, res, next) => (req.user.role === 'admin' ? next() : res.redirect('/'));

// Very small in-memory login throttle (per IP + username).
const attempts = new Map();
function throttle(req, res, next) {
  const key = `${req.ip}|${String((req.body && req.body.username) || '').toLowerCase()}`;
  const now = Date.now();
  const rec = attempts.get(key) || { n: 0, t: now };
  if (now - rec.t > 10 * 60 * 1000) { rec.n = 0; rec.t = now; }
  if (rec.n >= 10) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  req._attemptKey = key; req._attemptRec = rec;
  next();
}
const failAttempt = (req) => { const r = req._attemptRec; if (r) { r.n++; attempts.set(req._attemptKey, r); } };
const clearAttempts = (req) => { if (req._attemptKey) attempts.delete(req._attemptKey); };

module.exports = { sign, setCookie, requireAuth, requirePage, requireRole, requireAdminPage, throttle, failAttempt, clearAttempts };
