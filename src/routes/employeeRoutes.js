import express from 'express';
import pool from '../config/db.js';
import { io, connectedDevices } from '../server.js';
import logger from '../logger.js';
import * as faceapi from '@vladmandic/face-api';
import { Canvas, Image, ImageData, loadImage } from 'canvas';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import util from 'util';
import dotenv from 'dotenv';

dotenv.config();
// Replicate __dirname in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!util.isNullOrUndefined) {
    util.isNullOrUndefined = (val) => val === null || val === undefined;
}

const router = express.Router();

const uploadDir = path.join(process.cwd(), 'uploads/profiles');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

const loadModels = async () => {
  const modelPath = path.join(process.cwd(), 'models');
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelPath);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(modelPath);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(modelPath);
  logger.info('Face recognition AI models loaded', { category: 'system' });
};
loadModels();

// GET all employees
router.get('/', async (req, res) => {
  try {
    const query = `
      SELECT
        e.*,
        des.name  AS designation_name,
        des.level AS designation_level,
        mgr.name  AS reports_to_name,
        mgr.designation AS reports_to_designation,
        td.device_name AS target_device_name,
        COALESCE((
          SELECT JSONB_AGG(JSONB_BUILD_OBJECT('id', d2.id, 'name', COALESCE(d2.friendly_name, d2.device_name)))
          FROM pending_enrollments pe JOIN devices d2 ON pe.device_id = d2.id WHERE pe.employee_id = e.emp_id
        ), '[]') AS pending_enrollment_devices,
        COALESCE((
          SELECT JSONB_AGG(
            JSONB_BUILD_OBJECT(
              'id',            dev.id,
              'device_name',   dev.device_name,
              'friendly_name', dev.friendly_name,
              'is_primary',    ed2.is_primary
            ) ORDER BY dev.id
          )
          FROM employee_devices ed2
          JOIN devices dev ON ed2.device_id = dev.id
          WHERE ed2.employee_id = e.emp_id
        ), '[]') AS assigned_devices_full,
        COALESCE(JSONB_AGG(DISTINCT JSONB_BUILD_OBJECT('id', p.id, 'name', p.name)) FILTER (WHERE p.id IS NOT NULL), '[]') AS portfolios,
        COALESCE((
          SELECT JSONB_AGG(JSONB_BUILD_OBJECT('id', p2.id, 'name', p2.name))
          FROM employee_portfolios ep_tl JOIN portfolios p2 ON ep_tl.portfolio_id = p2.id
          WHERE ep_tl.emp_id = COALESCE((SELECT reports_to FROM employees WHERE emp_id = e.reports_to), e.reports_to)
        ), '[]') AS inherited_portfolios
      FROM employees e
      LEFT JOIN designations       des ON e.designation_id = des.id
      LEFT JOIN employees          mgr ON e.reports_to = mgr.emp_id
      LEFT JOIN employee_devices    ed ON e.emp_id = ed.employee_id
      LEFT JOIN devices              d ON ed.device_id = d.id
      LEFT JOIN devices             td ON e.target_enrollment_device_id = td.id
      LEFT JOIN employee_portfolios  ep ON e.emp_id = ep.emp_id
      LEFT JOIN portfolios            p ON ep.portfolio_id = p.id
      GROUP BY e.id, des.name, des.level, mgr.name, mgr.designation, td.device_name
      ORDER BY e.created_at DESC
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    logger.error(`Fetch employees failed: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// POST create new employee
router.post('/', async (req, res) => {
  const { emp_id, name, designation, designation_id, phone, email, reports_to, portfolio_ids = [] } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Auto-assign role based on designation name (Team Lead, Supervisor, Technician)
    let assignedRoleId = null;
    if (designation) {
      const roleMatch = await client.query(
        `SELECT id FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1`,
        [designation]
      );
      assignedRoleId = roleMatch.rows[0]?.id || null;
    }

    const result = await client.query(
      `INSERT INTO employees (emp_id, name, designation, designation_id, phone, email, reports_to, role_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [emp_id, name, designation || null, designation_id || null, phone || null, email || null, reports_to || null, assignedRoleId]
    );
    const newEmpId = result.rows[0].emp_id;

    for (const pid of portfolio_ids) {
      await client.query('INSERT INTO employee_portfolios (emp_id, portfolio_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [newEmpId, pid]);
    }

    let enrollmentDeviceId = null;
    if (reports_to) {
      const managerDevices = await client.query('SELECT device_id FROM employee_devices WHERE employee_id = $1 LIMIT 1', [reports_to]);
      if (managerDevices.rows.length > 0) {
        enrollmentDeviceId = managerDevices.rows[0].device_id;
        await client.query('INSERT INTO employee_devices (employee_id, device_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [newEmpId, enrollmentDeviceId]);
        await client.query("UPDATE employees SET enrollment_status = 'pending', target_enrollment_device_id = $1 WHERE emp_id = $2", [enrollmentDeviceId, newEmpId]);
        await client.query('INSERT INTO pending_enrollments (employee_id, device_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [newEmpId, enrollmentDeviceId]);
        const devRes = await client.query('SELECT device_unique_id FROM devices WHERE id = $1', [enrollmentDeviceId]);
        const socketId = connectedDevices.get(devRes.rows[0]?.device_unique_id);
        if (socketId) io.to(socketId).emit('new-enrollment-task', { employee_id: newEmpId });
      }
    }

    await client.query('COMMIT');
    io.emit('dashboard-update');

    logger.info(`Employee created: ${name} (${emp_id})`, {
      category: 'auth', user_id: emp_id,
      meta: { name, designation, reports_to, enrollment_device_id: enrollmentDeviceId, portfolio_count: portfolio_ids.length },
    });

    // Seed default score components for new employee (fire-and-forget)
    fetch(`http://localhost:${process.env.PORT || 3000}/api/assessment/seed-employee-components/${emp_id}`, {
      method: 'POST',
    }).catch(e => logger.warn(`Score component seeding failed for ${emp_id}: ${e.message}`, { category: 'assessment' }));

    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`Employee creation failed for ${emp_id}: ${err.message}`, {
      category: 'auth', user_id: emp_id, meta: { error: err.message },
    });
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST: Bulk import employees from CSV
router.post('/bulk-import', async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ error: 'No rows provided.' });

  const results = [];

  for (const row of rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const dup = await client.query('SELECT emp_id FROM employees WHERE emp_id = $1', [row.emp_id]);
      if (dup.rows.length > 0) throw new Error('Employee ID already exists');

      let designation_id = null, designation_name = row.designation?.trim() || null;
      if (designation_name) {
        const r = await client.query(
          `SELECT id, name FROM designations WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))`,
          [designation_name]
        );
        if (r.rows[0]) { designation_id = r.rows[0].id; designation_name = r.rows[0].name; }
        else designation_name = null;
      }

      const portfolio_ids = [];
      for (const pName of (row.portfolios || [])) {
        if (!pName?.trim()) continue;
        const r = await client.query(
          `SELECT id FROM portfolios WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))`,
          [pName.trim()]
        );
        if (r.rows[0]) portfolio_ids.push(r.rows[0].id);
      }

      let reports_to = row.reports_to?.trim() || null;
      if (reports_to) {
        const r = await client.query('SELECT emp_id FROM employees WHERE emp_id = $1', [reports_to]);
        if (!r.rows[0]) reports_to = null;
      }

      let role_id = null;
      if (designation_name) {
        const r = await client.query(`SELECT id FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1`, [designation_name]);
        role_id = r.rows[0]?.id || null;
      }

      await client.query(
        `INSERT INTO employees (emp_id, name, designation, designation_id, phone, email, reports_to, role_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [row.emp_id, row.name, designation_name, designation_id, row.phone || null, row.email || null, reports_to, role_id]
      );

      for (const pid of portfolio_ids) {
        await client.query(
          `INSERT INTO employee_portfolios (emp_id, portfolio_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [row.emp_id, pid]
        );
      }

      await client.query('COMMIT');
      results.push({ emp_id: row.emp_id, name: row.name, status: 'success' });

      fetch(`http://localhost:${process.env.PORT || 3000}/api/assessment/seed-employee-components/${row.emp_id}`, { method: 'POST' })
        .catch(() => {});

    } catch (err) {
      await client.query('ROLLBACK');
      results.push({ emp_id: row.emp_id, name: row.name, status: 'error', error: err.message });
    } finally {
      client.release();
    }
  }

  const successCount = results.filter(r => r.status === 'success').length;
  if (successCount > 0) io.emit('dashboard-update');

  logger.info(`Bulk import: ${successCount}/${rows.length} employees created`, {
    category: 'auth',
    meta: { total: rows.length, success: successCount, failed: rows.length - successCount },
  });

  res.json({ results });
});

// POST: Enroll Face (Master Photo)

router.post('/:empId/enroll', async (req, res) => {
  const { empId } = req.params;
  const { image } = req.body;
  const startTime = Date.now();

  // Log Payload Size
  const sizeInBytes = req.get('content-length') || 0;
  console.log(`Payload size: ${sizeInBytes} bytes (${(sizeInBytes / 1024).toFixed(2)} KB)`);

  try {
    // 1. Convert Base64 to Buffer
    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    // 2. AI Detection (using the buffer directly in memory)
    const img = await loadImage(buffer);
    const result = await faceapi.detectSingleFace(img)
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!result) {
      logger.warn(`Enrollment failed - no face: ${empId}`);
      return res.status(400).json({ error: 'No face detected. Try a clearer photo.' });
    }

    // 3. Database Update: Save Buffer to BYTEA and Descriptor to JSON
    const descriptor = Array.from(result.descriptor);
    
    await pool.query(
      `UPDATE employees 
       SET enrollment_status = 'completed', 
           profile_image = $1, 
           face_descriptor = $2 
       WHERE emp_id = $3`,
      [buffer, JSON.stringify(descriptor), empId]
    );

    // 4. Cleanup tasks
    await pool.query('DELETE FROM pending_enrollments WHERE employee_id = $1', [empId]);

    const duration = Date.now() - startTime;
    logger.info(`Face enrollment successful (to DB): ${empId} (${duration}ms)`);

    io.emit('dashboard-update');
    res.json({ success: true, message: 'Enrolled successfully to Database!' });

  } catch (err) {
    console.error("Enrollment Error:", err);
    res.status(500).json({ error: 'AI Processing Failed' });
  }
});



// DELETE Employee
router.delete('/:empId', async (req, res) => {
  const { empId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const empRes = await client.query('SELECT profile_image, name FROM employees WHERE emp_id = $1', [empId]);
    const { profile_image: profilePath, name } = empRes.rows[0] || {};

    await client.query('DELETE FROM employee_devices WHERE employee_id = $1', [empId]);
    await client.query('DELETE FROM attendance_logs WHERE employee_id = $1', [empId]);
    await client.query('DELETE FROM employees WHERE emp_id = $1', [empId]);

    if (profilePath) {
      try {
        const fullPath = path.join(process.cwd(), profilePath);
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      } catch {}
    }

    await client.query('COMMIT');
    io.emit('dashboard-update');

    logger.warn(`Employee deleted: ${name || empId} (${empId})`, {
      category: 'auth', user_id: empId,
      meta: { name, had_profile_image: !!profilePath },
    });

    res.json({ success: true, message: 'Employee and all linked data removed.' });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`Employee deletion failed for ${empId}: ${err.message}`, {
      category: 'auth', user_id: empId, meta: { error: err.message },
    });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH update employee
router.patch('/:empId', async (req, res) => {
  const { empId } = req.params;
  const { name, designation, designation_id, phone, email, reports_to, reset_face, portfolio_ids } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE employees SET name = COALESCE($1, name), designation = COALESCE($2, designation),
       designation_id = COALESCE($3, designation_id), phone = COALESCE($4, phone),
       email = COALESCE($5, email), reports_to = $6 WHERE emp_id = $7`,
      [name, designation, designation_id, phone, email, reports_to || null, empId]
    );

    if (portfolio_ids !== undefined) {
      await client.query('DELETE FROM employee_portfolios WHERE emp_id = $1', [empId]);
      for (const pid of portfolio_ids) {
        await client.query('INSERT INTO employee_portfolios (emp_id, portfolio_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [empId, pid]);
      }
    }

    if (reset_face) {
      const empRes = await client.query('SELECT profile_image FROM employees WHERE emp_id = $1', [empId]);
      const imgPath = empRes.rows[0]?.profile_image;
      if (imgPath) {
        try {
          // imgPath stored as '/uploads/profiles/...' — resolve from project root
          const fullPath = path.join(process.cwd(), imgPath);
          if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        } catch {}
      }
      // Clear face_descriptor AND enrollment_status AND profile_image
      await client.query(
        "UPDATE employees SET enrollment_status = 'none', face_descriptor = NULL, profile_image = NULL WHERE emp_id = $1",
        [empId]
      );
      logger.warn(`Face reset for employee: ${empId}`, {
        category: 'enrollment', user_id: empId,
        meta: { had_image: !!imgPath },
      });
    }

    await client.query('COMMIT');
    io.emit('dashboard-update');

    logger.info(`Employee updated: ${empId}`, {
      category: 'auth', user_id: empId,
      meta: { updated_fields: Object.keys(req.body).filter(k => req.body[k] !== undefined) },
    });

    res.json({ success: true, message: 'Employee updated successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`Employee update failed for ${empId}: ${err.message}`, {
      category: 'auth', user_id: empId, meta: { error: err.message },
    });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST: Add device to employee
router.post('/assign-device', async (req, res) => {
  const { employee_id, device_id, replace = false } = req.body;
  if (!employee_id || !device_id) return res.status(400).json({ error: 'employee_id and device_id required.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (replace) await client.query('DELETE FROM employee_devices WHERE employee_id = $1', [employee_id]);
    await client.query(
      'INSERT INTO employee_devices (employee_id, device_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [employee_id, device_id]
    );
    // NOTE: Primary device is NOT set here.
    // Primary is set only when the employee enters their empId in ActivationPage.js.
    // Admin assigning a device to an employee does not make that device their primary.
    await client.query('COMMIT');
    io.emit('dashboard-update');
    logger.info(`Device assigned to employee ${employee_id}`, {
      category: 'auth', user_id: employee_id, meta: { device_id, replace },
    });
    res.json({ success: true, message: 'Device assigned successfully.' });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`Assign device failed for ${employee_id}: ${err.message}`, { category: 'auth', user_id: employee_id });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST: Set a device as the primary for an employee
// Primary device receives personal notifications (score updates, approval results)
router.post('/set-primary-device', async (req, res) => {
  const { employee_id, device_id } = req.body;
  if (!employee_id || !device_id) return res.status(400).json({ error: 'employee_id and device_id required.' });
  try {
    await pool.query('SELECT set_primary_device($1, $2)', [employee_id, parseInt(device_id)]);
    io.emit('dashboard-update');
    logger.info(`Primary device set: emp=${employee_id} device=${device_id}`, {
      category: 'auth', user_id: employee_id, meta: { device_id },
    });
    res.json({ success: true });
  } catch (err) {
    logger.error(`set-primary-device failed for ${employee_id}: ${err.message}`, { category: 'auth', user_id: employee_id });
    res.status(500).json({ error: err.message });
  }
});

// POST: Remove a specific device from employee
router.post('/unassign-device', async (req, res) => {
  const { employee_id, device_id } = req.body;
  if (!employee_id || !device_id) return res.status(400).json({ error: 'employee_id and device_id required.' });
  try {
    await pool.query('DELETE FROM employee_devices WHERE employee_id = $1 AND device_id = $2', [employee_id, device_id]);
    io.emit('dashboard-update');
    logger.info(`Device unassigned from employee ${employee_id}`, {
      category: 'auth', user_id: employee_id, meta: { device_id },
    });
    res.json({ success: true, message: 'Device removed.' });
  } catch (err) {
    logger.error(`Unassign device failed for ${employee_id}: ${err.message}`, { category: 'auth', user_id: employee_id });
    res.status(500).json({ error: err.message });
  }
});

// POST: Verify Face for Attendance
router.post('/verify-face', async (req, res) => {
  const startTime = Date.now();
  try {
    if (process.env.NODE_ENV === 'development') {
      const sizeInBytes = req.get('content-length') || 0;
      console.log(`verify-face payload: ${(sizeInBytes / 1024).toFixed(2)} KB`);
    }

    const { image, deviceId, empId } = req.body;

    if (!image) return res.status(400).json({ error: 'image required' });
    if (!empId)  return res.status(400).json({ error: 'empId required' });

    // 1. Detect face in submitted image
    const base64Data    = image.replace(/^data:image\/\w+;base64,/, '');
    const buffer        = Buffer.from(base64Data, 'base64');
    const img           = await loadImage(buffer);
    const liveDetection = await faceapi
      .detectSingleFace(img)
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!liveDetection) {
      logger.warn('verify-face — no face detected', {
        category: 'face', device_id: deviceId, user_id: empId,
        duration_ms: Date.now() - startTime,
      });
      return res.status(400).json({ error: 'No face detected. Adjust position and try again.' });
    }

    const liveDesc = liveDetection.descriptor;

    // 2. Fetch ONLY the specified employee's descriptor
    // This is O(1) — one employee, one comparison, fast and secure.
    // Previously looped all device employees — allowed wrong person to be matched.
    const empRes = await pool.query(`
      SELECT e.emp_id, e.name, e.face_descriptor
      FROM employees e
      WHERE e.emp_id = $1
        AND e.enrollment_status = 'completed'
        AND e.face_descriptor IS NOT NULL
    `, [empId]);

    if (!empRes.rows.length) {
      return res.status(404).json({ error: 'Employee not enrolled. Face data not found.' });
    }

    const emp = empRes.rows[0];

    // 3. Compare live descriptor against this employee's stored descriptor only
    const descriptorArray = typeof emp.face_descriptor === 'string'
      ? JSON.parse(emp.face_descriptor)
      : emp.face_descriptor;
    const storedDesc = new Float32Array(descriptorArray);
    const distance   = faceapi.euclideanDistance(liveDesc, storedDesc);

    const duration_ms = Date.now() - startTime;

    if (distance < 0.55) {
      logger.info(`Face verified: ${emp.name} (${emp.emp_id}) dist=${distance.toFixed(3)}`, {
        category: 'face', user_id: emp.emp_id, device_id: deviceId,
        duration_ms, meta: { distance },
      });
      res.json({ success: true, employee: { emp_id: emp.emp_id, name: emp.name, distance } });
    } else {
      logger.warn(`Face mismatch for ${emp.emp_id} — dist=${distance.toFixed(3)} (threshold 0.55)`, {
        category: 'face', device_id: deviceId,
        duration_ms, meta: { distance, emp_id: empId },
      });
      res.status(401).json({ error: 'Face not recognized. Please try again.' });
    }
  } catch (err) {
    logger.error(`verify-face error: ${err.message}`, {
      category: 'face',
      duration_ms: Date.now() - startTime,
      meta: { error: err.message },
    });
    res.status(500).json({ error: 'Face processing failed.' });
  }
});

// GET: Fetch Employee Profile Photo from DB
router.get('/:empId/photo', async (req, res) => {
  try {
    const { empId } = req.params;
    const result = await pool.query(
      'SELECT profile_image FROM employees WHERE emp_id = $1', 
      [empId]
    );

    if (result.rows.length > 0 && result.rows[0].profile_image) {
      // Set the header so the browser knows how to render it
      res.set('Content-Type', 'image/jpeg');
      // Send the raw binary buffer
      res.send(result.rows[0].profile_image);
    } else {
      res.status(404).json({ error: 'Photo not found' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;