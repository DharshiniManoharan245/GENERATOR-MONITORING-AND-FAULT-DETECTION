'use strict';
const { Alert } = require('./models');
const { FAULTS, FAULT_MAP, PARAMS } = require('./faults');

const fmt = (v, d) => Number(v).toFixed(d);

/**
 * Creates / closes alerts from fault-engine levels.
 *  - one open ("active") alert per fault: no duplicates while a fault continues
 *  - warning -> critical escalation closes the warning alert and raises a NEW critical alert
 *  - acknowledging never closes an alert; only the condition clearing does
 * Database writes are chained so they happen in order without blocking the simulation tick.
 */
class AlertManager {
  constructor() {
    this.open = new Map(); // faultKey -> { id, severity }
    this.chain = Promise.resolve();
  }

  _enqueue(fn) {
    this.chain = this.chain.then(fn).catch((e) => console.error('[alerts] db error:', e.message));
    return this.chain;
  }
  idle() { return this.chain; }
  resetCache() { this.open.clear(); }

  _build(f, level, values, thr) {
    const sev = level === 2 ? 'CRITICAL' : 'WARNING';
    const p = PARAMS[f.param];
    const limit = level === 2 ? thr[f.key].crit : thr[f.key].warn;
    const value = values[f.param];
    const side = f.dir === 'high' ? 'above' : 'below';
    return new Alert({
      faultKey: f.key, name: f.name, category: f.category, param: f.param, paramLabel: p.label, unit: p.unit,
      direction: f.dir, severity: sev, status: 'active', startedAt: new Date(),
      value, threshold: limit,
      reason: `${p.label} is ${fmt(value, p.decimals)} ${p.unit}, ${side} the ${sev.toLowerCase()} threshold of ${limit} ${p.unit}.`.replace(/ \./, '.'),
      risk: f.risk, action: f.action,
    });
  }

  _close(entry, reason) {
    const id = entry.id;
    return this._enqueue(() => Alert.updateOne(
      { _id: id, status: 'active' },
      { $set: { status: 'cleared', clearedAt: new Date(), clearReason: reason } },
    ));
  }

  /** Called every tick with the engine levels (only while the generator is RUNNING). */
  process(levels, values, thr) {
    for (const f of FAULTS) {
      const level = levels[f.key] || 0;
      const cur = this.open.get(f.key);
      if (level > 0 && !cur) {
        this._raise(f, level, values, thr);
      } else if (level === 2 && cur && cur.severity === 'WARNING') {
        this.open.delete(f.key);
        this._close(cur, 'Escalated to critical');
        this._raise(f, level, values, thr);
      } else if (level === 0 && cur) {
        this.open.delete(f.key);
        this._close(cur, 'Condition returned to normal');
      }
    }
  }

  _raise(f, level, values, thr) {
    const doc = this._build(f, level, values, thr);
    this.open.set(f.key, { id: doc._id, severity: doc.severity });
    this._enqueue(() => doc.save());
  }

  /** Generator stopped: the monitored condition no longer exists, close open alerts. */
  closeAll(reason) {
    for (const [key, cur] of this.open.entries()) {
      this.open.delete(key);
      this._close(cur, reason);
    }
  }
}

module.exports = { AlertManager, FAULT_MAP };
