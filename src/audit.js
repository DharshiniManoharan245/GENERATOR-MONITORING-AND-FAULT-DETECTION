'use strict';
const { AuditLog } = require('./models');

/** Write one audit record. Throws on failure so callers (e.g. history clearing) can abort. */
async function audit(user, action, details = {}) {
  const username = typeof user === 'string' ? user : (user && user.username) || 'system';
  return AuditLog.create({ username, action, details });
}

module.exports = { audit };
