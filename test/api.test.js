'use strict';
// Run: npm test   (uses an in-memory MongoDB; no setup needed)
process.env.JWT_SECRET = 'test-secret';
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod, server, base, sim, alertManager, models;

async function call(method, path, { body, cookie } = {}) {
  const res = await fetch(base + path, {
    method, redirect: 'manual',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* csv/html */ }
  return { status: res.status, json, text, headers: res.headers, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const ticks = async (n) => { for (let i = 0; i < n; i++) sim.tick(); await alertManager.idle(); };

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const { createApp } = require('../server');
  const made = await createApp({ autoStartLoop: false });
  sim = made.sim; alertManager = made.alertManager; sim.noiseScale = 0;
  models = require('../src/models');
  await new Promise((r) => { server = made.app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await mongoose.disconnect(); await mongod.stop(); });

let admin, op, alertId;

test('authentication: signup, hashing, login, protection', async () => {
  assert.equal((await call('GET', '/api/generator/status')).status, 401);
  assert.equal((await call('GET', '/', {})).status, 302); // page redirects to /login
  assert.equal((await call('POST', '/api/auth/signup', { body: { username: 'a', password: 'short' } })).status, 400);
  const a = await call('POST', '/api/auth/signup', { body: { username: 'alice', password: 'password123' } });
  assert.equal(a.status, 201); assert.equal(a.json.role, 'admin'); admin = a.cookie;
  const o = await call('POST', '/api/auth/signup', { body: { username: 'bob', password: 'password123' } });
  assert.equal(o.json.role, 'operator'); op = o.cookie;
  assert.equal((await call('POST', '/api/auth/signup', { body: { username: 'ALICE', password: 'password123' } })).status, 409);
  const doc = await models.User.findOne({ usernameLower: 'alice' }).lean();
  assert.match(doc.passwordHash, /^\$2[aby]\$/); assert.ok(!doc.passwordHash.includes('password123'));
  assert.equal((await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'wrongpass1' } })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'password123' } })).status, 200);
  const users = await call('GET', '/api/users', { cookie: admin });
  assert.ok(users.json.every((u) => !('passwordHash' in u)));
  assert.equal((await call('GET', '/', { cookie: op })).status, 200);
});

test('simulation: ramps up, stays consistent, one loop only', async () => {
  assert.equal(sim.state(), 'STOPPED');
  assert.equal((await call('POST', '/api/generator/fault', { cookie: op, body: { fault: 'overvoltage', active: true } })).status, 409);
  assert.equal((await call('POST', '/api/generator/start', { cookie: op })).status, 200);
  assert.equal((await call('POST', '/api/generator/start', { cookie: op })).status, 409);
  await ticks(3);
  assert.ok(sim.values.rpm > 0 && sim.values.rpm < 1500, 'gradual ramp');
  await ticks(40);
  const v = sim.values;
  assert.equal(sim.state(), 'RUNNING');
  assert.ok(Math.abs(v.voltage - 400) < 1 && Math.abs(v.rpm - 1500) < 1 && Math.abs(v.frequency - 50) < 0.1);
  const kw = Math.sqrt(3) * v.voltage * v.current * v.powerFactor / 1000;
  assert.ok(Math.abs(kw - v.power) < 0.01, 'P = sqrt(3)·V·I·PF');
  assert.ok(Math.abs(v.load - (v.current / 14.43) * 100) < 0.1, 'load = I / I_rated');
  assert.equal(sim.health.label, 'Healthy');
  assert.ok(v.fuelEfficiency !== null);
  assert.equal((await models.Alert.countDocuments()), 0);
  assert.equal(sim.timer, null); // test drives ticks manually; startLoop() is idempotent
  sim.startLoop(); const t1 = sim.timer; sim.startLoop(); assert.equal(sim.timer, t1); sim.stopLoop();
});

test('fault detection: overvoltage -> one critical alert, no duplicates', async () => {
  assert.equal((await call('POST', '/api/generator/fault', { cookie: op, body: { fault: 'overvoltage', active: true } })).status, 200);
  await ticks(25);
  assert.equal(sim.statuses.voltage, 'CRITICAL');
  const st = (await call('GET', '/api/generator/status', { cookie: op })).json;
  const crit = st.activeAlerts.filter((a) => a.faultKey === 'overvoltage');
  assert.equal(crit.length, 1); assert.equal(crit[0].severity, 'CRITICAL');
  for (const k of ['name', 'param', 'value', 'threshold', 'reason', 'risk', 'action', 'startedAt']) assert.ok(crit[0][k] !== undefined, k);
  alertId = crit[0]._id;
  await ticks(10);
  assert.equal(await models.Alert.countDocuments({ faultKey: 'overvoltage', status: 'active' }), 1);
  assert.ok((await models.Alert.countDocuments({ faultKey: 'overvoltage' })) <= 2); // optional warning that escalated + the critical
});

test('acknowledgement needs a note, keeps fault visible, preserves details', async () => {
  assert.equal((await call('GET', `/api/alerts/${alertId}`, { cookie: op })).json.ack, undefined); // opening does not acknowledge
  assert.equal((await call('POST', `/api/alerts/${alertId}/ack`, { cookie: op, body: { note: '  ' } })).status, 400);
  const ok = await call('POST', `/api/alerts/${alertId}/ack`, { cookie: op, body: { note: 'Checked cooling fan' } });
  assert.equal(ok.status, 200); assert.equal(ok.json.ack.by, 'bob'); assert.equal(ok.json.status, 'active');
  assert.equal((await call('POST', `/api/alerts/${alertId}/ack`, { cookie: admin, body: { note: 'overwrite attempt' } })).status, 409);
  assert.equal((await models.Alert.findById(alertId).lean()).ack.note, 'Checked cooling fan');
  assert.equal(sim.statuses.voltage, 'CRITICAL'); // still critical after ack
});

test('resolution: rejected while fault persists, verified once readings are safe', async () => {
  const body = { note: 'Reset AVR', checklist: ['Checked AVR / excitation settings'] };
  const bad = await call('POST', `/api/alerts/${alertId}/resolve`, { cookie: op, body });
  assert.equal(bad.status, 422); assert.match(bad.json.error, /still active/);
  assert.equal((await call('POST', `/api/alerts/${alertId}/resolve`, { cookie: op, body: { note: 'x', checklist: ['bogus'] } })).status, 400);
  await call('POST', '/api/generator/clear-faults', { cookie: op });
  await ticks(40);
  assert.equal(sim.statuses.voltage, 'SAFE');
  const good = await call('POST', `/api/alerts/${alertId}/resolve`, { cookie: op, body });
  assert.equal(good.status, 200); assert.equal(good.json.status, 'resolved'); assert.equal(good.json.resolution.verified, true);
  assert.equal(good.json.ack.note, 'Checked cooling fan'); // ack preserved
});

test('a new critical condition raises a new alert after an earlier one was acknowledged/resolved', async () => {
  await call('POST', '/api/generator/fault', { cookie: op, body: { fault: 'overvoltage', active: true } });
  await ticks(25);
  assert.equal(await models.Alert.countDocuments({ faultKey: 'overvoltage', severity: 'CRITICAL' }), 2);
  await call('POST', '/api/generator/clear-faults', { cookie: op }); await ticks(40);
});

test('all simulated faults change the shared readings and statuses', async () => {
  const cases = { overcurrent: ['current', 'high'], overheating: ['windingTemp', 'high'], highVibration: ['vibration', 'high'], overspeed: ['rpm', 'high'], underspeed: ['rpm', 'low'], undervoltage: ['voltage', 'low'] };
  for (const [fault, [param]] of Object.entries(cases)) {
    await call('POST', '/api/generator/fault', { cookie: op, body: { fault, active: true } });
    await ticks(fault === 'overheating' ? 120 : 30);
    assert.ok(['WARNING', 'CRITICAL'].includes(sim.statuses[param]), `${fault} -> ${param} is ${sim.statuses[param]}`);
    await call('POST', '/api/generator/clear-faults', { cookie: op });
    await ticks(fault === 'overheating' ? 250 : 40);
    assert.equal(sim.statuses[param], 'SAFE', `${fault} cleared`);
  }
});

test('thresholds: validated, admin-only, applied to detection, audited', async () => {
  assert.equal((await call('PUT', '/api/thresholds', { cookie: op, body: { thresholds: {} } })).status, 403);
  const cur = (await call('GET', '/api/thresholds', { cookie: admin })).json.thresholds;
  const bad = JSON.parse(JSON.stringify(cur)); bad.overvoltage = { warn: 470, crit: 450 };
  assert.equal((await call('PUT', '/api/thresholds', { cookie: admin, body: { thresholds: bad } })).status, 400);
  const nanBad = JSON.parse(JSON.stringify(cur)); nanBad.overvoltage = { warn: 'abc', crit: 460 };
  assert.equal((await call('PUT', '/api/thresholds', { cookie: admin, body: { thresholds: nanBad } })).status, 400);
  const good = JSON.parse(JSON.stringify(cur)); good.overvoltage = { warn: 402, crit: 405 };
  assert.equal((await call('PUT', '/api/thresholds', { cookie: admin, body: { thresholds: good } })).status, 200);
  await ticks(25); // normal 400 V with noise off is below 402 -> still safe; set voltage fault to confirm new limit is used
  await call('POST', '/api/generator/fault', { cookie: op, body: { fault: 'overvoltage', active: true } }); await ticks(10);
  assert.ok(sim.levels.overvoltage >= 1);
  await call('POST', '/api/generator/clear-faults', { cookie: op });
  assert.equal((await call('PUT', '/api/thresholds', { cookie: admin, body: { thresholds: cur } })).status, 200); await ticks(40);
  assert.ok((await models.AuditLog.countDocuments({ action: 'threshold_change' })) >= 2);
});

test('history, summary, filters and CSV export', async () => {
  const day = (d) => new Date(Date.now() + d * 864e5).toISOString();
  const s = (await call('GET', '/api/history/summary', { cookie: op })).json;
  assert.ok(s.samples > 0 && s.maxCurrent > 0 && s.avgLoad > 0 && s.criticalCount >= 2);
  const none = (await call('GET', `/api/history/summary?from=${day(1)}`, { cookie: op })).json;
  assert.equal(none.samples, 0);
  assert.equal((await call('GET', '/api/history/summary?from=garbage', { cookie: op })).status, 400);
  assert.ok((await call('GET', '/api/history/readings', { cookie: op })).json.length > 0);
  const csv = await call('GET', '/api/history/export/readings', { cookie: op });
  assert.match(csv.headers.get('content-type'), /text\/csv/); assert.match(csv.text.split('\r\n')[0], /^ts,state,voltage/);
  const acsv = await call('GET', '/api/history/export/alerts', { cookie: op });
  assert.match(acsv.text, /Checked cooling fan/);
  assert.equal((await call('GET', '/api/report', { cookie: op })).status, 200);
});

test('knowledge base lists every fault with configured thresholds', async () => {
  const kb = (await call('GET', '/api/faults', { cookie: op })).json;
  assert.ok(kb.length >= 10);
  for (const f of kb) for (const k of ['name', 'category', 'causes', 'effects', 'severity', 'action', 'paramLabel', 'threshold']) assert.ok(f[k], `${f.key}.${k}`);
});

test('admin-only endpoints reject operators; audit is admin-only', async () => {
  for (const [m, p, b] of [['GET', '/api/audit'], ['GET', '/api/users'], ['POST', '/api/history/clear', { mode: 'all', confirm: true }], ['PUT', '/api/settings', { voiceEnabled: true, announceWarnings: false }]]) {
    assert.equal((await call(m, p, { cookie: op, body: b })).status, 403, `${m} ${p}`);
  }
  assert.equal((await call('GET', '/thresholds', { cookie: op })).status, 302); // admin page redirects operators
  const audit = (await call('GET', '/api/audit', { cookie: admin })).json;
  const actions = new Set(audit.map((a) => a.action));
  for (const a of ['generator_start', 'alert_ack', 'alert_resolve', 'alert_resolve_rejected', 'threshold_change']) assert.ok(actions.has(a), a);
});

test('user management: roles, last admin, self removal, confirmation', async () => {
  const users = (await call('GET', '/api/users', { cookie: admin })).json;
  const alice = users.find((u) => u.username === 'alice'), bob = users.find((u) => u.username === 'bob');
  assert.equal((await call('PATCH', `/api/users/${alice._id}/role`, { cookie: admin, body: { role: 'operator' } })).status, 409); // last admin
  assert.equal((await call('DELETE', `/api/users/${alice._id}`, { cookie: admin, body: { confirm: true } })).status, 409); // self / last admin
  assert.equal((await call('DELETE', `/api/users/${bob._id}`, { cookie: admin, body: {} })).status, 400); // needs confirmation
  assert.equal((await call('PATCH', `/api/users/${bob._id}/role`, { cookie: admin, body: { role: 'admin' } })).status, 200);
  assert.equal((await call('PATCH', `/api/users/${bob._id}/role`, { cookie: admin, body: { role: 'operator' } })).status, 200);
  const carol = await call('POST', '/api/auth/signup', { body: { username: 'carol', password: 'password123' } });
  const cid = (await call('GET', '/api/users', { cookie: admin })).json.find((u) => u.username === 'carol')._id;
  assert.equal((await call('DELETE', `/api/users/${cid}`, { cookie: admin, body: { confirm: true } })).status, 200);
  assert.equal((await call('GET', '/api/auth/me', { cookie: carol.cookie })).status, 401); // removed user is locked out immediately
});

test('clear history: confirmation, audit first, keeps users/thresholds/audit', async () => {
  assert.equal((await call('POST', '/api/history/clear', { cookie: admin, body: { mode: 'all' } })).status, 400);
  assert.equal((await call('POST', '/api/history/clear', { cookie: admin, body: { mode: 'before', confirm: true } })).status, 400);
  const usersBefore = await models.User.countDocuments(), auditBefore = await models.AuditLog.countDocuments();
  const r = await call('POST', '/api/history/clear', { cookie: admin, body: { mode: 'all', confirm: true } });
  assert.equal(r.status, 200); assert.ok(r.json.deleted.readings > 0);
  assert.equal(await models.Reading.countDocuments(), 0);
  assert.equal(await models.User.countDocuments(), usersBefore);
  assert.ok((await models.AuditLog.countDocuments()) > auditBefore);
  assert.ok(await models.AuditLog.findOne({ action: 'history_clear' }));
  assert.ok(await models.Settings.findOne({ key: 'system' }));
});

test('stopping ramps down to zero and stop is audited', async () => {
  assert.equal((await call('POST', '/api/generator/stop', { cookie: op })).status, 200);
  await ticks(3); assert.ok(sim.values.rpm > 0 && sim.state() === 'STOPPING');
  await ticks(30);
  assert.equal(sim.state(), 'STOPPED'); assert.equal(sim.values.rpm, 0); assert.equal(sim.values.voltage, 0); assert.equal(sim.values.current, 0);
  assert.equal(sim.statuses.voltage, 'INACTIVE');
  assert.ok(await models.AuditLog.findOne({ action: 'generator_stop' }));
});
