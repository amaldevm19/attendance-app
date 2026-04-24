import express from 'express';
import pool from '../config/db.js';

const router = express.Router();

// GET all sites
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sites ORDER BY site_name ASC');
    res.json(result.rows);
  } catch (err) {
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
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;