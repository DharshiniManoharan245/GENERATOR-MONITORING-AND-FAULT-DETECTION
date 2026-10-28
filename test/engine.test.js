'use strict';
// No database needed. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/faults');
const { Simulator } = require('../src/simulator');

function makeSim() {
  const calls = { process: 0, closeAll: 0 };
  const alerts = { process() { calls.process++; }, closeAll() { calls.closeAll++; } };
  const settings = { getThresholds: () => F.defaultThresholds() };
  const sim = new Simulator({ alertManager: alerts, readingModel: { create: async () => {} }, settings });
  sim.noiseScale = 0;
  return { sim, calls };
}
const run = (sim, n) => { for (let i = 0; i < n; i++) sim.tick(); };

test('start ramps gradually to rated values; stop ramps gradually to zero', () => {
  const { sim } = makeSim();
  assert.equal(sim.state(), 'STOPPED'); assert.equal(sim.values.rpm, 0);
  sim.start(); run(sim, 3);
  assert.ok(sim.values.rpm > 0 && sim.values.rpm < 1500 && sim.state() === 'STARTING');
  run(sim, 40);
  assert.equal(sim.state(), 'RUNNING');
  assert.ok(Math.abs(sim.values.rpm - 1500) < 1 && Math.abs(sim.values.voltage - 400) < 1 && Math.abs(sim.values.frequency - 50) < 0.1);
  sim.stop(); run(sim, 3);
  assert.equal(sim.state(), 'STOPPING'); assert.ok(sim.values.rpm > 0);
  run(sim, 30);
  assert.equal(sim.state(), 'STOPPED');
  for (const k of ['rpm', 'voltage', 'current', 'power', 'frequency', 'load']) assert.equal(sim.values[k], 0, k);
});

test('derived values are physically consistent', () => {
  const { sim } = makeSim(); sim.start(); run(sim, 60);
  const v = sim.values;
  assert.ok(Math.abs(v.power - Math.sqrt(3) * v.voltage * v.current * v.powerFactor / 1000) < 0.01);
  assert.ok(Math.abs(v.load - v.current / F.RATED.current * 100) < 0.1);
  assert.ok(Math.abs(v.frequency - v.rpm * 4 / 120) < 0.01);
  assert.ok(v.windingTemp > F.RATED.ambient && v.bearingTemp > F.RATED.ambient);
  assert.ok(v.fuelEfficiency > 0);
});

test('fuel efficiency only when valid (running, >= 1 kW)', () => {
  const { sim } = makeSim();
  assert.equal(sim.values.fuelEfficiency, null);
  sim.start(); run(sim, 5); assert.equal(sim.values.fuelEfficiency, null); // still starting
  run(sim, 50); assert.ok(sim.values.fuelEfficiency > 0);
  sim.s.loadSetting = 2; sim.s.ld = 2; run(sim, 5); assert.equal(sim.values.fuelEfficiency, null); // ~0.1 kW: not meaningful
});

test('single simulation loop: startLoop is idempotent', () => {
  const { sim } = makeSim();
  sim.startLoop(); const t = sim.timer; sim.startLoop(); assert.equal(sim.timer, t); sim.stopLoop(); assert.equal(sim.timer, null);
});

test('every fault control drives the shared readings, statuses and health, and clears afterwards', () => {
  const cases = { overvoltage: 'voltage', undervoltage: 'voltage', overcurrent: 'current', overheating: 'windingTemp', highVibration: 'vibration', overspeed: 'rpm', underspeed: 'rpm' };
  for (const [fault, param] of Object.entries(cases)) {
    const { sim } = makeSim(); sim.start(); run(sim, 60);
    assert.equal(sim.statuses[param], 'SAFE', `${fault}: baseline`);
    sim.setFault(fault, true); run(sim, fault === 'overheating' ? 150 : 40);
    assert.ok(['WARNING', 'CRITICAL'].includes(sim.statuses[param]), `${fault}: ${param}=${sim.values[param]} ${sim.statuses[param]}`);
    assert.notEqual(sim.health.label, 'Healthy', fault);
    sim.clearFaults(); run(sim, fault === 'overheating' ? 400 : 60);
    assert.equal(sim.statuses[param], 'SAFE', `${fault}: cleared (${sim.values[param]})`);
  }
});

test('overvoltage and undervoltage are mutually exclusive; faults need a running generator', () => {
  const { sim } = makeSim(); sim.start();
  sim.setFault('overvoltage', true); sim.setFault('undervoltage', true);
  assert.equal(sim.s.faults.overvoltage, false); assert.equal(sim.s.faults.undervoltage, true);
  assert.throws(() => sim.setFault('nope', true));
});

test('alert manager is fed only while RUNNING; closing all alerts on stop', () => {
  const { sim, calls } = makeSim(); sim.start(); run(sim, 5); assert.equal(calls.process, 0);
  run(sim, 50); assert.ok(calls.process > 0); sim.stop(); assert.equal(calls.closeAll, 1);
});

test('persistence: a single noisy sample does not raise a fault; hysteresis delays clearing', () => {
  const e = new F.FaultEngine(); const thr = F.defaultThresholds();
  const ok = { voltage: 400, current: 10, frequency: 50, rpm: 1500, vibration: 1, windingTemp: 60, bearingTemp: 50, powerFactor: 0.8, power: 5, load: 70 };
  e.evaluate(ok, thr);
  assert.equal(e.evaluate({ ...ok, voltage: 470 }, thr).overvoltage, 0, '1 sample: not yet');
  assert.equal(e.evaluate({ ...ok, voltage: 470 }, thr).overvoltage, 2, '2 samples: critical');
  assert.equal(e.evaluate({ ...ok, voltage: 455 }, thr).overvoltage, 2, 'just under critical: held by hysteresis/persistence');
  for (let i = 0; i < 3; i++) e.evaluate(ok, thr);
  assert.equal(e.levels().overvoltage, 0, 'cleared after 3 safe samples');
  // hysteresis band: 438 V is below 440 warn but inside the 2 % band, so a raised warning does not flap
  const e2 = new F.FaultEngine(); e2.evaluate({ ...ok, voltage: 445 }, thr); e2.evaluate({ ...ok, voltage: 445 }, thr);
  assert.equal(e2.levels().overvoltage, 1);
  for (let i = 0; i < 5; i++) e2.evaluate({ ...ok, voltage: 438 }, thr);
  assert.equal(e2.levels().overvoltage, 1, 'inside hysteresis band stays warning');
});

test('threshold validation', () => {
  const good = F.defaultThresholds();
  assert.equal(F.validateThresholds({ ...good }).ok, true);
  const mut = (k, t) => F.validateThresholds({ ...good, [k]: t });
  assert.equal(mut('overvoltage', { warn: 470, crit: 450 }).ok, false); // high: warn must be < crit
  assert.equal(mut('undervoltage', { warn: 340, crit: 360 }).ok, false); // low: crit must be < warn
  assert.equal(mut('overvoltage', { warn: 'abc', crit: 460 }).ok, false);
  assert.equal(mut('overvoltage', { warn: '', crit: 460 }).ok, false);
  assert.equal(mut('overvoltage', { warn: null, crit: 460 }).ok, false);
  assert.equal(mut('overvoltage', { warn: 440, crit: 99999 }).ok, false); // out of bounds
  assert.equal(F.validateThresholds(null).ok, false);
  assert.equal(F.validateThresholds({ ...good, undervoltage: { warn: 450, crit: 340 } }).ok, false); // low warning above high warning
});

test('component status = highest severity of its parameters', () => {
  const levels = F.FAULTS.reduce((o, f) => ({ ...o, [f.key]: 0 }), {});
  assert.equal(F.paramStatuses(levels, false).voltage, 'INACTIVE');
  levels.overcurrent = 1; let s = F.paramStatuses(levels, true);
  assert.equal(s.current, 'WARNING'); assert.equal(s.load, 'WARNING'); assert.equal(s.voltage, 'SAFE');
  levels.overcurrent = 2; assert.equal(F.paramStatuses(levels, true).power, 'CRITICAL');
  assert.equal(F.healthFrom(levels, true).label, 'Critical');
});

test('every fault has complete knowledge-base content and sane defaults', () => {
  for (const f of F.FAULTS) {
    for (const k of ['name', 'category', 'severity', 'param', 'risk', 'action']) assert.ok(f[k], `${f.key}.${k}`);
    assert.ok(f.causes.length && f.effects.length && f.checklist.length, f.key);
    assert.equal(F.validateThresholds({ ...F.defaultThresholds() }).ok, true);
  }
});
