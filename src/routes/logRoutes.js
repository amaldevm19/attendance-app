// src/routes/logRoutes.js
// Two purposes:
//   POST /api/logs        — intake from mobile + admin frontend (batched)
//   GET  /api/logs        — query logs for admin dashboard
//   GET  /api/logs/config — read system_config
//   PUT  /api/logs/config — update system_config (admin only)
//   GET  /api/logs/export — CSV export

import express from 'express';
import pool from '../config/db.js';
import logger from '../logger.js';

const router = express.Router();

// ── POST /api/logs — receive batched logs from mobile + admin frontend ────────
// Mobile sends array of events every 30 seconds
// Admin frontend sends on navigation, errors, user events
router.post('/', async (req, res) => {
  const logs = Array.isArray(req.body) ? req.body : [req.body];
  const ip   = req.ip;

  // Validate and sanitize — never trust client data
  const valid = logs.filter(l =>
    l.level && ['debug','info','warn','error','fatal'].includes(l.level) &&
    l.service && ['mobile','admin'].includes(l.service) &&
    l.message && typeof l.message === 'string'
  );

  if (valid.length === 0) return res.status(400).json({ error: 'No valid log entries.' });

  // Batch insert — single query for all logs
  setImmediate(async () => {
    try {
      const values = valid.map((l, i) => {
        const base = i * 11;
        return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11})`;
      }).join(',');

      const params = valid.flatMap(l => [
        l.timestamp ? new Date(l.timestamp) : new Date(),
        l.level,
        l.service,
        l.category    || 'general',
        l.message.substring(0, 2000), // cap message length
        l.meta        ? JSON.stringify(l.meta) : null,
        l.user_id     || null,
        l.device_id   || null,
        l.session_id  || null,
        ip,
        l.duration_ms || null,
      ]);

      await pool.query(
        `INSERT INTO logs (ts,level,service,category,message,meta,user_id,device_id,session_id,ip_address,duration_ms) VALUES ${values}`,
        params
      );
    } catch (err) {
      // File logger still has these — DB failure just means they're not queryable
      logger.warn(`Failed to batch-insert ${valid.length} client logs: ${err.message}`, { category: 'system' });
    }
  });

  // Respond immediately — don't wait for DB write
  res.json({ received: valid.length });
});

// ── GET /api/logs — query logs ────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const {
    level, service, category,
    search, user_id, device_id,
    from, to,
    limit = 100, offset = 0,
  } = req.query;

  const conditions = [];
  const params     = [];
  let   p          = 1;

  if (level)     { conditions.push(`level = $${p++}`);         params.push(level); }
  if (service)   { conditions.push(`service = $${p++}`);       params.push(service); }
  if (category)  { conditions.push(`category = $${p++}`);      params.push(category); }
  if (user_id)   { conditions.push(`user_id = $${p++}`);       params.push(user_id); }
  if (device_id) { conditions.push(`device_id = $${p++}`);     params.push(device_id); }
  if (from)      { conditions.push(`ts >= $${p++}`);           params.push(new Date(from)); }
  if (to)        { conditions.push(`ts <= $${p++}`);           params.push(new Date(to)); }
  if (search)    {
    conditions.push(`(message ILIKE $${p} OR meta::text ILIKE $${p})`);
    params.push(`%${search}%`); p++;
  }

  const where  = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const safeLimit  = Math.min(parseInt(limit)  || 100, 500); // max 500 per page
  const safeOffset = parseInt(offset) || 0;

  try {
    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT id, ts, level, service, category, message, meta, user_id, device_id, ip_address, duration_ms, status_code
         FROM logs ${where} ORDER BY ts DESC LIMIT $${p} OFFSET $${p+1}`,
        [...params, safeLimit, safeOffset]
      ),
      pool.query(`SELECT COUNT(*) FROM logs ${where}`, params),
    ]);

    res.json({
      logs:   dataRes.rows,
      total:  parseInt(countRes.rows[0].count),
      limit:  safeLimit,
      offset: safeOffset,
    });
  } catch (err) {
    logger.error(`Log query failed: ${err.message}`, { category: 'system' });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/logs/stats — summary for dashboard ───────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [byLevel, byService, recentErrors, hourly] = await Promise.all([
      pool.query(`SELECT level, COUNT(*) FROM logs WHERE ts >= NOW() - INTERVAL '24 hours' GROUP BY level`),
      pool.query(`SELECT service, COUNT(*) FROM logs WHERE ts >= NOW() - INTERVAL '24 hours' GROUP BY service`),
      pool.query(`SELECT ts, level, service, category, message FROM logs WHERE level IN ('error','fatal') ORDER BY ts DESC LIMIT 10`),
      pool.query(`
        SELECT DATE_TRUNC('hour', ts) AS hour, level, COUNT(*) AS count
        FROM logs WHERE ts >= NOW() - INTERVAL '24 hours'
        GROUP BY hour, level ORDER BY hour ASC
      `),
    ]);

    res.json({
      by_level:      byLevel.rows,
      by_service:    byService.rows,
      recent_errors: recentErrors.rows,
      hourly:        hourly.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/logs/config — read system_config ─────────────────────────────────
router.get('/config', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM system_config ORDER BY key ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/logs/config — update system_config ───────────────────────────────
router.put('/config', async (req, res) => {
  const { key, value } = req.body;
  if (!key || value === undefined) return res.status(400).json({ error: 'key and value required.' });
  try {
    await pool.query(
      `UPDATE system_config SET value = $1, updated_at = NOW(), updated_by = 'admin'
       WHERE key = $2`,
      [String(value), key]
    );
    logger.info(`System config updated: ${key} = ${value}`, { category: 'system' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/logs/export — CSV download ───────────────────────────────────────
router.get('/export', async (req, res) => {
  const { from, to, level, service } = req.query;
  const conditions = [];
  const params     = [];
  let   p          = 1;
  if (level)   { conditions.push(`level = $${p++}`);   params.push(level); }
  if (service) { conditions.push(`service = $${p++}`); params.push(service); }
  if (from)    { conditions.push(`ts >= $${p++}`);     params.push(new Date(from)); }
  if (to)      { conditions.push(`ts <= $${p++}`);     params.push(new Date(to)); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await pool.query(
      `SELECT ts, level, service, category, message, user_id, device_id, ip_address, duration_ms, status_code
       FROM logs ${where} ORDER BY ts DESC LIMIT 10000`,
      params
    );

    const headers = ['timestamp','level','service','category','message','user_id','device_id','ip_address','duration_ms','status_code'];
    const csv = [
      headers.join(','),
      ...result.rows.map(row =>
        headers.map(h => {
          const val = row[h === 'timestamp' ? 'ts' : h];
          if (val === null || val === undefined) return '';
          const str = String(val).replace(/"/g, '""');
          return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str}"` : str;
        }).join(',')
      )
    ].join('\n');

    const filename = `btd-logs-${new Date().toISOString().split('T')[0]}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);

    logger.info(`Log export: ${result.rows.length} rows`, { category: 'system' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;