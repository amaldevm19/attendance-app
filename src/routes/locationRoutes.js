import express from 'express';
import pool from '../config/db.js';
import { io } from '../server.js';
import logger from '../logger.js';

const router = express.Router();

// GET all emirates
router.get('/emirates', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM emirates ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    logger.error(`Fetch emirates failed: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// GET all locations
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT l.*, e.name AS emirate_name FROM locations l
      LEFT JOIN emirates e ON l.emirate_id = e.id
      ORDER BY e.name ASC, l.name ASC
    `);
    res.json(result.rows);
  } catch (err) {
    logger.error(`Fetch locations failed: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// POST create location
router.post('/', async (req, res) => {
  const { name, emirate_id } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Location name is required.' });
  try {
    const result = await pool.query(
      'INSERT INTO locations (name, emirate_id) VALUES ($1, $2) RETURNING *',
      [name.trim(), emirate_id || null]
    );
    io.emit('dashboard-update');
    logger.info(`Location created: ${name}`, {
      category: 'general',
      meta: { location_id: result.rows[0].id, name, emirate_id },
    });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error(`Location creation failed: ${err.message}`, { category: 'database', meta: { name } });
    res.status(400).json({ error: err.message });
  }
});

// POST: Bulk import locations from CSV
router.post('/bulk-import', async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ error: 'No rows provided.' });

  const results = [];

  for (const row of rows) {
    try {
      if (!row.name?.trim()) throw new Error('Location name is required');

      let emirate_id = null;
      if (row.emirate?.trim()) {
        const r = await pool.query(
          `SELECT id FROM emirates WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))`,
          [row.emirate.trim()]
        );
        emirate_id = r.rows[0]?.id || null;
      }

      await pool.query(
        'INSERT INTO locations (name, emirate_id) VALUES ($1, $2)',
        [row.name.trim(), emirate_id]
      );

      results.push({ name: row.name, status: 'success' });
    } catch (err) {
      results.push({ name: row.name, status: 'error', error: err.message });
    }
  }

  const successCount = results.filter(r => r.status === 'success').length;
  if (successCount > 0) io.emit('dashboard-update');

  logger.info(`Bulk location import: ${successCount}/${rows.length} created`, {
    category: 'general',
    meta: { total: rows.length, success: successCount, failed: rows.length - successCount },
  });

  res.json({ results });
});

// PATCH update location
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, emirate_id } = req.body;
  try {
    const result = await pool.query(
      'UPDATE locations SET name = COALESCE($1, name), emirate_id = COALESCE($2, emirate_id) WHERE id = $3 RETURNING *',
      [name?.trim(), emirate_id, id]
    );
    io.emit('dashboard-update');
    logger.info(`Location updated: id ${id}`, { category: 'general', meta: { location_id: id, name, emirate_id } });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error(`Location update failed for id ${id}: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE location
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const locRes = await pool.query('SELECT name FROM locations WHERE id = $1', [id]);
    const name = locRes.rows[0]?.name || id;
    await pool.query('DELETE FROM locations WHERE id = $1', [id]);
    io.emit('dashboard-update');
    logger.warn(`Location deleted: ${name} (id: ${id})`, { category: 'general', meta: { location_id: id, name } });
    res.json({ success: true });
  } catch (err) {
    logger.error(`Location deletion failed for id ${id}: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// GET reverse geocode proxy
router.get('/reverse-geocode', async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required.' });
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=en`,
      { headers: { 'User-Agent': 'BTDAttendanceApp/1.0', 'Accept-Language': 'en' } }
    );
    const data = await response.json();
    const suburb = data.address?.suburb || data.address?.neighbourhood || data.address?.quarter || data.address?.district || '';
    const state  = data.address?.state || '';
    res.json({ suggested_location: suburb, suggested_emirate: state, raw: data.address });
  } catch (err) {
    logger.warn(`Reverse geocode failed for (${lat},${lon}): ${err.message}`, { category: 'general', meta: { lat, lon } });
    res.status(500).json({ error: 'Geocoding failed.' });
  }
});

export default router;