import express from 'express';
import pool from '../config/db.js';
import { io, connectedDevices } from '../server.js';
import logger from '../logger.js';

const router = express.Router();

// ── Helper: cancel all pending devices for a site ─────────────────────────────
const cancelAllPendingDevices = async (client, site_id, exceptDeviceId = null) => {
  const query = exceptDeviceId
    ? 'SELECT d.device_unique_id FROM pending_site_enrollments pse JOIN devices d ON pse.device_id = d.id WHERE pse.site_id = $1 AND pse.device_id != $2'
    : 'SELECT d.device_unique_id FROM pending_site_enrollments pse JOIN devices d ON pse.device_id = d.id WHERE pse.site_id = $1';
  const params = exceptDeviceId ? [site_id, exceptDeviceId] : [site_id];
  const rows   = await client.query(query, params);
  for (const { device_unique_id } of rows.rows) {
    const socketId = connectedDevices.get(device_unique_id);
    if (socketId) io.to(socketId).emit('cancel-site-task', { site_id });
  }
  return rows.rows.length;
};

// GET all sites
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        s.*,
        l.name AS location_name,
        e.name AS emirate_name,
        COALESCE(cd.friendly_name, cd.device_name) AS gps_captured_by_name,
        emp_req.name AS gps_requested_by_name,
        COALESCE((
          SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
            'device_id', d2.id, 'name', COALESCE(d2.friendly_name, d2.device_name), 'is_online', d2.is_online
          ))
          FROM pending_site_enrollments pse JOIN devices d2 ON pse.device_id = d2.id WHERE pse.site_id = s.id
        ), '[]') AS pending_devices,
        COALESCE(
          JSONB_AGG(DISTINCT JSONB_BUILD_OBJECT(
            'id', j.id, 'job_code', j.job_code, 'job_number', j.job_number,
            'client_id', j.client_id, 'client_name', c.name, 'portfolio', p.name,
            'team_lead_id', j.team_lead_id, 'team_lead_name', tl.name,
            'supervisor_id', j.supervisor_id, 'supervisor_name', sup.name,
            'estimated_manhours', j.estimated_manhours, 'project_value', j.project_value
          )) FILTER (WHERE j.id IS NOT NULL), '[]'
        ) AS jobs
      FROM sites s
      LEFT JOIN locations  l   ON s.location_id = l.id
      LEFT JOIN emirates   e   ON l.emirate_id  = e.id
      LEFT JOIN devices    cd  ON s.gps_captured_by_device_id = cd.id
      LEFT JOIN employees  emp_req ON s.gps_requested_by_emp_id = emp_req.emp_id
      LEFT JOIN site_jobs  sj  ON s.id = sj.site_id
      LEFT JOIN jobs       j   ON sj.job_id = j.id
      LEFT JOIN clients    c   ON j.client_id = c.id
      LEFT JOIN job_portfolios jp ON j.id = jp.job_id
      LEFT JOIN portfolios p   ON jp.portfolio_id = p.id
      LEFT JOIN employees  tl  ON j.team_lead_id = tl.emp_id
      LEFT JOIN employees  sup ON j.supervisor_id = sup.emp_id
      GROUP BY s.id, l.name, e.name, cd.friendly_name, cd.device_name, emp_req.name
      ORDER BY s.site_name ASC
    `);
    res.json(result.rows);
  } catch (err) {
    logger.error(`Fetch sites failed: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// POST link a job to a site
router.post('/:id/link-job', async (req, res) => {
  const { id } = req.params;
  const { job_id } = req.body;
  if (!job_id) return res.status(400).json({ error: 'job_id required.' });
  try {
    // Check if already linked
    const existing = await pool.query('SELECT 1 FROM site_jobs WHERE site_id=$1 AND job_id=$2', [id, job_id]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'This job is already linked to this site.' });
    }
    await pool.query('INSERT INTO site_jobs (site_id, job_id) VALUES ($1, $2)', [id, job_id]);
    io.emit('dashboard-update');
    logger.info(`Job ${job_id} linked to site ${id}`, { category: 'general', meta: { site_id: id, job_id } });
    res.json({ success: true });
  } catch (err) {
    logger.error(`Link job failed: ${err.message}`, { category: 'database', meta: { site_id: id, job_id } });
    res.status(500).json({ error: err.message });
  }
});

// DELETE unlink a job from a site
router.delete('/:id/unlink-job/:jobId', async (req, res) => {
  const { id, jobId } = req.params;
  try {
    await pool.query('DELETE FROM site_jobs WHERE site_id = $1 AND job_id = $2', [id, jobId]);
    io.emit('dashboard-update');
    logger.info(`Job ${jobId} unlinked from site ${id}`, { category: 'general', meta: { site_id: id, job_id: jobId } });
    res.json({ success: true });
  } catch (err) {
    logger.error(`Unlink job failed: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// POST create new site
router.post('/', async (req, res) => {
  const { site_name, latitude, longitude } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO sites (site_name, latitude, longitude) VALUES ($1, $2, $3) RETURNING *',
      [site_name, latitude, longitude]
    );
    io.emit('dashboard-update');
    logger.info(`Site created: ${site_name}`, {
      category: 'general',
      meta: { site_id: result.rows[0].id, site_name, latitude, longitude },
    });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error(`Site creation failed: ${err.message}`, { category: 'database', meta: { site_name } });
    res.status(400).json({ error: err.message });
  }
});

// PATCH update site
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { site_name, location_id } = req.body;
  try {
    await pool.query(
      `UPDATE sites SET site_name = COALESCE($1, site_name), location_id = $2 WHERE id = $3`,
      [site_name, location_id || null, id]
    );
    io.emit('dashboard-update');
    logger.info(`Site updated: id ${id}`, { category: 'general', meta: { site_id: id, site_name, location_id } });
    res.json({ success: true });
  } catch (err) {
    logger.error(`Site update failed for id ${id}: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// POST trigger GPS enrollment — send to a specific selected device
router.post('/trigger-gps-enrollment', async (req, res) => {
  const { site_id, device_id } = req.body;
  if (!site_id || !device_id) {
    return res.status(400).json({ error: 'site_id and device_id required.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Cancel any previous pending enrollments for this site
    const cancelledCount = await cancelAllPendingDevices(client, site_id);
    await client.query('DELETE FROM pending_site_enrollments WHERE site_id = $1', [site_id]);

    // Verify device exists and is active
    const devRes = await client.query(
      'SELECT id, device_unique_id, friendly_name, device_name FROM devices WHERE id = $1 AND is_active = TRUE',
      [device_id]
    );
    if (devRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Device not found or inactive.' });
    }
    const device = devRes.rows[0];

    // Insert pending enrollment for this specific device
    await client.query(
      'INSERT INTO pending_site_enrollments (site_id, device_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [site_id, device_id]
    );

    await client.query(
      `UPDATE sites SET enrollment_status = 'pending', target_device_id = $1 WHERE id = $2`,
      [device_id, site_id]
    );
    await client.query('COMMIT');

    // Notify device via socket
    const socketId = connectedDevices.get(device.device_unique_id);
    if (socketId) io.to(socketId).emit('new-site-task', { site_id });

    const deviceName = device.friendly_name || device.device_name;
    logger.info(`GPS enrollment triggered for site ${site_id} → device ${deviceName}`, {
      category: 'gps',
      meta: { site_id, device_id, device_name: deviceName, cancelled_previous: cancelledCount },
    });

    io.emit('dashboard-update');
    res.json({
      success: true,
      message: `GPS task sent to ${deviceName}.${socketId ? '' : ' Device is offline — will receive task when online.'}`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`Trigger GPS enrollment failed for site ${site_id}: ${err.message}`, {
      category: 'gps', meta: { site_id, device_id, error: err.message },
    });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST update GPS from mobile — first-capture-wins
router.post('/update-gps', async (req, res) => {
  const { site_id, latitude, longitude, device_unique_id } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Resolve capturing device
    let capturingDeviceId = null;
    if (device_unique_id) {
      const devRes = await client.query('SELECT id FROM devices WHERE device_unique_id = $1', [device_unique_id]);
      capturingDeviceId = devRes.rows[0]?.id || null;
    }
    if (!capturingDeviceId) {
      const pendingRes = await client.query('SELECT device_id FROM pending_site_enrollments WHERE site_id = $1 LIMIT 1', [site_id]);
      capturingDeviceId = pendingRes.rows[0]?.device_id || null;
    }

    // Cancel all other pending devices
    const cancelledCount = await cancelAllPendingDevices(client, site_id, capturingDeviceId);
    await client.query('DELETE FROM pending_site_enrollments WHERE site_id = $1', [site_id]);

    await pool.query(
      `UPDATE sites SET latitude = $1, longitude = $2, enrollment_status = 'completed',
       target_device_id = NULL, gps_enrolled_at = NOW(), gps_captured_by_device_id = $4
       WHERE id = $3`,
      [latitude, longitude, site_id, capturingDeviceId]
    );

    await client.query('COMMIT');

    // Get site name for log
    const siteRes = await pool.query('SELECT site_name FROM sites WHERE id = $1', [site_id]);
    const siteName = siteRes.rows[0]?.site_name || site_id;

    logger.info(`GPS captured for site: ${siteName}`, {
      category: 'gps',
      device_id: device_unique_id,
      meta: {
        site_id, site_name: siteName,
        latitude, longitude,
        capturing_device_id: capturingDeviceId,
        cancelled_devices: cancelledCount,
      },
    });

    io.emit('dashboard-update');
    res.json({ success: true, message: 'Site location updated!' });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`Update GPS failed for site ${site_id}: ${err.message}`, {
      category: 'gps', device_id: device_unique_id,
      meta: { site_id, error: err.message },
    });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE a site
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const siteRes = await pool.query('SELECT site_name FROM sites WHERE id = $1', [id]);
    const siteName = siteRes.rows[0]?.site_name || id;

    await pool.query('DELETE FROM attendance_logs WHERE site_id = $1', [id]);
    await pool.query('DELETE FROM sites WHERE id = $1', [id]);
    io.emit('dashboard-update');

    logger.warn(`Site deleted: ${siteName} (id: ${id})`, {
      category: 'general', meta: { site_id: id, site_name: siteName },
    });

    res.json({ success: true });
  } catch (err) {
    logger.error(`Site deletion failed for id ${id}: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

export default router;