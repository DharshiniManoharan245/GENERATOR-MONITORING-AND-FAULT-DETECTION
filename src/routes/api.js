'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { User, Reading, Alert, AuditLog } = require('../models');
const A = require('../auth');
const { audit } = require('../audit');
const F = require('../faults');
const settings = require('../settings');

const ack = (text) => String(text == null ? '' : text).trim();
const isId = (s) => /^[a-f0-9]{24}$/i.test(String(s));
const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`; // spreadsheet formula-injection guard
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (cols, rows) => [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');

function dateRange(q) {
  const out = {};
  for (const k of ['from', 'to']) {
    if (q[k] === undefined || q[k] === '') continue;
    const d = new Date(q[k]);
    if (Number.isNaN(d.getTime())) return { error: `Invalid "${k}" date` };
    out[k] = d;
  }
  if (out.from && out.to && out.from > out.to) return { error: '"from" must be before "to"' };
  return out;
}
const tsFilter = (field, r) => (r.from || r.to ? { [field]: { ...(r.from && { $gte: r.from }), ...(r.to && { $lte: r.to }) } } : {});

module.exports = function buildApi(sim, alertManager) {
  const r = express.Router();

  // ---------- Authentication ----------
  r.post('/auth/signup', A.throttle, async (req, res, next) => {
    try {
      const username = ack(req.body.username);
      const password = String(req.body.password || '');
      if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-30 characters: letters, numbers, . _ -' });
      if (password.length < 8 || password.length > 72) return res.status(400).json({ error: 'Password must be 8-72 characters' });
      if (await User.findOne({ usernameLower: username.toLowerCase() })) return res.status(409).json({ error: 'That username is already taken' });
      const first = (await User.countDocuments()) === 0; // first account bootstraps the system as admin
      const user = await User.create({
        username, usernameLower: username.toLowerCase(), passwordHash: await bcrypt.hash(password, 10), role: first ? 'admin' : 'operator',
      });
      await audit(user.username, 'user_signup', { role: user.role });
      A.setCookie(res, A.sign(user));
      res.status(201).json({ username: user.username, role: user.role });
    } catch (e) { if (e.code === 11000) return res.status(409).json({ error: 'That username is already taken' }); next(e); }
  });

  r.post('/auth/login', A.throttle, async (req, res, next) => {
    try {
      const username = ack(req.body.username).toLowerCase();
      const user = await User.findOne({ usernameLower: username });
      const ok = user && (await bcrypt.compare(String(req.body.password || ''), user.passwordHash));
      if (!ok) { A.failAttempt(req); return res.status(401).json({ error: 'Invalid username or password' }); }
      A.clearAttempts(req);
      A.setCookie(res, A.sign(user));
      res.json({ username: user.username, role: user.role });
    } catch (e) { next(e); }
  });

  r.post('/auth/logout', (req, res) => { res.clearCookie(config.cookieName); res.json({ ok: true }); });

  // Everything below needs a signed-in user.
  r.use(A.requireAuth);
  const operatorOrAdmin = A.requireRole('operator', 'admin');
  const adminOnly = A.requireRole('admin');

  r.get('/auth/me', (req, res) => res.json({ username: req.user.username, role: req.user.role }));

  // ---------- Generator control & live data ----------
  r.get('/generator/status', async (req, res, next) => {
    try {
      const open = await Alert.find({ status: 'active' }).sort({ startedAt: -1 }).lean();
      res.json({ ...sim.snapshot(), activeAlerts: open, settings: settings.getSettings(), rated: F.RATED, params: F.PARAMS });
    } catch (e) { next(e); }
  });

  r.post('/generator/start', operatorOrAdmin, async (req, res, next) => {
    try {
      if (!sim.start()) return res.status(409).json({ error: 'Generator is already running' });
      await audit(req.user, 'generator_start');
      res.json(sim.snapshot());
    } catch (e) { next(e); }
  });

  r.post('/generator/stop', operatorOrAdmin, async (req, res, next) => {
    try {
      if (!sim.stop()) return res.status(409).json({ error: 'Generator is not running' });
      await audit(req.user, 'generator_stop');
      res.json(sim.snapshot());
    } catch (e) { next(e); }
  });

  r.post('/generator/fault', operatorOrAdmin, async (req, res, next) => {
    try {
      const { fault, active } = req.body || {};
      if (typeof fault !== 'string' || !(fault in F.SIM_FAULTS) || typeof active !== 'boolean') return res.status(400).json({ error: 'Invalid fault or state' });
      if (!sim.s.running) return res.status(409).json({ error: 'Start the generator before injecting a fault' });
      sim.setFault(fault, active);
      await audit(req.user, active ? 'sim_fault_on' : 'sim_fault_off', { fault });
      res.json(sim.snapshot());
    } catch (e) { next(e); }
  });

  r.post('/generator/clear-faults', operatorOrAdmin, async (req, res, next) => {
    try { sim.clearFaults(); await audit(req.user, 'sim_faults_cleared'); res.json(sim.snapshot()); } catch (e) { next(e); }
  });

  // ---------- Alerts ----------
  r.get('/alerts', async (req, res, next) => {
    try {
      const range = dateRange(req.query);
      if (range.error) return res.status(400).json({ error: range.error });
      const q = { ...tsFilter('startedAt', range) };
      if (['active', 'cleared', 'resolved'].includes(req.query.status)) q.status = req.query.status;
      if (['WARNING', 'CRITICAL'].includes(req.query.severity)) q.severity = req.query.severity;
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      res.json(await Alert.find(q).sort({ startedAt: -1 }).limit(limit).lean());
    } catch (e) { next(e); }
  });

  r.get('/alerts/:id', async (req, res, next) => {
    try {
      if (!isId(req.params.id)) return res.status(400).json({ error: 'Invalid alert id' });
      const a = await Alert.findById(req.params.id).lean(); // read-only: opening never acknowledges
      if (!a) return res.status(404).json({ error: 'Alert not found' });
      res.json({ ...a, checklist: (F.FAULT_MAP[a.faultKey] || {}).checklist || [] });
    } catch (e) { next(e); }
  });

  r.post('/alerts/:id/ack', operatorOrAdmin, async (req, res, next) => {
    try {
      if (!isId(req.params.id)) return res.status(400).json({ error: 'Invalid alert id' });
      const note = ack(req.body.note);
      if (!note) return res.status(400).json({ error: 'A note is required to acknowledge an alert' });
      if (note.length > 300) return res.status(400).json({ error: 'Note must be 300 characters or fewer' });
      // Atomic: only acknowledges if not already acknowledged, so existing details are preserved.
      const doc = await Alert.findOneAndUpdate(
        { _id: req.params.id, ack: { $exists: false }, status: { $in: ['active', 'cleared'] } },
        { $set: { ack: { by: req.user.username, note, at: new Date() } } }, { new: true },
      ).lean();
      if (!doc) {
        const ex = await Alert.findById(req.params.id).lean();
        if (!ex) return res.status(404).json({ error: 'Alert not found' });
        return res.status(409).json({ error: ex.ack ? 'Alert was already acknowledged' : 'Alert is already resolved' });
      }
      await audit(req.user, 'alert_ack', { alertId: doc._id, fault: doc.name, note });
      res.json(doc); // fault status is untouched - acknowledging never clears a fault
    } catch (e) { next(e); }
  });

  r.post('/alerts/:id/resolve', operatorOrAdmin, async (req, res, next) => {
    try {
      if (!isId(req.params.id)) return res.status(400).json({ error: 'Invalid alert id' });
      const note = ack(req.body.note);
      const checklist = Array.isArray(req.body.checklist) ? req.body.checklist.map(String) : [];
      const a = await Alert.findById(req.params.id);
      if (!a) return res.status(404).json({ error: 'Alert not found' });
      if (a.status === 'resolved') return res.status(409).json({ error: 'Alert is already verified resolved' });
      if (!a.ack) return res.status(409).json({ error: 'Acknowledge the alert (with a note) before requesting resolution' });
      if (!note) return res.status(400).json({ error: 'A resolution note is required' });
      if (note.length > 500) return res.status(400).json({ error: 'Note must be 500 characters or fewer' });
      const fault = F.FAULT_MAP[a.faultKey];
      const allowed = fault ? fault.checklist : [];
      if (!checklist.length || !checklist.every((c) => allowed.includes(c))) return res.status(400).json({ error: 'Complete at least one valid corrective-action checklist item' });

      // ----- backend verification against live simulated readings and configured limits -----
      let reason = null;
      const value = sim.values[a.param];
      const thr = settings.getThresholds()[a.faultKey];
      if (sim.state() !== 'RUNNING') reason = 'The generator is not running at steady state, so readings cannot be verified. Start the generator and let it stabilise.';
      else if (a.status === 'active' || alertManager.open.has(a.faultKey)) reason = `The fault is still active. ${a.paramLabel} is ${Number(value).toFixed(F.PARAMS[a.param].decimals)} ${a.unit}.`;
      else if (sim.levels[a.faultKey] !== 0 || !F.withinSafeLimit(fault, value, thr)) reason = `${a.paramLabel} is ${Number(value).toFixed(F.PARAMS[a.param].decimals)} ${a.unit}, which is not yet within the configured safe limit (${fault.dir === 'high' ? 'below' : 'above'} ${thr.warn} ${a.unit}).`;

      const entry = { by: req.user.username, note, at: new Date(), outcome: reason ? 'rejected' : 'verified', reason: reason || undefined };
      if (reason) {
        a.resolutionRequests.push(entry);
        await a.save();
        await audit(req.user, 'alert_resolve_rejected', { alertId: a._id, fault: a.name, reason });
        return res.status(422).json({ error: `Cannot be verified resolved: ${reason}`, alert: a });
      }
      a.resolutionRequests.push(entry);
      a.resolution = { by: req.user.username, note, at: new Date(), checklist, verifiedValue: value, verified: true };
      a.status = 'resolved';
      await a.save();
      await audit(req.user, 'alert_resolve', { alertId: a._id, fault: a.name, note, checklist, verifiedValue: value });
      res.json(a);
    } catch (e) { next(e); }
  });

  // ---------- History, reports, CSV ----------
  r.get('/history/readings', async (req, res, next) => {
    try {
      const range = dateRange(req.query);
      if (range.error) return res.status(400).json({ error: range.error });
      let rows = await Reading.find(tsFilter('ts', range)).sort({ ts: -1 }).limit(20000).lean();
      rows.reverse();
      const max = Math.min(Number(req.query.points) || 400, 2000);
      if (rows.length > max) { const step = Math.ceil(rows.length / max); rows = rows.filter((_, i) => i % step === 0); }
      res.json(rows);
    } catch (e) { next(e); }
  });

  async function summary(range) {
    const match = tsFilter('ts', range);
    const [agg] = await Reading.aggregate([
      { $match: { ...match, state: { $in: ['RUNNING', 'STARTING', 'STOPPING'] } } },
      { $group: { _id: null, maxWindingTemp: { $max: '$windingTemp' }, maxBearingTemp: { $max: '$bearingTemp' }, maxCurrent: { $max: '$current' }, avgLoad: { $avg: '$load' }, samples: { $sum: 1 } } },
    ]);
    const aMatch = tsFilter('startedAt', range);
    const [warnings, criticals] = await Promise.all([
      Alert.countDocuments({ ...aMatch, severity: 'WARNING' }), Alert.countDocuments({ ...aMatch, severity: 'CRITICAL' }),
    ]);
    const d = agg || {};
    return {
      samples: d.samples || 0, maxWindingTemp: d.maxWindingTemp ?? null, maxBearingTemp: d.maxBearingTemp ?? null,
      maxCurrent: d.maxCurrent ?? null, avgLoad: d.avgLoad ?? null, warningCount: warnings, criticalCount: criticals,
    };
  }

  r.get('/history/summary', async (req, res, next) => {
    try {
      const range = dateRange(req.query);
      if (range.error) return res.status(400).json({ error: range.error });
      res.json(await summary(range));
    } catch (e) { next(e); }
  });

  r.get('/history/export/:kind', async (req, res, next) => {
    try {
      const range = dateRange(req.query);
      if (range.error) return res.status(400).json({ error: range.error });
      let csv;
      if (req.params.kind === 'readings') {
        const rows = await Reading.find(tsFilter('ts', range)).sort({ ts: 1 }).limit(100000).lean();
        rows.forEach((x) => { x.faults = (x.faults || []).join(' | '); });
        csv = toCsv(['ts', 'state', 'voltage', 'current', 'frequency', 'power', 'powerFactor', 'load', 'rpm', 'vibration', 'windingTemp', 'bearingTemp', 'fuelEfficiency', 'healthScore', 'faults'], rows);
      } else if (req.params.kind === 'alerts') {
        const rows = await Alert.find(tsFilter('startedAt', range)).sort({ startedAt: 1 }).limit(100000).lean();
        const flat = rows.map((a) => ({
          startedAt: a.startedAt, name: a.name, severity: a.severity, param: a.paramLabel, value: a.value, threshold: a.threshold, status: a.status,
          clearedAt: a.clearedAt, ackBy: a.ack && a.ack.by, ackAt: a.ack && a.ack.at, ackNote: a.ack && a.ack.note,
          resolvedBy: a.resolution && a.resolution.by, resolvedAt: a.resolution && a.resolution.at, resolutionNote: a.resolution && a.resolution.note,
        }));
        csv = toCsv(['startedAt', 'name', 'severity', 'param', 'value', 'threshold', 'status', 'clearedAt', 'ackBy', 'ackAt', 'ackNote', 'resolvedBy', 'resolvedAt', 'resolutionNote'], flat);
      } else return res.status(404).json({ error: 'Unknown export' });
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${req.params.kind}.csv"` }).send(csv);
    } catch (e) { next(e); }
  });

  r.get('/report', async (req, res, next) => {
    try {
      const range = dateRange(req.query);
      if (range.error) return res.status(400).json({ error: range.error });
      const [sum, alerts, latest] = await Promise.all([
        summary(range), Alert.find(tsFilter('startedAt', range)).sort({ startedAt: 1 }).limit(500).lean(),
        Reading.findOne(tsFilter('ts', range)).sort({ ts: -1 }).lean(),
      ]);
      res.json({
        generated: new Date().toISOString(), generatedBy: req.user.username, range,
        generator: { name: 'Virtual Generator VG-10', rated: F.RATED, note: 'Software simulation' },
        summary: sum, latestReading: latest, alerts, thresholds: settings.getThresholds(), faults: F.FAULTS.map((f) => ({ key: f.key, name: f.name, param: f.param })),
      });
    } catch (e) { next(e); }
  });

  // ---------- Knowledge base & thresholds ----------
  r.get('/faults', (req, res) => {
    const thr = settings.getThresholds();
    res.json(F.FAULTS.map((f) => ({
      key: f.key, name: f.name, category: f.category, severity: f.severity, param: f.param, paramLabel: F.PARAMS[f.param].label, unit: F.PARAMS[f.param].unit,
      direction: f.dir, causes: f.causes, effects: f.effects, action: f.action, risk: f.risk, checklist: f.checklist, threshold: thr[f.key],
    })));
  });

  r.get('/thresholds', (req, res) => res.json({ thresholds: settings.getThresholds(), defaults: F.defaultThresholds(), faults: F.FAULTS.map((f) => ({ key: f.key, name: f.name, unit: F.PARAMS[f.param].unit, dir: f.dir, bounds: f.bounds })) }));

  r.put('/thresholds', adminOnly, async (req, res, next) => {
    try {
      const v = F.validateThresholds(req.body && req.body.thresholds);
      if (!v.ok) return res.status(400).json({ error: 'Invalid thresholds', details: v.errors });
      const before = settings.getThresholds();
      const changes = {};
      for (const k of Object.keys(v.clean)) if (before[k].warn !== v.clean[k].warn || before[k].crit !== v.clean[k].crit) changes[k] = { from: before[k], to: v.clean[k] };
      await audit(req.user, 'threshold_change', { changes });
      await settings.setThresholds(v.clean);
      res.json({ thresholds: settings.getThresholds(), changed: Object.keys(changes).length });
    } catch (e) { next(e); }
  });

  r.put('/settings', adminOnly, async (req, res, next) => {
    try {
      const { voiceEnabled, announceWarnings } = req.body || {};
      if (typeof voiceEnabled !== 'boolean' || typeof announceWarnings !== 'boolean') return res.status(400).json({ error: 'Invalid settings' });
      await audit(req.user, 'settings_change', { voiceEnabled, announceWarnings });
      await settings.setSettings({ voiceEnabled, announceWarnings });
      res.json(settings.getSettings());
    } catch (e) { next(e); }
  });

  // ---------- Audit log (admin) ----------
  r.get('/audit', adminOnly, async (req, res, next) => {
    try {
      const range = dateRange(req.query);
      if (range.error) return res.status(400).json({ error: range.error });
      const q = { ...tsFilter('ts', range) };
      if (req.query.action) q.action = String(req.query.action);
      res.json(await AuditLog.find(q).sort({ ts: -1 }).limit(Math.min(Number(req.query.limit) || 200, 1000)).lean());
    } catch (e) { next(e); }
  });

  // ---------- User management (admin) ----------
  r.get('/users', adminOnly, async (req, res, next) => {
    try { res.json(await User.find().select('username role createdAt').sort({ createdAt: 1 }).lean()); } catch (e) { next(e); }
  });

  r.patch('/users/:id/role', adminOnly, async (req, res, next) => {
    try {
      const role = req.body && req.body.role;
      if (!isId(req.params.id) || !['admin', 'operator'].includes(role)) return res.status(400).json({ error: 'Invalid user or role' });
      const target = await User.findById(req.params.id);
      if (!target) return res.status(404).json({ error: 'User not found' });
      if (target.role === role) return res.status(409).json({ error: `User is already ${role}` });
      if (target.role === 'admin' && role !== 'admin' && (await User.countDocuments({ role: 'admin' })) <= 1) return res.status(409).json({ error: 'Cannot demote the last administrator' });
      const from = target.role;
      await audit(req.user, 'role_change', { target: target.username, from, to: role });
      target.role = role; await target.save();
      res.json({ id: target._id, username: target.username, role: target.role });
    } catch (e) { next(e); }
  });

  r.delete('/users/:id', adminOnly, async (req, res, next) => {
    try {
      if (!isId(req.params.id)) return res.status(400).json({ error: 'Invalid user' });
      if (req.body && req.body.confirm !== true) return res.status(400).json({ error: 'Confirmation required' });
      if (String(req.user._id) === req.params.id) return res.status(409).json({ error: 'You cannot remove your own account' });
      const target = await User.findById(req.params.id);
      if (!target) return res.status(404).json({ error: 'User not found' });
      if (target.role === 'admin' && (await User.countDocuments({ role: 'admin' })) <= 1) return res.status(409).json({ error: 'Cannot remove the last administrator' });
      await audit(req.user, 'user_remove', { target: target.username, role: target.role });
      await target.deleteOne();
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // ---------- Clear operational history (admin) ----------
  r.post('/history/clear', adminOnly, async (req, res, next) => {
    try {
      const { mode, before, confirm } = req.body || {};
      if (confirm !== true) return res.status(400).json({ error: 'Confirmation required' });
      let rq = {}, aq = {};
      if (mode === 'before') {
        const d = new Date(before);
        if (!before || Number.isNaN(d.getTime())) return res.status(400).json({ error: 'A valid date is required' });
        rq = { ts: { $lt: d } }; aq = { startedAt: { $lt: d } };
      } else if (mode !== 'all') return res.status(400).json({ error: 'Mode must be "all" or "before"' });
      // never remove alerts that are still active: that would orphan the live fault state
      aq = { ...aq, status: { $ne: 'active' } };
      const counts = { readings: await Reading.countDocuments(rq), alerts: await Alert.countDocuments(aq) };
      await audit(req.user, 'history_clear', { mode, before: before || null, ...counts }); // audit FIRST - abort if it fails
      await Reading.deleteMany(rq);
      await Alert.deleteMany(aq);
      res.json({ deleted: counts });
    } catch (e) { next(e); }
  });

  return r;
};
