import express from 'express';
import pool from '../config/db.js';
import authMiddleware from '../middleware/authMiddleware.js';
import logger from '../logger.js';

const router = express.Router();

// All role routes require auth
router.use(authMiddleware);

// ── GET all roles with their permissions ──────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const rolesRes = await pool.query('SELECT * FROM roles ORDER BY id ASC');
    const permsRes = await pool.query(`
      SELECT rp.role_id, p.id, p.name, p.description
      FROM role_permissions rp
      JOIN permissions p ON rp.permission_id = p.id
      ORDER BY p.name ASC
    `);
    const allPermsRes = await pool.query('SELECT * FROM permissions ORDER BY name ASC');

    const roles = rolesRes.rows.map(role => ({
      ...role,
      permissions: permsRes.rows
        .filter(p => p.role_id === role.id)
        .map(p => p.name),
    }));

    res.json({ roles, allPermissions: allPermsRes.rows });
  } catch (err) {
    logger.error(`Fetch roles failed: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// ── PUT update permissions for a role (Admin only) ────────────────────────────
router.put('/:roleId/permissions', async (req, res) => {
  const { roleId } = req.params;
  const { permission_ids = [] } = req.body;

  // Only Admin role (role name check via token) can do this
  if (req.user?.role !== 'Admin') {
    return res.status(403).json({ error: 'Only Admin can modify role permissions.' });
  }

  // Protect Admin role from being modified
  const roleRes = await pool.query('SELECT name FROM roles WHERE id = $1', [roleId]);
  if (roleRes.rows[0]?.name === 'Admin') {
    return res.status(400).json({ error: 'Admin role permissions cannot be modified.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
    for (const pid of permission_ids) {
      await client.query(
        'INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [roleId, pid]
      );
    }
    await client.query('COMMIT');

    logger.action(`Role permissions updated: ${roleRes.rows[0]?.name} (id: ${roleId})`, {
      meta: { role_id: roleId, permission_count: permission_ids.length },
    });

    res.json({ success: true, message: 'Permissions updated.' });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`Update role permissions failed: ${err.message}`, { category: 'database', meta: { role_id: roleId } });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── GET employees with their assigned roles ───────────────────────────────────
router.get('/employees', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT e.emp_id, e.name, e.email, e.designation,
             r.id AS role_id, r.name AS role_name,
             CASE WHEN e.password IS NOT NULL THEN true ELSE false END AS has_password
      FROM employees e
      LEFT JOIN roles r ON e.role_id = r.id
      ORDER BY r.name ASC NULLS LAST, e.name ASC
    `);
    res.json(result.rows);
  } catch (err) {
    logger.error(`Fetch role employees failed: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH assign role to employee (Admin only) ────────────────────────────────
router.patch('/employees/:empId', async (req, res) => {
  const { empId } = req.params;
  const { role_id } = req.body;

  if (req.user?.role !== 'Admin') {
    return res.status(403).json({ error: 'Only Admin can assign roles.' });
  }

  try {
    await pool.query('UPDATE employees SET role_id = $1 WHERE emp_id = $2', [role_id || null, empId]);
    const roleRes = await pool.query('SELECT name FROM roles WHERE id = $1', [role_id]);
    logger.action(`Role assigned: ${empId} → ${roleRes.rows[0]?.name || 'none'}`, {
      meta: { emp_id: empId, role_id, role_name: roleRes.rows[0]?.name },
    });
    res.json({ success: true });
  } catch (err) {
    logger.error(`Assign role failed for ${empId}: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// ── POST set/reset password for any employee (Admin only) ────────────────────
router.post('/employees/:empId/set-password', async (req, res) => {
  const { empId } = req.params;
  const { password } = req.body;

  if (req.user?.role !== 'Admin') {
    return res.status(403).json({ error: 'Only Admin can set passwords.' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  try {
    const bcrypt = await import('bcryptjs');
    const hashed = await bcrypt.default.hash(password, 10);
    await pool.query('UPDATE employees SET password = $1 WHERE emp_id = $2', [hashed, empId]);
    const empRes = await pool.query('SELECT name FROM employees WHERE emp_id = $1', [empId]);
    logger.warn(`Password set by admin for: ${empRes.rows[0]?.name} (${empId})`, {
      category: 'auth', user_id: empId,
      meta: { set_by: req.user?.emp_id },
    });
    res.json({ success: true, message: 'Password updated.' });
  } catch (err) {
    logger.error(`Set password failed for ${empId}: ${err.message}`, { category: 'auth' });
    res.status(500).json({ error: err.message });
  }
});

export default router;