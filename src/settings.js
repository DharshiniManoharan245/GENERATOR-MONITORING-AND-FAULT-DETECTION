'use strict';
const { Settings } = require('./models');
const { mergeThresholds } = require('./faults');

// In-memory cache so the fault engine never hits the database on every tick.
let cache = { thresholds: mergeThresholds(null), voiceEnabled: true, announceWarnings: false };

async function load() {
  const doc = await Settings.findOne({ key: 'system' }).lean();
  if (doc) {
    cache = {
      thresholds: mergeThresholds(doc.thresholds),
      voiceEnabled: doc.voiceEnabled !== false,
      announceWarnings: !!doc.announceWarnings,
    };
  }
  return cache;
}

const getThresholds = () => cache.thresholds;
const getSettings = () => ({ voiceEnabled: cache.voiceEnabled, announceWarnings: cache.announceWarnings });

async function setThresholds(clean) {
  await Settings.updateOne({ key: 'system' }, { $set: { thresholds: clean } }, { upsert: true });
  cache.thresholds = mergeThresholds(clean);
}

async function setSettings({ voiceEnabled, announceWarnings }) {
  await Settings.updateOne({ key: 'system' }, { $set: { voiceEnabled, announceWarnings } }, { upsert: true });
  cache.voiceEnabled = voiceEnabled;
  cache.announceWarnings = announceWarnings;
}

module.exports = { load, getThresholds, getSettings, setThresholds, setSettings };
