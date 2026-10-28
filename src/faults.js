'use strict';
/**
 * Fault definitions, default thresholds, knowledge-base content,
 * threshold validation and the persistence/hysteresis fault engine.
 * Single source of truth used by the simulator, alert manager, API and KB page.
 */

const RATED = {
  voltage: 400, // V line-to-line
  current: 14.43, // A  (10 kVA / (sqrt(3) * 400 V))
  frequency: 50, // Hz
  rpm: 1500, // RPM (4-pole alternator: f = rpm * 4 / 120)
  kVA: 10,
  powerFactor: 0.8,
  kW: 8,
  ambient: 30, // degC
};

const PARAMS = {
  voltage: { label: 'Voltage', unit: 'V', group: 'Electrical', decimals: 1 },
  current: { label: 'Current', unit: 'A', group: 'Electrical', decimals: 2 },
  frequency: { label: 'Frequency', unit: 'Hz', group: 'Electrical', decimals: 2 },
  power: { label: 'Active Power', unit: 'kW', group: 'Electrical', decimals: 2 },
  powerFactor: { label: 'Power Factor', unit: '', group: 'Electrical', decimals: 2 },
  load: { label: 'Load', unit: '%', group: 'Electrical', decimals: 1 },
  rpm: { label: 'Engine Speed', unit: 'RPM', group: 'Mechanical', decimals: 0 },
  vibration: { label: 'Vibration', unit: 'mm/s', group: 'Mechanical', decimals: 2 },
  windingTemp: { label: 'Winding Temperature', unit: '°C', group: 'Mechanical', decimals: 1 },
  bearingTemp: { label: 'Bearing Temperature', unit: '°C', group: 'Mechanical', decimals: 1 },
};

// dir: 'high' = fault when value rises above threshold; 'low' = when it falls below.
// simKey: the simulation control that injects this fault (null = cannot be injected).
const FAULTS = [
  {
    key: 'overvoltage', name: 'Overvoltage', param: 'voltage', dir: 'high', category: 'Electrical', severity: 'High',
    affects: ['voltage'], simKey: 'overvoltage', defaults: { warn: 440, crit: 460 }, bounds: { min: 200, max: 700 },
    causes: ['Automatic voltage regulator (AVR) malfunction', 'Sudden loss of connected load', 'Excitation system fault'],
    effects: ['Insulation stress on windings', 'Damage to connected equipment', 'Reduced equipment life'],
    risk: 'Sustained overvoltage can damage insulation and connected equipment.',
    action: 'Reduce excitation or check the AVR; verify the load is connected; investigate before continuing.',
    checklist: ['Checked AVR / excitation settings', 'Inspected load connections', 'Compared reading with a reference meter'],
  },
  {
    key: 'undervoltage', name: 'Undervoltage', param: 'voltage', dir: 'low', category: 'Electrical', severity: 'Medium',
    affects: ['voltage'], simKey: 'undervoltage', defaults: { warn: 360, crit: 340 }, bounds: { min: 100, max: 500 },
    causes: ['AVR or excitation fault', 'Engine speed too low', 'Excessive load or short circuit'],
    effects: ['Motors draw higher current and overheat', 'Equipment malfunction or tripping', 'Possible loss of supply quality'],
    risk: 'Low voltage can cause connected motors to overheat and equipment to trip.',
    action: 'Check engine speed and AVR output; reduce load; inspect for overload or short circuits.',
    checklist: ['Checked engine speed', 'Checked AVR / excitation', 'Reduced connected load'],
  },
  {
    key: 'overcurrent', name: 'Overcurrent / Overload', param: 'current', dir: 'high', category: 'Electrical', severity: 'High',
    affects: ['current', 'load', 'power'], simKey: 'overcurrent', defaults: { warn: 15, crit: 17 }, bounds: { min: 1, max: 60 },
    causes: ['Connected load exceeds generator rating', 'Short circuit or ground fault downstream', 'Motor start-up surges'],
    effects: ['Winding overheating', 'Protection device tripping', 'Insulation degradation'],
    risk: 'Overload heats the windings and shortens insulation life.',
    action: 'Shed non-essential load immediately; inspect the load side for faults before restoring load.',
    checklist: ['Reduced or shed load', 'Inspected connections and cables', 'Checked for downstream faults'],
  },
  {
    key: 'overfrequency', name: 'Overfrequency', param: 'frequency', dir: 'high', category: 'Electrical', severity: 'Medium',
    affects: ['frequency'], simKey: null, defaults: { warn: 51.5, crit: 53 }, bounds: { min: 45, max: 70 },
    causes: ['Engine speed too high (governor fault)', 'Sudden loss of load'],
    effects: ['Frequency-sensitive equipment misbehaves', 'Overspeed stress on the engine'],
    risk: 'High frequency indicates high engine speed and stresses rotating parts.',
    action: 'Check governor and fuel control; verify the load; reduce speed setpoint.',
    checklist: ['Checked governor settings', 'Verified load is connected', 'Checked speed against tachometer'],
  },
  {
    key: 'underfrequency', name: 'Underfrequency', param: 'frequency', dir: 'low', category: 'Electrical', severity: 'Medium',
    affects: ['frequency'], simKey: null, defaults: { warn: 48.5, crit: 47 }, bounds: { min: 30, max: 55 },
    causes: ['Engine running too slowly (fuel or governor issue)', 'Overload slowing the engine'],
    effects: ['Motors run slow and overheat', 'Clocks and timing equipment drift', 'Possible voltage drop'],
    risk: 'Low frequency stresses motors and frequency-sensitive loads.',
    action: 'Check fuel supply and governor; reduce load; inspect the engine.',
    checklist: ['Checked fuel supply', 'Checked governor settings', 'Reduced load'],
  },
  {
    key: 'overspeed', name: 'Overspeed', param: 'rpm', dir: 'high', category: 'Mechanical', severity: 'High',
    affects: ['rpm'], simKey: 'overspeed', defaults: { warn: 1600, crit: 1650 }, bounds: { min: 1000, max: 2500 },
    causes: ['Governor or speed-control failure', 'Fuel control stuck open', 'Sudden loss of load'],
    effects: ['Excessive mechanical stress', 'Bearing and rotor damage', 'Risk of catastrophic failure'],
    risk: 'Overspeed can seriously damage rotating components.',
    action: 'Reduce speed or stop the engine; inspect the governor and fuel control before restarting.',
    checklist: ['Stopped or slowed the engine', 'Inspected governor / fuel control', 'Checked speed against tachometer'],
  },
  {
    key: 'underspeed', name: 'Underspeed', param: 'rpm', dir: 'low', category: 'Mechanical', severity: 'Medium',
    affects: ['rpm'], simKey: 'underspeed', defaults: { warn: 1400, crit: 1350 }, bounds: { min: 500, max: 2000 },
    causes: ['Fuel starvation or clogged filter', 'Overload', 'Governor fault'],
    effects: ['Low frequency and voltage', 'Engine stalling', 'Poor power quality'],
    risk: 'Engine may stall and supply quality degrades.',
    action: 'Check fuel supply and filters; reduce load; inspect the governor.',
    checklist: ['Checked fuel level and filters', 'Reduced load', 'Inspected governor'],
  },
  {
    key: 'high_vibration', name: 'High Vibration', param: 'vibration', dir: 'high', category: 'Mechanical', severity: 'High',
    affects: ['vibration'], simKey: 'highVibration', defaults: { warn: 4.5, crit: 7.1 }, bounds: { min: 0.5, max: 30 },
    causes: ['Shaft misalignment or imbalance', 'Worn bearings', 'Loose mounting bolts'],
    effects: ['Accelerated bearing wear', 'Fatigue cracking', 'Possible shaft or coupling failure'],
    risk: 'Persistent vibration accelerates wear and may lead to mechanical failure.',
    action: 'Inspect mounting, alignment and bearings; reduce load or stop the generator if vibration persists.',
    checklist: ['Inspected mounting bolts', 'Checked alignment / coupling', 'Inspected bearings'],
  },
  {
    key: 'winding_overtemp', name: 'Winding Overtemperature', param: 'windingTemp', dir: 'high', category: 'Thermal', severity: 'High',
    affects: ['windingTemp'], simKey: 'overheating', defaults: { warn: 105, crit: 130 }, bounds: { min: 40, max: 220 },
    causes: ['Overload', 'Blocked cooling airflow or failed fan', 'High ambient temperature'],
    effects: ['Insulation breakdown', 'Reduced winding life', 'Winding short circuit'],
    risk: 'Overheating degrades winding insulation and can cause permanent damage.',
    action: 'Reduce load; check cooling fan and ventilation; allow the generator to cool before resuming full load.',
    checklist: ['Checked cooling fan', 'Reduced load', 'Cleared ventilation openings'],
  },
  {
    key: 'bearing_overtemp', name: 'Bearing Overtemperature', param: 'bearingTemp', dir: 'high', category: 'Thermal', severity: 'Medium',
    affects: ['bearingTemp'], simKey: null, defaults: { warn: 80, crit: 95 }, bounds: { min: 40, max: 200 },
    causes: ['Insufficient or degraded lubrication', 'Bearing wear or misalignment', 'Overheating of the machine'],
    effects: ['Bearing seizure', 'Increased vibration', 'Shaft damage'],
    risk: 'Overheated bearings can seize and damage the shaft.',
    action: 'Check lubrication; inspect bearings; reduce load and let the machine cool.',
    checklist: ['Checked lubrication', 'Inspected bearings', 'Reduced load'],
  },
  {
    key: 'low_power_factor', name: 'Low Power Factor', param: 'powerFactor', dir: 'low', category: 'Electrical', severity: 'Low',
    affects: ['powerFactor'], simKey: null, defaults: { warn: 0.75, crit: 0.7 }, bounds: { min: 0.3, max: 0.99 },
    causes: ['Highly inductive loads (lightly loaded motors)', 'Faulty power-factor correction'],
    effects: ['Higher current for the same real power', 'Reduced effective generator capacity'],
    risk: 'Poor power factor wastes generator capacity and raises current.',
    action: 'Review connected loads; add or repair power-factor correction.',
    checklist: ['Reviewed connected loads', 'Checked power-factor correction'],
  },
];

const FAULT_MAP = Object.fromEntries(FAULTS.map((f) => [f.key, f]));
const SIM_FAULTS = {
  overvoltage: { label: 'Overvoltage', opposite: 'undervoltage' },
  undervoltage: { label: 'Undervoltage', opposite: 'overvoltage' },
  overcurrent: { label: 'Overcurrent', opposite: null },
  overheating: { label: 'Overheating', opposite: null },
  highVibration: { label: 'High Vibration', opposite: null },
  overspeed: { label: 'Overspeed', opposite: 'underspeed' },
  underspeed: { label: 'Underspeed', opposite: 'overspeed' },
};

const SEV_NAME = ['SAFE', 'WARNING', 'CRITICAL'];

function defaultThresholds() {
  const out = {};
  for (const f of FAULTS) out[f.key] = { warn: f.defaults.warn, crit: f.defaults.crit };
  return out;
}

/** Merge stored thresholds over defaults, ignoring anything malformed. */
function mergeThresholds(stored) {
  const out = defaultThresholds();
  if (stored && typeof stored === 'object') {
    for (const f of FAULTS) {
      const s = stored[f.key];
      if (s && Number.isFinite(s.warn) && Number.isFinite(s.crit)) out[f.key] = { warn: s.warn, crit: s.crit };
    }
  }
  return out;
}

/** Validate an admin-submitted threshold object. Returns {ok, errors, clean}. */
function validateThresholds(input) {
  const errors = [];
  const clean = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['Thresholds must be an object'], clean };
  for (const f of FAULTS) {
    const t = input[f.key];
    if (!t || typeof t !== 'object') { errors.push(`${f.name}: missing thresholds`); continue; }
    const warn = Number(t.warn);
    const crit = Number(t.crit);
    if (!Number.isFinite(warn) || !Number.isFinite(crit) || t.warn === '' || t.crit === '' || t.warn === null || t.crit === null) {
      errors.push(`${f.name}: warning and critical must be numbers`); continue;
    }
    const { min, max } = f.bounds;
    if (warn < min || warn > max || crit < min || crit > max) { errors.push(`${f.name}: values must be between ${min} and ${max}`); continue; }
    if (f.dir === 'high' && !(warn < crit)) { errors.push(`${f.name}: warning must be lower than critical`); continue; }
    if (f.dir === 'low' && !(crit < warn)) { errors.push(`${f.name}: critical must be lower than warning`); continue; }
    clean[f.key] = { warn, crit };
  }
  // A "low" warning level must stay below the matching "high" warning level.
  const byParam = {};
  for (const f of FAULTS) (byParam[f.param] = byParam[f.param] || {})[f.dir] = f;
  for (const [param, pair] of Object.entries(byParam)) {
    if (pair.high && pair.low && clean[pair.high.key] && clean[pair.low.key]) {
      if (!(clean[pair.low.key].warn < clean[pair.high.key].warn)) errors.push(`${PARAMS[param].label}: low warning must be below high warning`);
    }
  }
  return { ok: errors.length === 0, errors, clean };
}

/** Is the value on the safe side of the *warning* threshold (no hysteresis)? */
function withinSafeLimit(fault, value, thr) {
  if (!Number.isFinite(value)) return false;
  return fault.dir === 'high' ? value < thr.warn : value > thr.warn;
}

class FaultEngine {
  constructor(opts = {}) {
    this.upTicks = opts.upTicks || 2; // consecutive samples needed to raise a status
    this.downTicks = opts.downTicks || 3; // consecutive samples needed to lower a status
    this.hyst = opts.hyst ?? 0.02; // 2% band before a status can clear
    this.reset();
  }
  reset() {
    this.s = {};
    for (const f of FAULTS) this.s[f.key] = { level: 0, up: 0, down: 0 };
  }
  levels() {
    const o = {};
    for (const f of FAULTS) o[f.key] = this.s[f.key].level;
    return o;
  }
  _raw(f, v, t, cur) {
    const h = this.hyst;
    if (f.dir === 'high') {
      const crit = cur >= 2 ? t.crit * (1 - h) : t.crit;
      const warn = cur >= 1 ? t.warn * (1 - h) : t.warn;
      return v >= crit ? 2 : v >= warn ? 1 : 0;
    }
    const crit = cur >= 2 ? t.crit * (1 + h) : t.crit;
    const warn = cur >= 1 ? t.warn * (1 + h) : t.warn;
    return v <= crit ? 2 : v <= warn ? 1 : 0;
  }
  evaluate(values, thr) {
    for (const f of FAULTS) {
      const st = this.s[f.key];
      const raw = this._raw(f, values[f.param], thr[f.key], st.level);
      if (raw > st.level) {
        st.up++; st.down = 0;
        if (st.up >= this.upTicks) { st.level = raw; st.up = 0; }
      } else if (raw < st.level) {
        st.down++; st.up = 0;
        if (st.down >= this.downTicks) { st.level = raw; st.down = 0; }
      } else { st.up = 0; st.down = 0; }
    }
    return this.levels();
  }
}

/** Status per parameter = highest fault level among faults that affect it. */
function paramStatuses(levels, active) {
  const out = {};
  for (const p of Object.keys(PARAMS)) out[p] = active ? 'SAFE' : 'INACTIVE';
  if (!active) return out;
  for (const f of FAULTS) {
    const lv = levels[f.key] || 0;
    for (const p of f.affects) if (lv > SEV_NAME.indexOf(out[p])) out[p] = SEV_NAME[lv];
  }
  return out;
}

function healthFrom(levels, active) {
  if (!active) return { score: 0, label: 'Offline' };
  let crit = 0, warn = 0;
  for (const f of FAULTS) { if (levels[f.key] === 2) crit++; else if (levels[f.key] === 1) warn++; }
  const score = Math.max(0, 100 - 40 * crit - 15 * warn);
  return { score, label: crit ? 'Critical' : warn ? 'Degraded' : 'Healthy' };
}

module.exports = {
  RATED, PARAMS, FAULTS, FAULT_MAP, SIM_FAULTS, SEV_NAME,
  defaultThresholds, mergeThresholds, validateThresholds, withinSafeLimit,
  FaultEngine, paramStatuses, healthFrom,
};
