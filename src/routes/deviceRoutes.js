import express from 'express';
import pool from '../config/db.js';
import { io, connectedDevices } from '../server.js';
import logger from '../logger.js';

const router = express.Router();

// GET all registered devices
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.*,
        (SELECT COUNT(*) FROM employee_devices ed WHERE ed.device_id = d.id) as linked_employees
      FROM devices d ORDER BY d.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    logger.error(`Failed to fetch devices: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// Register or Check Device
router.post('/register', async (req, res) => {
  const { device_unique_id, device_name } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO devices (device_unique_id, device_name) VALUES ($1, $2) ON CONFLICT (device_unique_id) DO UPDATE SET device_name = $2 RETURNING *',
      [device_unique_id, device_name]
    );
    res.status(200).json(result.rows[0]);
  } catch (err) {
    logger.error(`Device register failed: ${err.message}`, { category: 'auth', device_id: device_unique_id });
    res.status(500).json({ error: err.message });
  }
});

// Assign Employee to Device
router.post('/assign', async (req, res) => {
  const { employee_id, device_id } = req.body;
  try {
    await pool.query(
      'INSERT INTO employee_devices (employee_id, device_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [employee_id, device_id]
    );
    io.emit('dashboard-update');
    res.json({ success: true, message: 'Employee assigned to device' });
  } catch (err) {
    logger.error(`Device assign failed: ${err.message}`, { category: 'auth', user_id: employee_id });
    res.status(500).json({ error: err.message });
  }
});

// Get Employees for a specific Device
router.get('/:deviceId/employees', async (req, res) => {
  const { deviceId } = req.params;
  try {
    const result = await pool.query(`
      SELECT e.emp_id, e.name, e.face_descriptor, e.designation 
      FROM employees e
      JOIN employee_devices ed ON e.emp_id = ed.employee_id
      JOIN devices d ON ed.device_id = d.id
      WHERE d.device_unique_id = $1
    `, [deviceId]);
    res.json(result.rows);
  } catch (err) {
    logger.error(`Fetch employees for device failed: ${err.message}`, { category: 'database', device_id: deviceId });
    res.status(500).json({ error: err.message });
  }
});

// Activate device and link employee
router.post('/activate', async (req, res) => {
  const { employee_id, device_unique_id, device_name } = req.body;
  try {
    const empCheck = await pool.query('SELECT name FROM employees WHERE emp_id = $1', [employee_id]);
    if (empCheck.rows.length === 0) {
      logger.warn(`Device activation failed — employee not found: ${employee_id}`, {
        category: 'auth', user_id: employee_id, device_id: device_unique_id,
      });
      return res.status(404).json({ error: 'Employee ID not found in system.' });
    }

    const friendlyName = `${empCheck.rows[0].name}'s Phone`;
    const deviceRes = await pool.query(
      `INSERT INTO devices (device_unique_id, device_name, friendly_name, is_active)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (device_unique_id) DO UPDATE
         SET device_name = $2, friendly_name = COALESCE(devices.friendly_name, $3)
       RETURNING id`,
      [device_unique_id, device_name, friendlyName]
    );
    const device_id = deviceRes.rows[0].id;

    await pool.query(
      'INSERT INTO employee_devices (employee_id, device_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [employee_id, device_id]
    );
    await pool.query(
      "UPDATE employees SET enrollment_status = 'pending', target_enrollment_device_id = $1 WHERE emp_id = $2 AND enrollment_status != 'completed'",
      [device_id, employee_id]
    );
    await pool.query(
      'INSERT INTO pending_enrollments (employee_id, device_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [employee_id, device_id]
    );

    const newSocketId = connectedDevices.get(device_unique_id);
    if (newSocketId) io.to(newSocketId).emit('new-enrollment-task', { employee_id });

    io.emit('dashboard-update');

    logger.info(`Device activated: ${empCheck.rows[0].name} (${employee_id})`, {
      category: 'auth',
      user_id:  employee_id,
      device_id: device_unique_id,
      meta: { device_name, friendly_name: friendlyName, enrollment_triggered: true, socket_notified: !!newSocketId },
    });

    res.json({
      success: true,
      message: `Device activated for ${empCheck.rows[0].name}`,
      employee_name: empCheck.rows[0].name,
      friendly_name: friendlyName,
      enrollment_triggered: true,
    });
  } catch (err) {
    logger.error(`Device activation failed for ${employee_id}: ${err.message}`, {
      category: 'auth', user_id: employee_id, device_id: device_unique_id,
      meta: { error: err.message },
    });
    res.status(500).json({ error: err.message });
  }
});

// Get pending enrollment employees for a device
router.get('/:deviceId/pending-enrollment', async (req, res) => {
  const { deviceId } = req.params;
  try {
    const result = await pool.query(`
      SELECT e.emp_id, e.name, e.designation, e.profile_image
      FROM pending_enrollments pe
      JOIN employees e ON pe.employee_id = e.emp_id
      JOIN devices   d ON pe.device_id   = d.id
      WHERE d.device_unique_id = $1 AND e.enrollment_status = 'pending'
    `, [deviceId]);
    res.json(result.rows);
  } catch (err) {
    logger.error(`Fetch pending enrollment failed: ${err.message}`, { category: 'enrollment', device_id: deviceId });
    res.status(500).json({ error: err.message });
  }
});

// Trigger enrollment — supports multiple devices via pending_enrollments table
router.post('/trigger-enrollment', async (req, res) => {
  const { employee_id, target_device_id, cancel = false } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (cancel) {
      const existing = await client.query(
        'SELECT pe.device_id, d.device_unique_id FROM pending_enrollments pe JOIN devices d ON pe.device_id = d.id WHERE pe.employee_id = $1 AND pe.device_id != $2',
        [employee_id, target_device_id]
      );
      for (const row of existing.rows) {
        const socketId = connectedDevices.get(row.device_unique_id);
        if (socketId) io.to(socketId).emit('cancel-enrollment-task', { employee_id });
      }
      await client.query('DELETE FROM pending_enrollments WHERE employee_id = $1 AND device_id != $2', [employee_id, target_device_id]);

      logger.info(`Enrollment reassigned for ${employee_id} — cancelled ${existing.rows.length} old device(s)`, {
        category: 'enrollment', user_id: employee_id,
        meta: { cancelled_devices: existing.rows.map(r => r.device_unique_id), new_device_id: target_device_id },
      });
    }

    await client.query(
      'INSERT INTO pending_enrollments (employee_id, device_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [employee_id, target_device_id]
    );

    if (cancel) {
      await client.query(
        "UPDATE employees SET enrollment_status = 'pending', target_enrollment_device_id = $1 WHERE emp_id = $2 AND enrollment_status != 'completed'",
        [target_device_id, employee_id]
      );
    } else {
      await client.query(
        "UPDATE employees SET enrollment_status = 'pending' WHERE emp_id = $1 AND enrollment_status != 'completed'",
        [employee_id]
      );
    }

    await client.query('COMMIT');

    const devRes = await pool.query('SELECT device_unique_id FROM devices WHERE id = $1', [target_device_id]);
    const socketId = connectedDevices.get(devRes.rows[0]?.device_unique_id);
    if (socketId) io.to(socketId).emit('new-enrollment-task', { employee_id });

    logger.info(`Enrollment task triggered for ${employee_id} → device ${target_device_id}`, {
      category: 'enrollment', user_id: employee_id,
      meta: { target_device_id, cancel, socket_notified: !!socketId },
    });

    io.emit('dashboard-update');
    res.json({ success: true, message: 'Enrollment task sent to device.' });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`Trigger enrollment failed for ${employee_id}: ${err.message}`, {
      category: 'enrollment', user_id: employee_id,
      meta: { target_device_id, error: err.message },
    });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Add a device to an employee
router.post('/assign-single', async (req, res) => {
  const { employee_id, device_id } = req.body;
  try {
    await pool.query('INSERT INTO employee_devices (employee_id, device_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [employee_id, device_id]);
    io.emit('dashboard-update');
    res.json({ success: true, message: 'Device linked to employee.' });
  } catch (err) {
    logger.error(`Assign-single failed: ${err.message}`, { category: 'auth', user_id: employee_id });
    res.status(500).json({ error: err.message });
  }
});

// Remove a device from an employee
router.post('/unassign-single', async (req, res) => {
  const { employee_id, device_id } = req.body;
  try {
    await pool.query('DELETE FROM employee_devices WHERE employee_id = $1 AND device_id = $2', [employee_id, device_id]);
    io.emit('dashboard-update');
    logger.info(`Device unlinked from employee ${employee_id}`, { category: 'auth', user_id: employee_id, meta: { device_id } });
    res.json({ success: true, message: 'Device unlinked successfully.' });
  } catch (err) {
    logger.error(`Unassign-single failed: ${err.message}`, { category: 'auth', user_id: employee_id });
    res.status(500).json({ error: err.message });
  }
});

// Get team descriptors for a device
router.get('/:deviceId/team-descriptors', async (req, res) => {
  const { deviceId } = req.params;
  try {
    const result = await pool.query(`
      SELECT e.emp_id, e.name, e.face_descriptor 
      FROM employees e
      JOIN employee_devices ed ON e.emp_id = ed.employee_id
      JOIN devices d ON ed.device_id = d.id
      WHERE d.device_unique_id = $1 AND e.enrollment_status = 'completed'
    `, [deviceId]);
    res.json(result.rows);
  } catch (err) {
    logger.error(`Fetch team descriptors failed: ${err.message}`, { category: 'database', device_id: deviceId });
    res.status(500).json({ error: err.message });
  }
});

// Get pending site tasks for a device (junction table)
router.get('/:deviceId/pending-site-tasks', async (req, res) => {
  const { deviceId } = req.params;
  try {
    const result = await pool.query(`
      SELECT s.id, s.site_name
      FROM pending_site_enrollments pse
      JOIN sites   s ON pse.site_id   = s.id
      JOIN devices d ON pse.device_id = d.id
      WHERE d.device_unique_id = $1 AND s.enrollment_status = 'pending'
    `, [deviceId]);
    res.json(result.rows);
  } catch (err) {
    logger.error(`Fetch pending site tasks failed: ${err.message}`, { category: 'database', device_id: deviceId });
    res.status(500).json({ error: err.message });
  }
});

// DELETE Device
router.delete('/:id/:device_unique_id', async (req, res) => {
  const { id, device_unique_id } = req.params;
  const client = await pool.connect();

  const socketId = connectedDevices.get(device_unique_id);
  if (socketId) io.to(socketId).emit('force-unregistered', {});

  logger.warn(`Device deletion initiated: ${device_unique_id} (DB id: ${id})`, {
    category: 'auth', device_id: device_unique_id,
    meta: { device_db_id: id, socket_notified: !!socketId },
  });

  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM employee_devices WHERE device_id = $1', [id]);
    await client.query('UPDATE employees SET target_enrollment_device_id = NULL WHERE target_enrollment_device_id = $1', [id]);
    await client.query('UPDATE sites SET target_device_id = NULL WHERE target_device_id = $1', [id]);
    await client.query('DELETE FROM pending_site_enrollments WHERE device_id = $1', [id]);
    await client.query('DELETE FROM devices WHERE id = $1', [id]);
    await client.query('COMMIT');

    logger.info(`Device deleted: ${device_unique_id}`, {
      category: 'auth', device_id: device_unique_id,
      meta: { device_db_id: id },
    });

    io.emit('dashboard-update');
    res.json({ success: true, message: 'Device removed and assignments cleared.' });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`Device deletion failed for ${device_unique_id}: ${err.message}`, {
      category: 'auth', device_id: device_unique_id,
      meta: { error: err.message },
    });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH: Update friendly name
router.patch('/:id/friendly-name', async (req, res) => {
  const { id } = req.params;
  const { friendly_name } = req.body;
  if (!friendly_name?.trim()) return res.status(400).json({ error: 'Friendly name cannot be empty.' });
  try {
    await pool.query('UPDATE devices SET friendly_name = $1 WHERE id = $2', [friendly_name.trim(), id]);
    io.emit('dashboard-update');
    logger.info(`Device friendly name updated: "${friendly_name}" (id: ${id})`, { category: 'auth', meta: { device_db_id: id, friendly_name } });
    res.json({ success: true, message: 'Friendly name updated.' });
  } catch (err) {
    logger.error(`Friendly name update failed: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// POST: Toggle device active/inactive
router.post('/:id/toggle-active', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `UPDATE devices SET is_active = NOT is_active WHERE id = $1
       RETURNING is_active, device_unique_id, friendly_name, device_name`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Device not found.' });

    const { is_active, device_unique_id, friendly_name, device_name } = result.rows[0];
    const displayName = friendly_name || device_name;

    const socketId = connectedDevices.get(device_unique_id);
    if (socketId) {
      io.to(socketId).emit('device-status-changed', {
        is_active,
        message: is_active
          ? 'Your device has been reactivated. Attendance is enabled.'
          : 'Your device has been deactivated by admin. Attendance is disabled.',
      });
    }

    logger.warn(`Device ${is_active ? 'activated' : 'deactivated'}: ${displayName}`, {
      category: 'auth', device_id: device_unique_id,
      meta: { device_db_id: id, is_active, display_name: displayName, socket_notified: !!socketId },
    });

    io.emit('dashboard-update');
    res.json({ success: true, is_active, message: `Device "${displayName}" is now ${is_active ? 'active' : 'inactive'}.` });
  } catch (err) {
    logger.error(`Toggle device active failed for id ${id}: ${err.message}`, { category: 'auth', meta: { error: err.message } });
    res.status(500).json({ error: err.message });
  }
});

// GET: Online device count
router.get('/online-count', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_online = TRUE) AS online FROM devices
    `);
    res.json({ online: parseInt(result.rows[0].online), total: parseInt(result.rows[0].total) });
  } catch (err) {
    logger.error(`Online count failed: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:deviceId/assigned-employees
// Returns all employees assigned to this device for the attendance selection screen.
router.get('/:deviceId/assigned-employees', async (req, res) => {
  const { deviceId } = req.params;
  try {
    // deviceId here is the device_unique_id (hardware ID from AsyncStorage)
    const result = await pool.query(`
      SELECT
        e.emp_id, e.name, e.designation, e.designation_id,
        ed.is_primary,
        d.device_name, d.friendly_name
      FROM devices d
      JOIN employee_devices ed ON ed.device_id = d.id
      JOIN employees e ON ed.employee_id = e.emp_id
      WHERE d.device_unique_id = $1
        AND d.is_active = TRUE
      ORDER BY ed.is_primary DESC, e.name ASC
    `, [deviceId]);
    res.json(result.rows);
  } catch (err) {
    logger.error(`assigned-employees failed for device ${deviceId}: ${err.message}`, {
      category: 'auth',
    });
    res.status(500).json({ error: err.message });
  }
});

export default router;