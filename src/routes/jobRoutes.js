import express from 'express';
import pool from '../config/db.js';
import { io } from '../server.js';
import logger from '../logger.js';

const router = express.Router();

const MANHOURS_SUBQUERY = (alias = 'j') => `
  COALESCE((
    SELECT ROUND(EXTRACT(EPOCH FROM SUM(paired.out_time - paired.in_time)) / 3600.0, 2)
    FROM (
      SELECT al_in.employee_id, al_in.log_time AS in_time, MIN(al_out.log_time) AS out_time
      FROM attendance_logs al_in
      JOIN attendance_logs al_out
        ON  al_out.employee_id  = al_in.employee_id
        AND al_out.job_id       = al_in.job_id
        AND al_out.action_type  = 'OUT'
        AND al_out.log_time     > al_in.log_time
      WHERE al_in.job_id = ${alias}.id
        AND al_in.action_type = 'IN'
      GROUP BY al_in.employee_id, al_in.log_time
    ) AS paired
  ), 0) AS used_manhours`;

// GET all jobs
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT j.*, jc.code AS category_code, c.name AS client_name,
        sup.name AS supervisor_name, tl.name AS team_lead_name,
        cc.name AS client_category, cr.name AS client_rep_name,
        cr.phone AS client_rep_phone, cr.email AS client_rep_email,
        COALESCE(JSON_AGG(DISTINCT JSONB_BUILD_OBJECT('id', p.id, 'name', p.name)) FILTER (WHERE p.id IS NOT NULL), '[]') AS portfolios,
        COALESCE(JSON_AGG(DISTINCT JSONB_BUILD_OBJECT('id', s.id, 'name', s.name)) FILTER (WHERE s.id IS NOT NULL), '[]') AS systems,
        COALESCE(JSON_AGG(DISTINCT JSONB_BUILD_OBJECT('id', st.id, 'site_name', st.site_name)) FILTER (WHERE st.id IS NOT NULL), '[]') AS sites,
        COALESCE(JSON_AGG(DISTINCT JSONB_BUILD_OBJECT('id', pr.id, 'manufacturer', pr.manufacturer, 'model', pr.model, 'system_id', pr.system_id)) FILTER (WHERE pr.id IS NOT NULL), '[]') AS products,
        ${MANHOURS_SUBQUERY('j')}
      FROM jobs j
      LEFT JOIN job_categories jc ON j.job_category_id = jc.id
      LEFT JOIN clients c ON j.client_id = c.id
      LEFT JOIN client_categories cc ON c.client_category_id = cc.id
      LEFT JOIN client_representatives cr ON j.client_rep_id = cr.id
      LEFT JOIN job_portfolios jp ON j.id = jp.job_id
      LEFT JOIN portfolios p ON jp.portfolio_id = p.id
      LEFT JOIN job_systems js ON j.id = js.job_id
      LEFT JOIN systems s ON js.system_id = s.id
      LEFT JOIN site_jobs sj ON j.id = sj.job_id
      LEFT JOIN sites st ON sj.site_id = st.id
      LEFT JOIN job_products jp2 ON j.id = jp2.job_id
      LEFT JOIN products pr ON jp2.product_id = pr.id
      LEFT JOIN employees sup ON j.supervisor_id = sup.emp_id
      LEFT JOIN employees tl ON j.team_lead_id = tl.emp_id
      GROUP BY j.id, jc.code, c.name, cc.name, cr.name, cr.phone, cr.email, sup.name, tl.name
      ORDER BY j.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    logger.error(`Fetch jobs failed: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// GET single job
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT j.*, jc.code AS category_code, c.name AS client_name, cr.name AS client_rep_name,
        COALESCE(JSON_AGG(DISTINCT JSONB_BUILD_OBJECT('id', p.id, 'name', p.name)) FILTER (WHERE p.id IS NOT NULL), '[]') AS portfolios,
        COALESCE(JSON_AGG(DISTINCT JSONB_BUILD_OBJECT('id', s.id, 'name', s.name)) FILTER (WHERE s.id IS NOT NULL), '[]') AS systems,
        COALESCE(JSON_AGG(DISTINCT JSONB_BUILD_OBJECT('id', st.id, 'site_name', st.site_name)) FILTER (WHERE st.id IS NOT NULL), '[]') AS sites
      FROM jobs j
      LEFT JOIN job_categories jc ON j.job_category_id = jc.id
      LEFT JOIN clients c ON j.client_id = c.id
      LEFT JOIN client_representatives cr ON j.client_rep_id = cr.id
      LEFT JOIN job_portfolios jp ON j.id = jp.job_id
      LEFT JOIN portfolios p ON jp.portfolio_id = p.id
      LEFT JOIN job_systems js ON j.id = js.job_id
      LEFT JOIN systems s ON js.system_id = s.id
      LEFT JOIN site_jobs sj ON j.id = sj.job_id
      LEFT JOIN sites st ON sj.site_id = st.id
      WHERE j.id = $1
      GROUP BY j.id, jc.code, c.name, cr.name
    `, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Job not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error(`Fetch job ${req.params.id} failed: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// POST create job
router.post('/', async (req, res) => {
  const {
    job_number, job_category_id, job_code, client_id, client_rep_id,
    estimated_manhours, project_value, cost_incurred,
    supervisor_id, team_lead_id,
    portfolio_ids = [], system_ids = [], site_ids = [], product_ids = [],
  } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jobRes = await client.query(
      `INSERT INTO jobs (job_number, job_category_id, job_code, client_id, client_rep_id, estimated_manhours, project_value, cost_incurred, supervisor_id, team_lead_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [job_number, job_category_id || null, job_code, client_id || null, client_rep_id || null,
       estimated_manhours || 0, project_value || 0, cost_incurred || 0, supervisor_id || null, team_lead_id || null]
    );
    const jobId = jobRes.rows[0].id;
    for (const pid of portfolio_ids) await client.query('INSERT INTO job_portfolios (job_id, portfolio_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [jobId, pid]);
    for (const sid of system_ids)    await client.query('INSERT INTO job_systems (job_id, system_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [jobId, sid]);
    for (const sid of site_ids)      await client.query('INSERT INTO site_jobs (job_id, site_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [jobId, sid]);
    for (const pid of product_ids)   await client.query('INSERT INTO job_products (job_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [jobId, pid]);
    await client.query('COMMIT');
    io.emit('dashboard-update');
    logger.info(`Job created: ${job_code || job_number}`, {
      category: 'general',
      meta: {
        job_id: jobId, job_code, job_number, client_id, supervisor_id, team_lead_id,
        estimated_manhours, project_value,
        portfolio_count: portfolio_ids.length, site_count: site_ids.length,
      },
    });
    res.status(201).json(jobRes.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`Job creation failed: ${err.message}`, {
      category: 'database', meta: { job_code, job_number, error: err.message },
    });
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH update job
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const {
    job_number, job_category_id, job_code, client_id, client_rep_id,
    estimated_manhours, project_value, cost_incurred,
    portfolio_ids, system_ids, site_ids, product_ids,
    supervisor_id: sv_id, team_lead_id: tl_id,
  } = req.body;
  // Allow explicit null to clear supervisor/TL assignments
  const hasTlInBody  = 'team_lead_id'  in req.body;
  const hasSupInBody = 'supervisor_id' in req.body;
  const current = await pool.query('SELECT client_id FROM jobs WHERE id = $1', [id]);
  const resolvedClientId = 'client_id' in req.body ? client_id : current.rows[0]?.client_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Use COALESCE only when the field is NOT in the request body.
    // When explicitly passed (even as null), use the passed value directly.
    const finalSvId = hasSupInBody ? sv_id : undefined;
    const finalTlId = hasTlInBody  ? tl_id : undefined;
    await client.query(
      `UPDATE jobs SET
         job_number         = COALESCE($1,  job_number),
         job_category_id    = COALESCE($2,  job_category_id),
         job_code           = COALESCE($3,  job_code),
         client_id          = $4,
         client_rep_id      = COALESCE($5,  client_rep_id),
         estimated_manhours = COALESCE($6,  estimated_manhours),
         project_value      = COALESCE($7,  project_value),
         cost_incurred      = COALESCE($8,  cost_incurred),
         supervisor_id      = CASE WHEN $12 THEN $9 ELSE supervisor_id END,
         team_lead_id       = CASE WHEN $13 THEN $10 ELSE team_lead_id END
       WHERE id = $11`,
      [job_number, job_category_id, job_code, resolvedClientId, client_rep_id,
       estimated_manhours, project_value, cost_incurred,
       finalSvId ?? null, finalTlId ?? null, id,
       hasSupInBody, hasTlInBody]
    );
    if (portfolio_ids !== undefined) {
      await client.query('DELETE FROM job_portfolios WHERE job_id = $1', [id]);
      for (const pid of portfolio_ids) await client.query('INSERT INTO job_portfolios (job_id, portfolio_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, pid]);
    }
    if (system_ids !== undefined) {
      await client.query('DELETE FROM job_systems WHERE job_id = $1', [id]);
      for (const sid of system_ids) await client.query('INSERT INTO job_systems (job_id, system_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, sid]);
    }
    if (site_ids !== undefined) {
      await client.query('DELETE FROM site_jobs WHERE job_id = $1', [id]);
      for (const sid of site_ids) await client.query('INSERT INTO site_jobs (job_id, site_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, sid]);
    }
    if (product_ids !== undefined) {
      await client.query('DELETE FROM job_products WHERE job_id = $1', [id]);
      for (const pid of product_ids) await client.query('INSERT INTO job_products (job_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, pid]);
    }
    await client.query('COMMIT');
    io.emit('dashboard-update');
    logger.info(`Job updated: id ${id}`, {
      category: 'general',
      meta: { job_id: id, updated_fields: Object.keys(req.body).filter(k => req.body[k] !== undefined) },
    });
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`Job update failed for id ${id}: ${err.message}`, { category: 'database', meta: { error: err.message } });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE job
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    const jobRes = await pool.query('SELECT job_code, job_number FROM jobs WHERE id = $1', [id]);
    const { job_code, job_number } = jobRes.rows[0] || {};
    await client.query('BEGIN');
    await client.query('DELETE FROM job_portfolios WHERE job_id = $1', [id]);
    await client.query('DELETE FROM job_systems WHERE job_id = $1', [id]);
    await client.query('DELETE FROM job_products WHERE job_id = $1', [id]);
    await client.query('DELETE FROM site_jobs WHERE job_id = $1', [id]);
    await client.query('DELETE FROM jobs WHERE id = $1', [id]);
    await client.query('COMMIT');
    io.emit('dashboard-update');
    logger.warn(`Job deleted: ${job_code || job_number || id} (id: ${id})`, {
      category: 'general', meta: { job_id: id, job_code, job_number },
    });
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`Job deletion failed for id ${id}: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export default router;