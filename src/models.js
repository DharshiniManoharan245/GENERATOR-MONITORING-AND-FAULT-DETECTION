'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;

// Users - credentials and role only.
const User = mongoose.model('User', new Schema({
  username: { type: String, required: true },
  usernameLower: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['admin', 'operator'], default: 'operator' },
  createdAt: { type: Date, default: Date.now },
}));

// Readings - operational history (cleared by "Clear history").
const Reading = mongoose.model('Reading', new Schema({
  ts: { type: Date, default: Date.now, index: true },
  state: String,
  voltage: Number, current: Number, frequency: Number, power: Number, powerFactor: Number, load: Number,
  rpm: Number, vibration: Number, windingTemp: Number, bearingTemp: Number,
  fuelRate: Number, fuelEfficiency: Number,
  healthScore: Number,
  faults: [String],
}));

const ackSchema = new Schema({ by: String, note: String, at: Date }, { _id: false });
const resolutionSchema = new Schema({
  by: String, note: String, at: Date, checklist: [String], verifiedValue: Number, verified: Boolean,
}, { _id: false });
const requestSchema = new Schema({ by: String, note: String, at: Date, outcome: String, reason: String }, { _id: false });

// Alerts - operational history (cleared by "Clear history").
const Alert = mongoose.model('Alert', new Schema({
  faultKey: { type: String, index: true },
  name: String, category: String, param: String, paramLabel: String, unit: String, direction: String,
  severity: { type: String, enum: ['WARNING', 'CRITICAL'] },
  status: { type: String, enum: ['active', 'cleared', 'resolved'], default: 'active', index: true },
  startedAt: { type: Date, default: Date.now, index: true },
  clearedAt: Date, clearReason: String,
  value: Number, threshold: Number,
  reason: String, risk: String, action: String,
  ack: { type: ackSchema, default: undefined },
  resolution: { type: resolutionSchema, default: undefined },
  resolutionRequests: [requestSchema],
}));

// Audit log - kept separate from operational history; never cleared by "Clear history".
const AuditLog = mongoose.model('AuditLog', new Schema({
  ts: { type: Date, default: Date.now, index: true },
  username: String,
  action: { type: String, index: true },
  details: Schema.Types.Mixed,
}));

// Settings - thresholds and system settings (single document).
const Settings = mongoose.model('Settings', new Schema({
  key: { type: String, unique: true },
  thresholds: Schema.Types.Mixed,
  voiceEnabled: { type: Boolean, default: true },
  announceWarnings: { type: Boolean, default: false },
}));

module.exports = { User, Reading, Alert, AuditLog, Settings };
