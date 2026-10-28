# Virtual Industrial Generator Monitoring & Fault Detection Dashboard

A **software simulation** of a 10 kVA, 400 V, 50 Hz, 1500 RPM three-phase generator with live monitoring, fault detection, alerts, history, reports and admin tools.
Stack: HTML/CSS/JavaScript · Node.js · Express · MongoDB (Mongoose) · Chart.js · bcrypt · JWT cookie.

> Simulated readings, corrective-action checks and resolution verification are demonstrations, **not** real industrial safety controls.

## Run it

1. Install Node.js 18+ and MongoDB (local, or a free MongoDB Atlas cluster).
2. In this folder:
   ```bash
   npm install
   cp .env.example .env      # Windows: copy .env.example .env
   # edit .env: MONGODB_URI, PORT, JWT_SECRET
   npm start
   ```
3. Open http://localhost:3000 → **Sign up**. **The first account becomes the admin**; later sign-ups are operators (admins can promote them on the Users page).

| Variable | Meaning |
|---|---|
| `MONGODB_URI` | e.g. `mongodb://127.0.0.1:27017/generator_monitor` or your Atlas string |
| `PORT` | default `3000` |
| `JWT_SECRET` | long random string; **required** when `NODE_ENV=production` (a random one is used in dev, so logins reset on restart) |

No secrets are stored in source code.

## Project layout

```
server.js                 app setup, page routes, single simulator loop
src/config.js             environment config
src/models.js             User, Reading, Alert, AuditLog, Settings (separate collections)
src/faults.js             fault definitions, default thresholds, knowledge-base data, hysteresis engine
src/simulator.js          the one virtual generator (physics + fault injection + readings)
src/alerts.js             alert creation / de-duplication / escalation
src/auth.js, audit.js, settings.js
src/routes/api.js         all REST endpoints with auth + role checks
views/*.html              pages (login, dashboard, alerts, history, report, knowledge, thresholds, users, audit)
public/css/app.css        light theme
public/js/*.js            common helpers, dashboard + SVG diagram, alert modal
test/engine.test.js       tests that need no database          (npm test)
test/api.test.js          full API tests, needs MongoDB binary  (npm run test:api)
```

## How the main requirements are met

- **One simulation**: a single `setInterval` (1 s) in `Simulator`; every consumer (API, alerts, history, dashboard, diagram) reads the same `values`/`statuses`.
- **Physics**: f = RPM·4/120; P = √3·V·I·PF; load % = I / I_rated; temperatures follow first-order heating/cooling; fuel efficiency is shown only while running steadily at ≥ 1 kW.
- **Faults**: overvoltage, undervoltage, overcurrent, overheating, high vibration, overspeed, underspeed buttons (injected gradually). Backend thresholds with 2-sample persistence to raise, 3-sample persistence + 2 % hysteresis to clear. One open alert per fault (no duplicates); warning → critical escalation raises a new critical alert.
- **Acknowledge ≠ clear**: acknowledging needs a note, silences the alarm sound, and never changes status/colours. **Resolution** is separate: needs a checklist + note and is only "Verified resolved" if the backend sees the reading back within the safe limit; otherwise it explains why.
- **Diagram**: SVG engine / alternator / load, colours from backend statuses (highest severity), grey when stopped, CSS animation only while running.
- **RBAC** enforced in the backend (`requireRole`); operators get 403 on thresholds, users, audit, clear-history, settings. User role is re-read from the DB on every request.
- **Audit log** is a separate collection and is never touched by "Clear history"; history clearing is audited *before* deleting.
- **Voice**: browser `speechSynthesis` only; mute + stop buttons; unsupported browsers are handled. Alarm: WebAudio beep for unacknowledged critical alerts.

## Test status (honest)

| Area | Status |
|---|---|
| Simulator ramp up/down, derived-value formulas, fuel-efficiency rule, single loop | **Tested** (`npm test`, 11 tests pass) |
| All 7 fault controls change shared readings/statuses and clear again; hysteresis/persistence; threshold validation; highest-severity status | **Tested** (`npm test`) |
| Dashboard, SVG diagram colours (grey → green → red), animation toggle, ack-needs-note, ack keeps colour, all pages load without JS errors, KB search, mobile layout | **Tested in Chromium against a mock API** using the real simulator |
| Auth, hashing, MongoDB persistence, alerts in DB, ack/resolve API, history/CSV, RBAC, thresholds API, audit, users, clear-history | **Written (`test/api.test.js`) but NOT run** – the build sandbox could not obtain a MongoDB server. Run `npm run test:api` (downloads a MongoDB binary) or use the checklist below. |
| Real browser speech and alarm audio | Not tested (headless browser has no audio) |

## Manual test checklist

1. **Auth** – sign up (first = admin), log out, log in, wrong password rejected, open `/` while logged out → redirected to login. Check MongoDB `users`: only `passwordHash` (bcrypt `$2…`).
2. **Simulation** – Start: RPM/voltage climb gradually to ~1500 / 400 V; Stop: fall gradually to 0. Click Start twice → "already running".
3. **Calculations** – at steady state: frequency ≈ RPM/30, kW ≈ √3·V·I·PF/1000, load % ≈ I/14.43.
4. **Faults** – toggle each fault; the matching card turns orange/red, an alert appears once (not repeatedly), health drops. Clear faults → status returns to SAFE.
5. **Ack / resolve** – open an alert (it must stay unacknowledged); try acknowledging with empty note (rejected); use a suggestion chip; alarm stops, colours stay. Try resolving while the fault persists (rejected with reason); clear the fault, tick checklist + note → "Verified resolved". Re-inject the fault → a new alert is created.
6. **History / CSV** – History page: summary cards, charts, date filter, both CSV downloads open in a spreadsheet.
7. **Diagram** – grey when stopped, green when running, component turns orange/red with its parameters, animation stops when generator stops.
8. **Admin** – Thresholds: invalid values rejected, valid change applies at once; operator account gets 403 / redirect on admin pages and APIs. Users: promote/demote/remove with confirmation; cannot remove self or last admin. Audit: start/stop, ack, resolve, threshold, role and clear-history entries. History → Clear: confirmation required; users/thresholds/audit remain.
9. **Report** – Report page → Print → Save as PDF.
10. **Voice** – trigger a critical fault: spoken announcement once; mute and Stop speech work; Voice settings on Thresholds page.
11. **Knowledge base** – search and filters; "View entry" link inside an alert modal opens the matching fault.

## Notes / limitations

- The original project you described was not attached, so this is a fresh, self-contained build rather than a patch of existing code.
- Alerts open at server start are closed (the simulator always starts STOPPED).
- Login throttling is in-memory (resets on restart); use HTTPS and `NODE_ENV=production` when deploying.
