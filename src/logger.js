// src/logger.js
// Central logger for attendance-api
// Writes to: file (always) + PostgreSQL (if enabled) + socket (if admin watching)
// Non-blocking: DB and socket writes are fire-and-forget, never slow down requests

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';
import pool from './config/db.js';

// ── Log directory ─────────────────────────────────────────────────────────────
const LOG_DIR = path.join(process.cwd(), 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ── Config cache (reloaded every 60s from system_config table) ───────────────
let _config = {
  level:         process.env.LOG_LEVEL || 'info',
  dbEnabled:     true,
  fileEnabled:   true,
  socketEnabled: true,
};

let _socketEmitter = null; // set by server.js after socket is ready

export const setSocketEmitter = (emitFn) => { _socketEmitter = emitFn; };

const refreshConfig = async () => {
  try {
    const res = await pool.query(
      "SELECT key, value FROM system_config WHERE key IN ('log_level','log_db_enabled','log_file_enabled','log_socket_enabled')"
    );
    res.rows.forEach(({ key, value }) => {
      if (key === 'log_level')          _config.level         = value;
      if (key === 'log_db_enabled')     _config.dbEnabled     = value === 'true';
      if (key === 'log_file_enabled')   _config.fileEnabled   = value === 'true';
      if (key === 'log_socket_enabled') _config.socketEnabled = value === 'true';
    });
    // Apply new level to winston
    winstonLogger.level = _config.level;
  } catch {
    // Config refresh failure is silent — keep using cached values
  }
};

// Refresh config on startup + every 60 seconds
refreshConfig();
setInterval(refreshConfig, 60_000);

// ── Winston setup ─────────────────────────────────────────────────────────────
const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, service, category, duration_ms }) => {
    const parts = [`[${timestamp}]`, level, `[${service || 'api'}/${category || 'general'}]`, message];
    if (duration_ms !== undefined) parts.push(`(${duration_ms}ms)`);
    return parts.join(' ');
  })
);

const winstonLogger = winston.createLogger({  
  level: _config.level,
  format: jsonFormat,
  transports: [
    // Console — always on, colored for dev
    new winston.transports.Console({ format: consoleFormat }),


    // Daily rotating file — 14 day retention, 20MB max per file
    /* REMOVE OR COMMENT OUT THE FILE LOGGERS FOR RENDER
    new DailyRotateFile({
      dirname:     LOG_DIR,
      filename:    'btd-api-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles:    '14d',
      maxSize:     '20m',
      zippedArchive: true,
    }),

    // Error-only file — quick access to just errors
    new DailyRotateFile({
      dirname:     LOG_DIR,
      filename:    'btd-api-errors-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles:    '30d',
      maxSize:     '10m',
      level:       'error',
      zippedArchive: true,
    }),
    */
  ],
});

// ── DB writer (async, fire-and-forget) ───────────────────────────────────────
const writeToDb = (entry) => {
  // Skip logging the log intake endpoint itself — breaks feedback loop
  if (entry.message?.includes('/api/logs') && entry.category === 'http') return;
  if (!_config.dbEnabled) return;
  // setImmediate pushes this to the next iteration of the event loop
  // so it NEVER blocks the current request/response
  setImmediate(async () => {
    try {
      await pool.query(
        `INSERT INTO logs (ts, level, service, category, message, meta, user_id, device_id, session_id, ip_address, duration_ms, status_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          entry.ts || new Date(),
          entry.level,
          entry.service     || 'api',
          entry.category    || 'general',
          entry.message,
          entry.meta        ? JSON.stringify(entry.meta) : null,
          entry.user_id     || null,
          entry.device_id   || null,
          entry.session_id  || null,
          entry.ip_address  || null,
          entry.duration_ms || null,
          entry.status_code || null,
        ]
      );
    } catch {
      // DB write failure is silent — file log still has the record
    }
  });
};

// ── Socket emitter — synchronous for real-time live tail ─────────────────────
// No setImmediate here — we want live tail to feel instant
// DB write is still async (setImmediate) so this never blocks requests
const emitToSocket = (entry) => {
  if (!_config.socketEnabled || !_socketEmitter) return;
  try {
    _socketEmitter('new-log', entry);
  } catch {
    // Silent — socket failure never affects logging
  }
};

// ── Public logger API ─────────────────────────────────────────────────────────
// Usage: logger.info('User punched in', { category: 'attendance', user_id: 'EMP001', meta: { site: 'DXB30' } })

const LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'];

const createLogFn = (level) => (message, options = {}) => {
  const { category = 'general', user_id, device_id, session_id, ip_address, duration_ms, status_code, meta, service = 'api' } = options;

  const entry = {
    ts: new Date().toISOString(), // matches DB column name — consistent with REST API response
    level,
    service,
    category,
    message: typeof message === 'string' ? message : JSON.stringify(message),
    meta,
    user_id,
    device_id,
    session_id,
    ip_address,
    duration_ms,
    status_code,
  };

  // winston handles file + console (sync-safe)
  const wLevel = level === 'fatal' ? 'error' : level;
  winstonLogger[wLevel](message, { service, category, duration_ms, status_code, ...meta });

  // DB + socket are fire-and-forget
  writeToDb(entry);
  emitToSocket(entry);
};

const logger = Object.fromEntries(LEVELS.map(l => [l, createLogFn(l)]));

// 'action' is a convenience alias for info with category='action'
// Used to log user-initiated events like saves, deletes, role changes
logger.action = (message, opts = {}) => {
  createLogFn('info')(message, { ...opts, category: opts.category || 'action' });
};

// 'attendance' convenience logger
logger.attendance = (type, name, site, success) => {
  createLogFn('info')(
    `Attendance ${type}: ${name} at ${site || 'unknown'} — ${success ? 'success' : 'failed'}`,
    { category: 'attendance' }
  );
};

// ── Convenience: log uncaught exceptions and unhandled rejections ─────────────
process.on('uncaughtException', (err) => {
  logger.fatal(`Uncaught Exception: ${err.message}`, {
    category: 'crash',
    meta: { stack: err.stack, name: err.name },
  });
  // Give winston time to flush before exit
  setTimeout(() => process.exit(1), 500);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled Promise Rejection: ${reason}`, {
    category: 'crash',
    meta: { reason: String(reason) },
  });
});

export default logger;