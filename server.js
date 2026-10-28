'use strict';
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const config = require('./src/config');
const settings = require('./src/settings');
const { Reading } = require('./src/models');
const { Simulator } = require('./src/simulator');
const { AlertManager } = require('./src/alerts');
const { requirePage, requireAdminPage } = require('./src/auth');
const buildApi = require('./src/routes/api');

async function createApp({ tickMs = 1000, autoStartLoop = true } = {}) {
  await settings.load();
  const alertManager = new AlertManager();
  const sim = new Simulator({ alertManager, readingModel: Reading, settings, tickMs });
  if (autoStartLoop) sim.startLoop(); // exactly one simulation loop for the whole process

  // On boot, close alerts left "active" by a previous run - the simulator always starts STOPPED.
  const { Alert } = require('./src/models');
  await Alert.updateMany({ status: 'active' }, { $set: { status: 'cleared', clearedAt: new Date(), clearReason: 'Server restarted' } });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '50kb' }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
    next();
  });

  app.use('/api', buildApi(sim, alertManager));
  app.use('/vendor/chart.js', express.static(path.join(__dirname, 'node_modules/chart.js/dist')));
  app.use(express.static(path.join(__dirname, 'public'), { index: false }));

  const view = (f) => (req, res) => res.sendFile(path.join(__dirname, 'views', f));
  app.get('/login', view('login.html'));
  app.get('/', requirePage, view('dashboard.html'));
  for (const p of ['history', 'alerts', 'knowledge', 'report']) app.get(`/${p}`, requirePage, view(`${p}.html`));
  for (const p of ['thresholds', 'audit', 'users']) app.get(`/${p}`, requirePage, requireAdminPage, view(`${p}.html`));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error('[error]', err);
    res.status(500).json({ error: 'Internal server error' });
  });
  return { app, sim, alertManager };
}

async function main() {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
  console.log('[db] connected');
  const { app } = await createApp();
  app.listen(config.port, () => console.log(`Generator monitor (SIMULATION) running at http://localhost:${config.port}`));
}

if (require.main === module) main().catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
module.exports = { createApp };
