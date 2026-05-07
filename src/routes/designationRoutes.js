import express from 'express';
import pool from '../config/db.js';
import { io } from '../server.js';
import logger from '../logger.js';

const router = express.Router();

// GET all designations
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM designations ORDER BY level ASC, name ASC');
    res.json(result.rows);
  } catch (err) {
    logger.error(`Fetch designations failed: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// POST create designation
router.post('/', async (req, res) => {
  const { name, level } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required.' });
  if (![1, 2, 3].includes(Number(level))) return res.status(400).json({ error: 'Level must be 1, 2 or 3.' });
  try {
    const result = await pool.query(
      'INSERT INTO designations (name, level) VALUES ($1, $2) RETURNING *',
      [name.trim(), Number(level)]
    );
    io.emit('dashboard-update');
    logger.info(`Designation created: ${name} (level ${level})`, {
      category: 'general',
      meta: { designation_id: result.rows[0].id, name, level },
    });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error(`Designation creation failed: ${err.message}`, { category: 'database', meta: { name, level } });
    res.status(400).json({ error: err.message });
  }
});

// PATCH update designation
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, level } = req.body;
  try {
    const result = await pool.query(
      `UPDATE designations SET name = COALESCE($1, name), level = COALESCE($2, level) WHERE id = $3 RETURNING *`,
      [name?.trim(), level ? Number(level) : null, id]
    );
    io.emit('dashboard-update');
    logger.info(`Designation updated: id ${id}`, { category: 'general', meta: { designation_id: id, name, level } });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error(`Designation update failed for id ${id}: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE designation
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const desRes = await pool.query('SELECT name, level FROM designations WHERE id = $1', [id]);
    const { name, level } = desRes.rows[0] || {};
    await pool.query('DELETE FROM designations WHERE id = $1', [id]);
    io.emit('dashboard-update');
    logger.warn(`Designation deleted: ${name} level ${level} (id: ${id})`, {
      category: 'general', meta: { designation_id: id, name, level },
    });
    res.json({ success: true });
  } catch (err) {
    logger.error(`Designation deletion failed for id ${id}: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

export default router;