import express from 'express';
import pool from '../config/db.js';
import { io } from '../server.js';
import logger from '../logger.js';

const router = express.Router();

// ── Generic CRUD factory with logging ────────────────────────────────────────
const crudFor = (table, orderBy = 'created_at DESC') => ({
  getAll: async (req, res) => {
    try {
      const result = await pool.query(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
      res.json(result.rows);
    } catch (err) {
      logger.error(`Fetch ${table} failed: ${err.message}`, { category: 'database' });
      res.status(500).json({ error: err.message });
    }
  },
  create: (fields) => async (req, res) => {
    const vals = fields.map(f => req.body[f]);
    const cols = fields.join(', ');
    const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
    try {
      const result = await pool.query(
        `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING *`, vals
      );
      io.emit('dashboard-update');
      logger.info(`${table} created: ${JSON.stringify(Object.fromEntries(fields.map((f,i) => [f, vals[i]])))}`, {
        category: 'general', meta: { table, id: result.rows[0].id, ...Object.fromEntries(fields.map((f,i) => [f, vals[i]])) },
      });
      res.status(201).json(result.rows[0]);
    } catch (err) {
      logger.error(`${table} create failed: ${err.message}`, { category: 'database', meta: { table } });
      res.status(400).json({ error: err.message });
    }
  },
  update: (fields) => async (req, res) => {
    const { id } = req.params;
    const sets = fields.map((f, i) => `${f} = COALESCE($${i + 1}, ${f})`).join(', ');
    const vals = [...fields.map(f => req.body[f] ?? null), id];
    try {
      const result = await pool.query(`UPDATE ${table} SET ${sets} WHERE id = $${vals.length} RETURNING *`, vals);
      io.emit('dashboard-update');
      logger.info(`${table} updated: id ${id}`, { category: 'general', meta: { table, id } });
      res.json(result.rows[0]);
    } catch (err) {
      logger.error(`${table} update failed for id ${id}: ${err.message}`, { category: 'database' });
      res.status(500).json({ error: err.message });
    }
  },
  remove: async (req, res) => {
    const { id } = req.params;
    try {
      await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
      io.emit('dashboard-update');
      logger.warn(`${table} deleted: id ${id}`, { category: 'general', meta: { table, id } });
      res.json({ success: true });
    } catch (err) {
      logger.error(`${table} delete failed for id ${id}: ${err.message}`, { category: 'database' });
      res.status(500).json({ error: err.message });
    }
  },
});

// ── JOB CATEGORIES ───────────────────────────────────────────────────────────
const jc = crudFor('job_categories', 'code ASC');
router.get('/job-categories', jc.getAll);
router.post('/job-categories', jc.create(['code', 'description']));
router.patch('/job-categories/:id', jc.update(['code', 'description']));
router.delete('/job-categories/:id', jc.remove);

// ── CLIENT CATEGORIES ────────────────────────────────────────────────────────
const cc = crudFor('client_categories', 'name ASC');
router.get('/client-categories', cc.getAll);
router.post('/client-categories', cc.create(['name', 'description']));
router.patch('/client-categories/:id', cc.update(['name', 'description']));
router.delete('/client-categories/:id', cc.remove);

// ── PORTFOLIOS ───────────────────────────────────────────────────────────────
const pf = crudFor('portfolios', 'name ASC');
router.get('/portfolios', pf.getAll);
router.post('/portfolios', pf.create(['name', 'description']));
router.patch('/portfolios/:id', pf.update(['name', 'description']));
router.delete('/portfolios/:id', pf.remove);

// ── SYSTEMS ──────────────────────────────────────────────────────────────────
router.get('/systems', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, p.name AS portfolio_name FROM systems s
      LEFT JOIN portfolios p ON s.portfolio_id = p.id
      ORDER BY p.name ASC, s.name ASC
    `);
    res.json(result.rows);
  } catch (err) {
    logger.error(`Fetch systems failed: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});
router.post('/systems', async (req, res) => {
  const { name, description, portfolio_id } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO systems (name, description, portfolio_id) VALUES ($1, $2, $3) RETURNING *',
      [name, description || null, portfolio_id || null]
    );
    io.emit('dashboard-update');
    logger.info(`System created: ${name}`, { category: 'general', meta: { system_id: result.rows[0].id, name, portfolio_id } });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error(`System creation failed: ${err.message}`, { category: 'database', meta: { name } });
    res.status(400).json({ error: err.message });
  }
});
router.patch('/systems/:id', async (req, res) => {
  const { id } = req.params;
  const { name, description, portfolio_id } = req.body;
  try {
    const result = await pool.query(
      `UPDATE systems SET name = COALESCE($1, name), description = COALESCE($2, description), portfolio_id = COALESCE($3, portfolio_id) WHERE id = $4 RETURNING *`,
      [name, description, portfolio_id, id]
    );
    io.emit('dashboard-update');
    logger.info(`System updated: id ${id}`, { category: 'general', meta: { system_id: id } });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error(`System update failed for id ${id}: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});
router.delete('/systems/:id', crudFor('systems').remove);

// ── PRODUCTS ─────────────────────────────────────────────────────────────────
router.get('/products', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT pr.*, s.name AS system_name, p.name AS portfolio_name FROM products pr
      LEFT JOIN systems s ON pr.system_id = s.id
      LEFT JOIN portfolios p ON s.portfolio_id = p.id
      ORDER BY pr.manufacturer ASC, pr.brand ASC, pr.model ASC
    `);
    res.json(result.rows);
  } catch (err) {
    logger.error(`Fetch products failed: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});
router.post('/products', async (req, res) => {
  const { system_id, manufacturer, brand, model, description } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO products (system_id, manufacturer, brand, model, description) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [system_id || null, manufacturer, brand || null, model, description || null]
    );
    io.emit('dashboard-update');
    logger.info(`Product created: ${manufacturer} ${model}`, { category: 'general', meta: { product_id: result.rows[0].id, manufacturer, model, system_id } });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error(`Product creation failed: ${err.message}`, { category: 'database', meta: { manufacturer, model } });
    res.status(400).json({ error: err.message });
  }
});
router.patch('/products/:id', async (req, res) => {
  const { id } = req.params;
  const { system_id, manufacturer, brand, model, description } = req.body;
  try {
    const result = await pool.query(
      `UPDATE products SET system_id = COALESCE($1, system_id), manufacturer = COALESCE($2, manufacturer), brand = COALESCE($3, brand), model = COALESCE($4, model), description = COALESCE($5, description) WHERE id = $6 RETURNING *`,
      [system_id, manufacturer, brand, model, description, id]
    );
    io.emit('dashboard-update');
    logger.info(`Product updated: id ${id}`, { category: 'general', meta: { product_id: id } });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error(`Product update failed for id ${id}: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});
router.delete('/products/:id', crudFor('products').remove);

// ── CLIENTS (reference, lightweight) ─────────────────────────────────────────
router.get('/clients', async (req, res) => {
  try {
    const result = await pool.query(`SELECT c.*, cc.name AS category_name FROM clients c LEFT JOIN client_categories cc ON c.client_category_id = cc.id ORDER BY c.name ASC`);
    res.json(result.rows);
  } catch (err) {
    logger.error(`Fetch ref clients failed: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// ── CLIENT REPRESENTATIVES ────────────────────────────────────────────────────
router.get('/clients/:clientId/reps', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM client_representatives WHERE client_id = $1 ORDER BY name ASC', [req.params.clientId]);
    res.json(result.rows);
  } catch (err) {
    logger.error(`Fetch reps failed for client ${req.params.clientId}: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});
router.post('/clients/:clientId/reps', async (req, res) => {
  const { name, designation, email, phone } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO client_representatives (client_id, name, designation, email, phone) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.params.clientId, name, designation || null, email || null, phone || null]
    );
    io.emit('dashboard-update');
    logger.info(`Rep added to client ${req.params.clientId}: ${name}`, { category: 'general', meta: { client_id: req.params.clientId, name } });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error(`Add rep failed: ${err.message}`, { category: 'database' });
    res.status(400).json({ error: err.message });
  }
});
router.patch('/reps/:id', async (req, res) => {
  const { id } = req.params;
  const { name, designation, email, phone } = req.body;
  try {
    const result = await pool.query(
      `UPDATE client_representatives SET name = COALESCE($1, name), designation = COALESCE($2, designation), email = COALESCE($3, email), phone = COALESCE($4, phone) WHERE id = $5 RETURNING *`,
      [name, designation, email, phone, id]
    );
    io.emit('dashboard-update');
    res.json(result.rows[0]);
  } catch (err) {
    logger.error(`Rep update failed for id ${id}: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});
router.delete('/reps/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM client_representatives WHERE id = $1', [req.params.id]);
    io.emit('dashboard-update');
    logger.warn(`Rep deleted: id ${req.params.id}`, { category: 'general', meta: { rep_id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    logger.error(`Rep deletion failed for id ${req.params.id}: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

export default router;