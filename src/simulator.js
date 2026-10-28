'use strict';
const { RATED, SIM_FAULTS, FaultEngine, paramStatuses, healthFrom, FAULTS } = require('./faults');

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * The ONE virtual generator. A single timer drives it; every consumer (API, alerts,
 * history, dashboard, diagram) reads the same `values` produced here.
 *
 * Physical relations kept consistent:
 *   frequency = rpm * 4 / 120            (4-pole machine)
 *   voltage   = AVR-regulated 400 V (drops only if rpm < 90 %), then x fault factor
 *   current   = load fraction * rated current * (V / 400)     (resistive-type load)
 *   load %    = current / rated current
 *   power kW  = sqrt(3) * V * I * PF / 1000
 *   temperatures follow first-order heating/cooling toward a load-dependent target
 */
class Simulator {
  constructor({ alertManager, readingModel, settings, tickMs = 1000, persistEvery = 2 }) {
    this.alerts = alertManager;
    this.Reading = readingModel;
    this.settings = settings;
    this.tickMs = tickMs;
    this.persistEvery = persistEvery;
    this.noiseScale = 1; // tests set 0 for deterministic output
    this.timer = null;
    this.engine = new FaultEngine();
    this.tickCount = 0;
    this.s = {
      running: false, level: 0, loadSetting: 70,
      sp: 1, vf: 1, ld: 70, vb: 0, // smoothed fault-driven multipliers
      wt: RATED.ambient, bt: RATED.ambient,
      faults: Object.fromEntries(Object.keys(SIM_FAULTS).map((k) => [k, false])),
    };
    this.values = this._zeroValues();
    this.levels = this.engine.levels();
    this.statuses = paramStatuses(this.levels, false);
    this.health = healthFrom(this.levels, false);
  }

  _zeroValues() {
    return {
      voltage: 0, current: 0, frequency: 0, power: 0, powerFactor: 0, load: 0, rpm: 0, vibration: 0,
      windingTemp: RATED.ambient, bearingTemp: RATED.ambient, fuelRate: 0, fuelEfficiency: null,
    };
  }

  /** Start the single timer. Safe to call repeatedly - never creates a second loop. */
  startLoop() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    if (this.timer.unref) this.timer.unref();
  }
  stopLoop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  state() {
    const s = this.s;
    if (!s.running && s.level <= 0) return 'STOPPED';
    if (s.running && s.level < 0.999) return 'STARTING';
    if (s.running) return 'RUNNING';
    return 'STOPPING';
  }

  start() {
    if (this.s.running) return false;
    this.s.running = true;
    return true;
  }
  stop() {
    if (!this.s.running && this.s.level <= 0) return false;
    if (!this.s.running) return false;
    this.s.running = false;
    this.engine.reset();
    this.alerts.closeAll('Generator stopped');
    return true;
  }

  setFault(key, active) {
    if (!(key in SIM_FAULTS)) throw new Error('Unknown fault');
    if (active && SIM_FAULTS[key].opposite) this.s.faults[SIM_FAULTS[key].opposite] = false;
    this.s.faults[key] = !!active;
  }
  clearFaults() { for (const k of Object.keys(this.s.faults)) this.s.faults[k] = false; }

  _n(amp) { return this.noiseScale ? (Math.random() + Math.random() + Math.random() - 1.5) * (2 / 3) * amp * this.noiseScale : 0; }

  step() {
    const s = this.s, f = s.faults;
    // ramp: ~13 s to start, ~17 s to stop
    s.level = s.running ? Math.min(1, s.level + 0.08) : Math.max(0, s.level - 0.06);
    if (s.level < 1e-9) s.level = 0;
    const L = s.level;

    // smooth fault effects so injected faults develop gradually, not instantly
    const a = 0.3;
    s.sp += ((f.overspeed ? 1.12 : f.underspeed ? 0.85 : 1) - s.sp) * a;
    s.vf += ((f.overvoltage ? 1.18 : f.undervoltage ? 0.8 : 1) - s.vf) * a;
    s.ld += ((f.overcurrent ? 125 : s.loadSetting) - s.ld) * a;
    s.vb += ((f.highVibration ? 6 : 0) - s.vb) * a;

    const rpm = L > 0 ? L * RATED.rpm * s.sp + this._n(4) : 0;
    const frequency = rpm / 30;
    const vAvr = RATED.voltage * Math.min(1, rpm / (0.9 * RATED.rpm));
    const voltage = L > 0 ? Math.max(0, vAvr * s.vf + this._n(1.5)) : 0;

    // load is connected during the last 40 % of the start-up ramp
    const loadEff = (s.ld / 100) * clamp((L - 0.6) / 0.4, 0, 1);
    let current = loadEff * RATED.current * (voltage / RATED.voltage);
    if (current > 0) current = Math.max(0, current + this._n(0.08));
    const load = (current / RATED.current) * 100;
    const powerFactor = current > 0.05 ? clamp(0.8 + this._n(0.008) - (load > 110 ? 0.02 : 0), 0.3, 1) : 0;
    const power = (Math.sqrt(3) * voltage * current * powerFactor) / 1000;

    const sr = rpm / RATED.rpm;
    const vibration = L > 0 ? Math.max(0, L * (0.9 * sr * sr + 0.8 * (load / 100)) + s.vb + this._n(0.05)) : 0;

    // thermal model: first-order approach to a load-dependent target (cools toward ambient, not zero)
    const heating = f.overheating && L > 0 ? 75 : 0;
    const wTarget = RATED.ambient + 5 * L + 75 * Math.pow(loadEff, 2) + heating;
    s.wt += (wTarget - s.wt) * (wTarget > s.wt ? 0.05 : 0.02);
    const bTarget = RATED.ambient + 22 * sr + 0.25 * (s.wt - RATED.ambient) + (f.overheating && L > 0 ? 10 : 0);
    s.bt += (bTarget - s.bt) * (bTarget > s.bt ? 0.05 : 0.02);

    // Fuel: modelled Willans line, only shown once running steadily with meaningful load.
    let fuelRate = 0, fuelEfficiency = null;
    if (this.state() === 'RUNNING') {
      fuelRate = 0.8 + 0.22 * power; // L/h
      if (power >= 1) fuelEfficiency = power / fuelRate; // kWh per litre
    }

    this.values = {
      voltage: round(voltage, 2), current: round(current, 3), frequency: round(frequency, 3), power: round(power, 3),
      powerFactor: round(powerFactor, 3), load: round(load, 2), rpm: round(rpm, 1), vibration: round(vibration, 3),
      windingTemp: round(s.wt + this._n(0.1) * (L > 0), 2), bearingTemp: round(s.bt + this._n(0.1) * (L > 0), 2),
      fuelRate: round(fuelRate, 3), fuelEfficiency: fuelEfficiency === null ? null : round(fuelEfficiency, 3),
    };
  }

  /** One simulation tick: advance physics, evaluate faults, raise/close alerts, store a reading. */
  tick() {
    this.tickCount++;
    this.step();
    const state = this.state();
    const monitoring = state === 'RUNNING';
    if (monitoring) {
      const thr = this.settings.getThresholds();
      this.levels = this.engine.evaluate(this.values, thr);
      this.alerts.process(this.levels, this.values, thr);
    } else {
      this.engine.reset();
      this.levels = this.engine.levels();
    }
    this.statuses = paramStatuses(this.levels, monitoring);
    this.health = healthFrom(this.levels, monitoring);

    if (state !== 'STOPPED' && this.tickCount % this.persistEvery === 0) {
      const active = FAULTS.filter((x) => this.levels[x.key] > 0).map((x) => x.key);
      this.Reading.create({ ts: new Date(), state, ...this.values, healthScore: this.health.score, faults: active })
        .catch((e) => console.error('[sim] could not store reading:', e.message));
    }
  }

  snapshot() {
    return {
      state: this.state(),
      running: this.s.running,
      values: this.values,
      statuses: this.statuses,
      levels: this.levels,
      health: this.health,
      simFaults: { ...this.s.faults },
      ts: new Date().toISOString(),
    };
  }
}

module.exports = { Simulator };
