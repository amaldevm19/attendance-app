import express from 'express';
import pool from '../config/db.js';
import { io } from '../server.js';
import logger from '../logger.js';

const router = express.Router();

// GET all clients
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, cc.name AS category_name,
        COUNT(DISTINCT cr.id) AS rep_count,
        COUNT(DISTINCT j.id)  AS job_count,
        COALESCE(JSON_AGG(DISTINCT JSONB_BUILD_OBJECT('id', cr.id, 'name', cr.name, 'designation', cr.designation, 'email', cr.email, 'phone', cr.phone)) FILTER (WHERE cr.id IS NOT NULL), '[]') AS representatives
      FROM clients c
      LEFT JOIN client_categories cc ON c.client_category_id = cc.id
      LEFT JOIN client_representatives cr ON cr.client_id = c.id
      LEFT JOIN jobs j ON j.client_id = c.id
      GROUP BY c.id, cc.name ORDER BY c.name ASC
    `);
    const clientIds = result.rows.map(c => c.id);
    let jobsByClient = {};
    if (clientIds.length > 0) {
      const jobsResult = await pool.query(`
        SELECT j.*, jc.code AS category_code, cr.name AS client_rep_name, cr.designation AS client_rep_designation, cr.phone AS client_rep_phone,
          COALESCE(JSON_AGG(DISTINCT JSONB_BUILD_OBJECT('id', s.id, 'site_name', s.site_name)) FILTER (WHERE s.id IS NOT NULL), '[]') AS sites,
          COALESCE((
            SELECT ROUND(EXTRACT(EPOCH FROM SUM(paired.out_time - paired.in_time)) / 3600.0, 2)
            FROM (
              SELECT al_in.employee_id, al_in.log_time AS in_time, MIN(al_out.log_time) AS out_time
              FROM attendance_logs al_in
              JOIN site_jobs sj2 ON al_in.site_id = sj2.site_id
              JOIN attendance_logs al_out ON al_out.employee_id = al_in.employee_id AND al_out.site_id = al_in.site_id AND al_out.action_type = 'OUT' AND al_out.log_time > al_in.log_time
              WHERE sj2.job_id = j.id AND al_in.action_type = 'IN'
              GROUP BY al_in.employee_id, al_in.log_time
            ) AS paired
          ), 0) AS used_manhours
        FROM jobs j
        LEFT JOIN job_categories jc ON j.job_category_id = jc.id
        LEFT JOIN client_representatives cr ON j.client_rep_id = cr.id
        LEFT JOIN site_jobs sj ON sj.job_id = j.id
        LEFT JOIN sites s ON sj.site_id = s.id
        WHERE j.client_id = ANY($1)
        GROUP BY j.id, jc.code, cr.name, cr.designation, cr.phone ORDER BY j.created_at DESC
      `, [clientIds]);
      jobsResult.rows.forEach(job => {
        if (!jobsByClient[job.client_id]) jobsByClient[job.client_id] = [];
        jobsByClient[job.client_id].push(job);
      });
    }
    res.json(result.rows.map(c => ({ ...c, jobs: jobsByClient[c.id] || [] })));
  } catch (err) {
    logger.error(`Fetch clients failed: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// GET single client
router.get('/:id', async (req, res) => {
  try {
    const [clientRes, jobsRes, repsRes] = await Promise.all([
      pool.query(`SELECT c.*, cc.name AS category_name FROM clients c LEFT JOIN client_categories cc ON c.client_category_id = cc.id WHERE c.id = $1`, [req.params.id]),
      pool.query(`SELECT j.*, jc.code AS category_code, COALESCE(JSON_AGG(DISTINCT JSONB_BUILD_OBJECT('id', st.id, 'site_name', st.site_name)) FILTER (WHERE st.id IS NOT NULL), '[]') AS sites FROM jobs j LEFT JOIN job_categories jc ON j.job_category_id = jc.id LEFT JOIN site_jobs sj ON sj.job_id = j.id LEFT JOIN sites st ON sj.site_id = st.id WHERE j.client_id = $1 GROUP BY j.id, jc.code ORDER BY j.created_at DESC`, [req.params.id]),
      pool.query('SELECT * FROM client_representatives WHERE client_id = $1 ORDER BY name ASC', [req.params.id]),
    ]);
    if (!clientRes.rows[0]) return res.status(404).json({ error: 'Client not found.' });
    res.json({ ...clientRes.rows[0], jobs: jobsRes.rows, representatives: repsRes.rows });
  } catch (err) {
    logger.error(`Fetch client ${req.params.id} failed: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// POST create client
router.post('/', async (req, res) => {
  const { name, client_category_id } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Client name required.' });
  try {
    const result = await pool.query(
      'INSERT INTO clients (name, client_category_id) VALUES ($1, $2) RETURNING *',
      [name.trim(), client_category_id || null]
    );
    io.emit('dashboard-update');
    logger.info(`Client created: ${name}`, {
      category: 'general',
      meta: { client_id: result.rows[0].id, name, client_category_id },
    });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error(`Client creation failed: ${err.message}`, { category: 'database', meta: { name } });
    res.status(400).json({ error: err.message });
  }
});

// PATCH update client
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, client_category_id } = req.body;
  try {
    await pool.query(
      'UPDATE clients SET name = COALESCE($1, name), client_category_id = COALESCE($2, client_category_id) WHERE id = $3',
      [name, client_category_id, id]
    );
    io.emit('dashboard-update');
    logger.info(`Client updated: id ${id}`, { category: 'general', meta: { client_id: id, name, client_category_id } });
    res.json({ success: true });
  } catch (err) {
    logger.error(`Client update failed for id ${id}: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE client
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const clientRes = await pool.query('SELECT name FROM clients WHERE id = $1', [id]);
    const name = clientRes.rows[0]?.name || id;
    await pool.query('DELETE FROM client_representatives WHERE client_id = $1', [id]);
    await pool.query('DELETE FROM clients WHERE id = $1', [id]);
    io.emit('dashboard-update');
    logger.warn(`Client deleted: ${name} (id: ${id})`, { category: 'general', meta: { client_id: id, name } });
    res.json({ success: true });
  } catch (err) {
    logger.error(`Client deletion failed for id ${id}: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// GET reps for a client
router.get('/:id/reps', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM client_representatives WHERE client_id = $1 ORDER BY name ASC', [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    logger.error(`Fetch reps failed for client ${req.params.id}: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// POST add rep
router.post('/:id/reps', async (req, res) => {
  const { name, designation, email, phone } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Rep name required.' });
  try {
    const result = await pool.query(
      'INSERT INTO client_representatives (client_id, name, designation, email, phone) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.params.id, name.trim(), designation || null, email || null, phone || null]
    );
    io.emit('dashboard-update');
    logger.info(`Client rep added: ${name} → client ${req.params.id}`, {
      category: 'general',
      meta: { client_id: req.params.id, rep_id: result.rows[0].id, name, designation },
    });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error(`Add rep failed for client ${req.params.id}: ${err.message}`, { category: 'database' });
    res.status(400).json({ error: err.message });
  }
});

// PATCH update rep
router.patch('/reps/:repId', async (req, res) => {
  const { repId } = req.params;
  const { name, designation, email, phone } = req.body;
  try {
    await pool.query(
      `UPDATE client_representatives SET name = COALESCE($1, name), designation = COALESCE($2, designation), email = COALESCE($3, email), phone = COALESCE($4, phone) WHERE id = $5`,
      [name, designation, email, phone, repId]
    );
    io.emit('dashboard-update');
    logger.info(`Client rep updated: id ${repId}`, { category: 'general', meta: { rep_id: repId } });
    res.json({ success: true });
  } catch (err) {
    logger.error(`Rep update failed for id ${repId}: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE rep
router.delete('/reps/:repId', async (req, res) => {
  const { repId } = req.params;
  try {
    const repRes = await pool.query('SELECT name FROM client_representatives WHERE id = $1', [repId]);
    await pool.query('DELETE FROM client_representatives WHERE id = $1', [repId]);
    io.emit('dashboard-update');
    logger.warn(`Client rep deleted: ${repRes.rows[0]?.name || repId} (id: ${repId})`, {
      category: 'general', meta: { rep_id: repId },
    });
    res.json({ success: true });
  } catch (err) {
    logger.error(`Rep deletion failed for id ${repId}: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

export default router;