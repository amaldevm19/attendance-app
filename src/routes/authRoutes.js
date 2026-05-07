import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from '../config/db.js';
import logger from '../logger.js';
import dotenv from 'dotenv';
dotenv.config();

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key_here';

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const result = await pool.query('SELECT * FROM employees WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      logger.warn(`Login failed — no account for email: ${email}`, {
        category: 'auth', meta: { email },
      });
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const employee = result.rows[0];
    if (!employee.password) {
      logger.warn(`Login failed — password not set for: ${email}`, {
        category: 'auth', user_id: employee.emp_id, meta: { email },
      });
      return res.status(401).json({ error: 'Password not set. Contact your Admin.' });
    }

    const isValid = await bcrypt.compare(password, employee.password);
    if (!isValid) {
      logger.warn(`Login failed — wrong password for: ${email}`, {
        category: 'auth', user_id: employee.emp_id, meta: { email },
      });
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    if (!employee.role_id) {
      logger.warn(`Login failed — no role assigned for: ${email}`, {
        category: 'auth', user_id: employee.emp_id, meta: { email },
      });
      return res.status(403).json({ error: 'No role assigned. Contact your Admin.' });
    }

    // Fetch role + permissions
    const roleResult = await pool.query(`
      SELECT r.name AS role_name, p.name AS permission
      FROM roles r
      LEFT JOIN role_permissions rp ON r.id = rp.role_id
      LEFT JOIN permissions p ON rp.permission_id = p.id
      WHERE r.id = $1
    `, [employee.role_id]);

    const permissions = roleResult.rows.map(r => r.permission).filter(Boolean);
    const roleName    = roleResult.rows[0]?.role_name || 'Technician';

    const token = jwt.sign(
      { emp_id: employee.emp_id, name: employee.name, role: roleName, permissions },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    logger.info(`Login success: ${employee.name} (${employee.emp_id}) as ${roleName}`, {
      category: 'auth',
      user_id:  employee.emp_id,
      meta: { email, role: roleName, permission_count: permissions.length },
    });

    res.json({
      token,
      employee: {
        emp_id:      employee.emp_id,
        name:        employee.name,
        email:       employee.email,
        role:        roleName,
        permissions,
      },
    });
  } catch (err) {
    logger.error(`Login error: ${err.message}`, { category: 'auth', meta: { email } });
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── POST /api/auth/change-password (self — requires current password) ─────────
router.post('/change-password', async (req, res) => {
  const { emp_id, currentPassword, newPassword } = req.body;
  if (!emp_id || !currentPassword || !newPassword) {
    return res.status(400).json({ error: 'emp_id, currentPassword and newPassword are required.' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }

  try {
    const result = await pool.query('SELECT password FROM employees WHERE emp_id = $1', [emp_id]);
    if (!result.rows[0]?.password) {
      return res.status(404).json({ error: 'Employee not found or no password set.' });
    }

    const isValid = await bcrypt.compare(currentPassword, result.rows[0].password);
    if (!isValid) {
      logger.warn(`Password change failed — wrong current password: ${emp_id}`, {
        category: 'auth', user_id: emp_id,
      });
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE employees SET password = $1 WHERE emp_id = $2', [hashed, emp_id]);

    logger.info(`Password changed by user: ${emp_id}`, { category: 'auth', user_id: emp_id });
    res.json({ success: true, message: 'Password changed successfully.' });
  } catch (err) {
    logger.error(`Change password error: ${err.message}`, { category: 'auth', user_id: emp_id });
    res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;