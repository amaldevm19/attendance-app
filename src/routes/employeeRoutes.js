import express from 'express';
import pool from '../config/db.js';

const router = express.Router();

// GET all employees
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, emp_id, name, created_at FROM employees ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create new employee
router.post('/', async (req, res) => {
  const { emp_id, name, face_descriptor } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO employees (emp_id, name, face_descriptor) VALUES ($1, $2, $3) RETURNING *',
      [emp_id, name, JSON.stringify(face_descriptor)]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;