// =============================================================================
// attendanceRoutes.js — Full Attendance Workflow (v10)
// Replaces the old punch-in / punch-out only file.
// Legacy /punch-in and /punch-out endpoints are kept at the bottom for any
// offline-sync queues still in the field; they will be removed in v11.
// =============================================================================

import express from 'express';
import pool from '../config/db.js';
import { findNearestSite } from '../utils/geoUtils.js';
import { io, connectedDevices } from '../server.js';
import logger from '../logger.js';
import { notifyTL, notifyEmployee, notifyPM } from '../utils/notificationService.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Haversine distance in metres between two lat/lon points.
 */
function haversineMetres(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Emit a socket event to a specific employee's currently connected device.
 * Falls back to a broadcast on the employee room if the device is not in
 * connectedDevices (e.g. the employee has two devices).
 */
function emitToEmployee(empId, event, data) {
  io.to(`emp-${empId}`).emit(event, data);
}

/**
 * Resolve the Team Lead emp_id for a given employee.
 */
/**
 * Returns the TL emp_id for a given employee.
 * If the employee has no reports_to (they ARE the TL / top of chain),
 * falls back to any admin account in the system so approvals never go
 * into a black hole. Returns null only if no admin exists.
 */
async function getTLForEmployee(empId) {
  const res = await pool.query(
    'SELECT reports_to FROM employees WHERE emp_id = $1',
    [empId]
  );
  const tl = res.rows[0]?.reports_to;
  if (tl) return tl;

  // Employee is TL or top of chain — route to admin account
  const adminRes = await pool.query(
    `SELECT e.emp_id FROM employees e
     JOIN roles r ON e.role_id = r.id
     WHERE LOWER(r.name) = 'admin'
     ORDER BY e.created_at ASC
     LIMIT 1`
  );
  return adminRes.rows[0]?.emp_id || null;
}

/**
 * Emit a new-task-available event to the TL's socket room so their mobile
 * badge updates immediately.
 */
async function notifyTLSocket(tlEmpId, event, payload) {
  io.to(`emp-${tlEmpId}`).emit(event, payload);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /attendance/check-status?emp_id=X
// Called every time the mobile app opens the Attendance tile.
// Returns:
//   open_duty_session      — active DUTY session if any
//   open_site_sessions     — array of active SITE sessions
//   pending_correction     — correction_request row if status=pending (employee view)
//   has_stale_session      — true if any session is from a previous calendar day
//   pending_approvals_count— for TL: how many items await their review
// ─────────────────────────────────────────────────────────────────────────────
router.get('/check-status', async (req, res) => {
  const { emp_id } = req.query;
  if (!emp_id) return res.status(400).json({ error: 'emp_id required.' });

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // All active sessions for this employee
    const sessionsRes = await pool.query(`
      SELECT
        s.*,
        si.site_name,
        j.job_code, j.job_number,
        jc.code AS category_code
      FROM active_sessions s
      LEFT JOIN sites si ON s.site_id = si.id
      LEFT JOIN jobs j ON s.job_id = j.id
      LEFT JOIN job_categories jc ON j.job_category_id = jc.id
      WHERE s.employee_id = $1
      ORDER BY s.punched_in_at ASC
    `, [emp_id]);

    const sessions = sessionsRes.rows;
    const dutySession = sessions.find(s => s.session_type === 'duty') || null;
    const siteSessions = sessions.filter(s => s.session_type === 'site');

    // Any session older than today's midnight = stale (forgotten punch)
    const hasStale = sessions.some(
      s => new Date(s.punched_in_at) < today
    );

    // Pending correction submitted by this employee (their own view)
    const corrRes = await pool.query(`
      SELECT cr.*, si.site_name, j.job_code
      FROM correction_requests cr
      LEFT JOIN sites si ON cr.session_site_id = si.id
      LEFT JOIN jobs j ON cr.session_job_id = j.id
      WHERE cr.employee_id = $1 AND cr.status = 'pending'
      ORDER BY cr.created_at DESC
      LIMIT 1
    `, [emp_id]);

    // TL pending approvals count (only relevant if this employee is a TL)
    const approvalRes = await pool.query(`
      SELECT COUNT(*) FROM approval_requests ar
      JOIN employees e ON ar.employee_id = e.emp_id
      WHERE e.reports_to = $1 AND ar.status = 'pending'
    `, [emp_id]);

    res.json({
      open_duty_session:       dutySession,
      open_site_sessions:      siteSessions,
      has_stale_session:       hasStale,
      pending_correction:      corrRes.rows[0] || null,
      pending_approvals_count: parseInt(approvalRes.rows[0].count),
    });
  } catch (err) {
    logger.error(`check-status failed for ${emp_id}: ${err.message}`, {
      category: 'attendance', user_id: emp_id,
    });
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /attendance/duty-start
// Body: { emp_id, latitude, longitude, device_id, log_time? }
// Logic:
//   1. If employee has a home location set, check distance
//   2. location_type = 'home' | 'unauthorized'
//   3. Create duty active_session (session_type='duty', site_id=NULL)
//   4. Insert DUTY_START log
// ─────────────────────────────────────────────────────────────────────────────
router.post('/duty-start', async (req, res) => {
  const { emp_id, latitude, longitude, device_id, log_time } = req.body;
  if (!emp_id || latitude == null || longitude == null) {
    return res.status(400).json({ error: 'emp_id, latitude, longitude required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Location type for duty punches is always 'field' — no home GPS matching.
    // Identity is proven by face scan; timestamp is the audit trail.
    // Travel time is derived analytically: duty_span − sum(site_sessions).
    const locationType = 'field';

    const punchTime = log_time ? new Date(log_time) : new Date();

    // Clear any existing duty session then insert fresh one.
    // This handles: stale sessions after correction approval, duplicate punch attempts.
    // The attendance_log is the audit trail — active_sessions is just current state.
    await client.query(
      `DELETE FROM active_sessions WHERE employee_id = $1 AND session_type = 'duty'`,
      [emp_id]
    );
    await client.query(`
      INSERT INTO active_sessions
        (employee_id, site_id, job_id, session_type, punched_in_at, device_id, latitude, longitude)
      VALUES ($1, NULL, NULL, 'duty', $2, $3, $4, $5)
    `, [emp_id, punchTime, device_id || null, latitude, longitude]);

    // Log the duty start
    await client.query(`
      INSERT INTO attendance_logs
        (employee_id, action_type, log_time, latitude, longitude, location_type, is_approved)
      VALUES ($1, 'DUTY_START', $2, $3, $4, $5, TRUE)
    `, [emp_id, punchTime, latitude, longitude, locationType]);

    await client.query('COMMIT');

    logger.info(`DUTY_START: ${emp_id} [${locationType}]`, {
      category: 'attendance', user_id: emp_id,
      meta: { latitude, longitude, location_type: locationType },
    });

    // NOTE on home detection:
    // locationType = 'home' only when employee.home_latitude/home_longitude are set
    // AND the current GPS is within employee.home_radius metres of those coords.
    // A registered site named "Home" in the sites table is a DIFFERENT concept —
    // it shows on the site card (GPS matched a site), but duty-start location_type
    // is purely based on employee home coords set in the employees table.
    // Employees set their home via: PUT /employees/:id/home-location

    io.emit('dashboard-update');
    res.json({ success: true, location_type: locationType, punch_time: punchTime });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`duty-start failed for ${emp_id}: ${err.message}`, {
      category: 'attendance', user_id: emp_id,
    });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /attendance/duty-end
// Body: { emp_id, latitude, longitude, device_id, log_time?, force? }
// Warns if any SITE sessions still open (unless force=true).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/duty-end', async (req, res) => {
  const { emp_id, latitude, longitude, device_id, log_time, force } = req.body;
  if (!emp_id || latitude == null || longitude == null) {
    return res.status(400).json({ error: 'emp_id, latitude, longitude required.' });
  }

  const client = await pool.connect();
  try {
    // Check for open site sessions
    const openSites = await client.query(
      `SELECT s.id, si.site_name FROM active_sessions s
       LEFT JOIN sites si ON s.site_id = si.id
       WHERE s.employee_id = $1 AND s.session_type = 'site'`,
      [emp_id]
    );

    if (openSites.rows.length > 0 && !force) {
      return res.status(409).json({
        warning: 'open_site_sessions',
        message: 'You still have open site sessions. Close them first or use force=true.',
        open_sites: openSites.rows,
      });
    }

    await client.query('BEGIN');

    const punchTime = log_time ? new Date(log_time) : new Date();

    // Duty end is always 'field' — no GPS matching required.
    const locationType = 'field';

    // Remove duty session
    await client.query(
      `DELETE FROM active_sessions WHERE employee_id = $1 AND session_type = 'duty'`,
      [emp_id]
    );

    // Log duty end
    await client.query(`
      INSERT INTO attendance_logs
        (employee_id, action_type, log_time, latitude, longitude, location_type, is_approved)
      VALUES ($1, 'DUTY_END', $2, $3, $4, $5, TRUE)
    `, [emp_id, punchTime, latitude, longitude, locationType]);

    await client.query('COMMIT');

    logger.info(`DUTY_END: ${emp_id}`, {
      category: 'attendance', user_id: emp_id,
      meta: { latitude, longitude, location_type: locationType },
    });

    io.emit('dashboard-update');
    res.json({ success: true, punch_time: punchTime });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`duty-end failed for ${emp_id}: ${err.message}`, {
      category: 'attendance', user_id: emp_id,
    });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /attendance/site-in
// Renamed from /punch-in. Same logic, new action_type=SITE_IN.
// Body: { emp_id, site_id, job_id?, latitude, longitude, device_id, log_time? }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/site-in', async (req, res) => {
  const { emp_id, site_id, job_id, latitude, longitude, device_id, log_time } = req.body;
  if (!emp_id || !site_id) {
    return res.status(400).json({ error: 'emp_id and site_id required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const punchTime = log_time ? new Date(log_time) : new Date();

    await client.query(`
      INSERT INTO active_sessions
        (employee_id, site_id, job_id, session_type, punched_in_at, device_id, latitude, longitude)
      VALUES ($1, $2, $3, 'site', $4, $5, $6, $7)
      ON CONFLICT DO NOTHING
    `, [emp_id, site_id, job_id || null, punchTime, device_id || null, latitude, longitude]);

    await client.query(`
      INSERT INTO attendance_logs
        (employee_id, action_type, log_time, latitude, longitude, site_id, job_id,
         location_type, is_approved)
      VALUES ($1, 'SITE_IN', $2, $3, $4, $5, $6, 'registered_site', TRUE)
    `, [emp_id, punchTime, latitude, longitude, site_id, job_id || null]);

    await client.query('COMMIT');

    let jobInfo = null;
    if (job_id) {
      const jRes = await pool.query(
        'SELECT job_code, job_number FROM jobs WHERE id = $1', [job_id]
      );
      jobInfo = jRes.rows[0] || null;
    }
    const siteRes = await pool.query('SELECT site_name FROM sites WHERE id = $1', [site_id]);

    logger.info(
      `SITE_IN: ${emp_id} at ${siteRes.rows[0]?.site_name}${jobInfo ? ` [${jobInfo.job_code}]` : ''}`,
      { category: 'attendance', user_id: emp_id, meta: { site_id, job_id, latitude, longitude } }
    );

    io.emit('dashboard-update');
    res.json({ success: true, message: 'Site IN recorded.', job: jobInfo });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`site-in failed for ${emp_id}: ${err.message}`, {
      category: 'attendance', user_id: emp_id,
    });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /attendance/site-out
// Renamed from /punch-out. action_type=SITE_OUT.
// Body: { emp_id, site_id, latitude, longitude, device_id, log_time? }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/site-out', async (req, res) => {
  const { emp_id, site_id, latitude, longitude, device_id, log_time } = req.body;
  if (!emp_id || !site_id) {
    return res.status(400).json({ error: 'emp_id and site_id required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sessionRes = await client.query(
      `SELECT * FROM active_sessions WHERE employee_id = $1 AND site_id = $2 AND session_type = 'site'`,
      [emp_id, site_id]
    );
    const session = sessionRes.rows[0];
    const job_id = session?.job_id || null;

    const punchTime = log_time ? new Date(log_time) : new Date();

    await client.query(`
      INSERT INTO attendance_logs
        (employee_id, action_type, log_time, latitude, longitude, site_id, job_id,
         location_type, is_approved)
      VALUES ($1, 'SITE_OUT', $2, $3, $4, $5, $6, 'registered_site', TRUE)
    `, [emp_id, punchTime, latitude, longitude, site_id, job_id]);

    await client.query(
      `DELETE FROM active_sessions WHERE employee_id = $1 AND site_id = $2 AND session_type = 'site'`,
      [emp_id, site_id]
    );

    await client.query('COMMIT');

    const siteRes = await pool.query('SELECT site_name FROM sites WHERE id = $1', [site_id]);

    logger.info(`SITE_OUT: ${emp_id} at ${siteRes.rows[0]?.site_name}`, {
      category: 'attendance', user_id: emp_id,
      meta: { site_id, job_id, latitude, longitude },
    });

    io.emit('dashboard-update');
    res.json({ success: true, message: 'Site OUT recorded.' });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`site-out failed for ${emp_id}: ${err.message}`, {
      category: 'attendance', user_id: emp_id,
    });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /attendance/special-punch
// For punches from unauthorized locations (survey, purchase, others, forgot).
// Body: {
//   emp_id, latitude, longitude, device_id,
//   action: 'in' | 'out',
//   sub_type: 'site_survey' | 'material_purchase' | 'others' | 'forgot_punch',
//   job_id?,
//   reason
// }
// Inserts log with is_approved=FALSE, creates approval_request, emits to TL.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/special-punch', async (req, res) => {
  const {
    emp_id, latitude, longitude, device_id, log_time,
    action, sub_type, job_id, reason,
  } = req.body;

  if (!emp_id || !action || !sub_type || !reason) {
    return res.status(400).json({
      error: 'emp_id, action (in/out), sub_type, reason required.',
    });
  }

  const actionType = action === 'in' ? 'SPECIAL_IN' : 'SPECIAL_OUT';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const punchTime = log_time ? new Date(log_time) : new Date();

    // Insert unapproved log
    const logRes = await client.query(`
      INSERT INTO attendance_logs
        (employee_id, action_type, log_time, latitude, longitude, site_id, job_id,
         sub_type, location_type, is_approved)
      VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, 'unauthorized', FALSE)
      RETURNING id
    `, [emp_id, actionType, punchTime, latitude, longitude, job_id || null, sub_type]);

    const logId = logRes.rows[0].id;

    // Create approval_request for TL
    const approvalRes = await client.query(`
      INSERT INTO approval_requests
        (employee_id, attendance_log_id, request_type, sub_type, reason, punch_time, job_id)
      VALUES ($1, $2, 'special_punch', $3, $4, $5, $6)
      RETURNING id
    `, [emp_id, logId, sub_type, reason, punchTime, job_id || null]);

    await client.query('COMMIT');

    // Notify TL via socket + notification
    const tlId = await getTLForEmployee(emp_id);
    if (tlId) {
      await notifyTLSocket(tlId, 'new-approval-task', {
        type: 'special_punch',
        approval_id: approvalRes.rows[0].id,
        emp_id,
        sub_type,
        reason,
      });
      // Fire-and-forget notification (don't block response)
      notifyTL(tlId, 'special_punch', { emp_id, sub_type, reason, punch_time: punchTime })
        .catch(e => logger.warn(`TL notify failed: ${e.message}`, { category: 'notification' }));
    }

    logger.info(`SPECIAL_PUNCH ${actionType}: ${emp_id} [${sub_type}]`, {
      category: 'attendance', user_id: emp_id,
      meta: { sub_type, reason, job_id, latitude, longitude },
    });

    res.json({
      success: true,
      message: 'Special punch submitted for TL approval.',
      log_id: logId,
      approval_id: approvalRes.rows[0].id,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`special-punch failed for ${emp_id}: ${err.message}`, {
      category: 'attendance', user_id: emp_id,
    });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /attendance/correction-request
// Employee submits a missed punch-out for an open session.
// Body: {
//   emp_id, open_session_id, proposed_out_time,
//   reason, sub_type: 'forgot_punch' | 'battery_dead' | 'others'
// }
// Closes the active_session optimistically, creates correction_request +
// approval_request, emits to TL.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/correction-request', async (req, res) => {
  const {
    emp_id, open_session_id, proposed_out_time, reason, sub_type,
  } = req.body;

  if (!emp_id || !open_session_id || !proposed_out_time || !reason) {
    return res.status(400).json({
      error: 'emp_id, open_session_id, proposed_out_time, reason required.',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fetch the open session for snapshot
    const sessRes = await client.query(
      'SELECT * FROM active_sessions WHERE id = $1 AND employee_id = $2',
      [open_session_id, emp_id]
    );
    if (!sessRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Active session not found or does not belong to this employee.' });
    }
    const sess = sessRes.rows[0];

    // Create correction_request with session snapshot
    const corrRes = await client.query(`
      INSERT INTO correction_requests
        (employee_id, open_session_id, session_site_id, session_job_id,
         session_punched_in_at, proposed_out_time, reason, sub_type)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `, [
      emp_id, open_session_id,
      sess.site_id, sess.job_id, sess.punched_in_at,
      new Date(proposed_out_time), reason, sub_type || 'forgot_punch',
    ]);

    const corrId = corrRes.rows[0].id;

    // Create unified approval_request for TL queue
    const approvalRes = await client.query(`
      INSERT INTO approval_requests
        (employee_id, correction_request_id, request_type, sub_type,
         reason, punch_time, site_id, job_id)
      VALUES ($1, $2, 'correction', $3, $4, $5, $6, $7)
      RETURNING id
    `, [
      emp_id, corrId,
      sub_type || 'forgot_punch', reason,
      new Date(proposed_out_time),
      sess.site_id, sess.job_id,
    ]);

    // Close the active session optimistically
    await client.query(
      'DELETE FROM active_sessions WHERE id = $1',
      [open_session_id]
    );

    await client.query('COMMIT');

    // Notify TL
    const tlId = await getTLForEmployee(emp_id);
    if (tlId) {
      await notifyTLSocket(tlId, 'new-correction-task', {
        correction_id: corrId,
        approval_id:   approvalRes.rows[0].id,
        emp_id,
        proposed_out_time,
        reason,
      });
      notifyTL(tlId, 'correction', {
        emp_id, proposed_out_time, reason, site_id: sess.site_id,
      }).catch(e => logger.warn(`TL notify failed: ${e.message}`, { category: 'notification' }));
    }

    logger.info(`CORRECTION_REQUEST: ${emp_id} for session ${open_session_id}`, {
      category: 'attendance', user_id: emp_id,
      meta: { proposed_out_time, reason, sub_type },
    });

    res.json({
      success: true,
      message: 'Correction request submitted. Awaiting TL approval.',
      correction_id: corrId,
      approval_id:   approvalRes.rows[0].id,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`correction-request failed for ${emp_id}: ${err.message}`, {
      category: 'attendance', user_id: emp_id,
    });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /attendance/pending-corrections/:empId
// Employee's own submitted corrections that are still pending TL review.
// Used by mobile task queue to show a badge/reminder on the Attendance tile.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/pending-corrections/:empId', async (req, res) => {
  const { empId } = req.params;
  try {
    const result = await pool.query(`
      SELECT cr.id, cr.status, cr.proposed_out_time, cr.reason,
             cr.created_at, si.site_name, j.job_code
      FROM correction_requests cr
      LEFT JOIN sites si ON cr.session_site_id = si.id
      LEFT JOIN jobs j ON cr.session_job_id = j.id
      WHERE cr.employee_id = $1 AND cr.status = 'pending'
      ORDER BY cr.created_at DESC
    `, [empId]);
    res.json(result.rows);
  } catch (err) {
    logger.error(`pending-corrections failed for ${empId}: ${err.message}`, { category: 'attendance' });
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /attendance/pending-approvals/:empId
// For TL: returns all pending corrections + special punches from their team.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/pending-approvals/:empId', async (req, res) => {
  const { empId } = req.params;
  try {
    const result = await pool.query(`
      SELECT
        ar.id AS approval_id,
        ar.request_type,
        ar.sub_type,
        ar.reason,
        ar.punch_time,
        ar.status,
        ar.created_at,
        ar.site_id,
        ar.job_id,
        ar.correction_request_id,
        ar.attendance_log_id,
        e.name  AS employee_name,
        e.emp_id,
        si.site_name,
        j.job_code, j.job_number,
        -- Correction-specific fields
        cr.proposed_out_time,
        cr.session_punched_in_at,
        cr.sub_type AS correction_sub_type
      FROM approval_requests ar
      JOIN employees e ON ar.employee_id = e.emp_id
      LEFT JOIN sites si ON ar.site_id = si.id
      LEFT JOIN jobs j ON ar.job_id = j.id
      LEFT JOIN correction_requests cr ON ar.correction_request_id = cr.id
      WHERE (
        -- Standard: employee reports to this TL
        e.reports_to = $1
        OR
        -- Admin fallback: items where the employee has no TL (they ARE the TL)
        -- and this viewer is an admin role
        (e.reports_to IS NULL AND e.emp_id != $1 AND EXISTS (
          SELECT 1 FROM employees ea
          JOIN roles ra ON ea.role_id = ra.id
          WHERE ea.emp_id = $1 AND LOWER(ra.name) = 'admin'
        ))
      )
        AND ar.status = 'pending'
      ORDER BY ar.created_at ASC
    `, [empId]);

    res.json(result.rows);
  } catch (err) {
    logger.error(`pending-approvals fetch failed for TL ${empId}: ${err.message}`, {
      category: 'attendance',
    });
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /attendance/approve/:requestId
// TL approves or rejects a pending approval_request.
// Body: { approved: bool, tl_comment?, reviewer_emp_id }
//
// On APPROVE:
//   - Update approval_request status = 'approved'
//   - If correction: insert SITE_OUT log with proposed_out_time, update correction_request
//   - If special_punch: update attendance_log is_approved = true
//   - Notify employee
//
// On REJECT:
//   - Update approval_request status = 'rejected'
//   - If correction: insert SITE_OUT log BUT set score_flag = true
//   - If special_punch: set attendance_log score_flag = true
//   - Notify employee + PM
// ─────────────────────────────────────────────────────────────────────────────
router.post('/approve/:requestId', async (req, res) => {
  const { requestId } = req.params;
  const { approved, tl_comment, reviewer_emp_id } = req.body;

  if (reviewer_emp_id == null || approved == null) {
    return res.status(400).json({ error: 'reviewer_emp_id and approved (bool) required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fetch the approval request
    const arRes = await client.query(
      'SELECT * FROM approval_requests WHERE id = $1',
      [requestId]
    );
    if (!arRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Approval request not found.' });
    }
    const ar = arRes.rows[0];

    if (ar.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Request already ${ar.status}.` });
    }

    const newStatus = approved ? 'approved' : 'rejected';
    const scoreFlag = !approved;
    const now = new Date();

    // Update approval_request
    await client.query(`
      UPDATE approval_requests
      SET status = $1, reviewed_by = $2, reviewed_at = $3, tl_comment = $4
      WHERE id = $5
    `, [newStatus, reviewer_emp_id, now, tl_comment || null, requestId]);

    // ── CORRECTION type ───────────────────────────────────────────────────
    if (ar.request_type === 'correction' && ar.correction_request_id) {
      const crRes = await client.query(
        'SELECT * FROM correction_requests WHERE id = $1',
        [ar.correction_request_id]
      );
      const cr = crRes.rows[0];

      // Insert the resolved SITE_OUT log
      const logRes = await client.query(`
        INSERT INTO attendance_logs
          (employee_id, action_type, log_time, site_id, job_id,
           sub_type, location_type, is_approved, approved_by, approved_at, score_flag)
        VALUES ($1, 'SITE_OUT', $2, $3, $4, $5, 'registered_site', $6, $7, $8, $9)
        RETURNING id
      `, [
        ar.employee_id,
        cr.proposed_out_time,
        cr.session_site_id,
        cr.session_job_id,
        cr.sub_type,
        approved,           // is_approved
        reviewer_emp_id,
        now,
        scoreFlag,
      ]);

      // Update correction_request
      await client.query(`
        UPDATE correction_requests
        SET status = $1, reviewed_by = $2, reviewed_at = $3,
            tl_comment = $4, score_flag = $5, resolved_log_id = $6
        WHERE id = $7
      `, [
        newStatus, reviewer_emp_id, now,
        tl_comment || null, scoreFlag,
        logRes.rows[0].id, ar.correction_request_id,
      ]);
    }

    // ── SPECIAL PUNCH type ────────────────────────────────────────────────
    if (ar.request_type === 'special_punch' && ar.attendance_log_id) {
      await client.query(`
        UPDATE attendance_logs
        SET is_approved = $1, approved_by = $2, approved_at = $3, score_flag = $4
        WHERE id = $5
      `, [approved, reviewer_emp_id, now, scoreFlag, ar.attendance_log_id]);
    }

    await client.query('COMMIT');

    // Notifications (fire-and-forget)
    notifyEmployee(ar.employee_id, approved ? 'correction_approved' : 'correction_rejected', {
      tl_comment,
      request_type: ar.request_type,
    }).catch(e => logger.warn(`Employee notify failed: ${e.message}`, { category: 'notification' }));

    if (!approved) {
      // On rejection notify PM as well
      const pmRes = await pool.query(`
        SELECT e2.emp_id, e2.email FROM employees e
        JOIN employees e2 ON e.reports_to = e2.emp_id   -- TL
        JOIN employees e3 ON e2.reports_to = e3.emp_id  -- PM above TL
        WHERE e.emp_id = $1
        LIMIT 1
      `, [ar.employee_id]);
      const pm = pmRes.rows[0];
      if (pm) {
        notifyPM(pm, ar.employee_id, {
          tl_comment, request_type: ar.request_type,
        }).catch(e => logger.warn(`PM notify failed: ${e.message}`, { category: 'notification' }));
      }
    }

    // Notify employee socket
    // approval-result is a personal notification → primary device only
    emitToEmployee(ar.employee_id, 'approval-result', {
      request_id: requestId,
      approved,
      tl_comment,
    }, true);
    io.emit('dashboard-update');

    logger.info(
      `APPROVAL ${newStatus.toUpperCase()}: request ${requestId} by TL ${reviewer_emp_id}`,
      { category: 'attendance', user_id: reviewer_emp_id }
    );

    res.json({ success: true, status: newStatus });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`approve failed for request ${requestId}: ${err.message}`, {
      category: 'attendance',
    });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /attendance/employee-jobs/:empId
// Mobile uses this to populate the job picker in Special Punch flow.
// Returns all jobs assigned to the employee's team lead.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/employee-jobs/:empId', async (req, res) => {
  const { empId } = req.params;
  try {
    const result = await pool.query(`
      SELECT DISTINCT
        j.id, j.job_code, j.job_number,
        jc.code AS category_code,
        c.name  AS client_name
      FROM jobs j
      LEFT JOIN job_categories jc ON j.job_category_id = jc.id
      LEFT JOIN clients c ON j.client_id = c.id
      WHERE j.team_lead_id = (
        SELECT reports_to FROM employees WHERE emp_id = $1
      )
      ORDER BY j.job_code ASC
    `, [empId]);
    res.json(result.rows);
  } catch (err) {
    logger.error(`employee-jobs fetch failed for ${empId}: ${err.message}`, {
      category: 'attendance',
    });
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /attendance/set-home
// Employee sets their home location from mobile (uses current GPS).
// Body: { emp_id, latitude, longitude, radius? }
// This is what makes duty-start show location_type = 'home'.
// A registered site named "Home" in the sites table is unrelated —
// that is a GPS-enrolled site; this sets the employee's personal home coords.
// ─────────────────────────────────────────────────────────────────────────────
router.put('/set-home', async (req, res) => {
  const { emp_id, latitude, longitude, radius } = req.body;
  if (!emp_id || latitude == null || longitude == null) {
    return res.status(400).json({ error: 'emp_id, latitude, longitude required.' });
  }
  try {
    await pool.query(
      `UPDATE employees
       SET home_latitude = $1, home_longitude = $2, home_radius = $3
       WHERE emp_id = $4`,
      [latitude, longitude, radius || 100, emp_id]
    );
    logger.info(`Home location set for ${emp_id}`, {
      category: 'attendance', user_id: emp_id,
      meta: { latitude, longitude, radius: radius || 100 },
    });
    res.json({ success: true, message: 'Home location saved.' });
  } catch (err) {
    logger.error(`set-home failed for ${emp_id}: ${err.message}`, { category: 'attendance' });
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /attendance/active-session  (LEGACY — kept for backward compat)
// Mobile versions still in field use this. Will be removed in v11.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/active-session', async (req, res) => {
  const { emp_id, site_id } = req.query;
  if (!emp_id || !site_id) {
    return res.status(400).json({ error: 'emp_id and site_id required.' });
  }
  try {
    const result = await pool.query(`
      SELECT
        s.id, s.employee_id, s.site_id, s.job_id,
        s.punched_in_at, s.device_id, s.latitude, s.longitude,
        j.job_code, j.job_number,
        jc.code AS category_code,
        si.site_name
      FROM active_sessions s
      LEFT JOIN jobs j ON s.job_id = j.id
      LEFT JOIN job_categories jc ON j.job_category_id = jc.id
      LEFT JOIN sites si ON s.site_id = si.id
      WHERE s.employee_id = $1 AND s.site_id = $2 AND s.session_type = 'site'
    `, [emp_id, site_id]);
    res.json({ session: result.rows[0] || null });
  } catch (err) {
    logger.error(`active-session check failed: ${err.message}`, {
      category: 'attendance', user_id: emp_id,
    });
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /attendance/site-jobs/:siteId  (unchanged — used by mobile job picker)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/site-jobs/:siteId', async (req, res) => {
  const { siteId } = req.params;
  try {
    const result = await pool.query(`
      SELECT
        j.id, j.job_code, j.job_number,
        jc.code AS category_code,
        jc.description AS category_description,
        c.name AS client_name
      FROM site_jobs sj
      JOIN jobs j ON sj.job_id = j.id
      LEFT JOIN job_categories jc ON j.job_category_id = jc.id
      LEFT JOIN clients c ON j.client_id = c.id
      WHERE sj.site_id = $1
      ORDER BY j.job_code ASC
    `, [siteId]);
    res.json(result.rows);
  } catch (err) {
    logger.error(`Fetch site jobs failed for site ${siteId}: ${err.message}`, {
      category: 'attendance',
    });
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /attendance/punch-in  (LEGACY — maps to site-in internally)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/punch-in', async (req, res) => {
  const { emp_id, site_id, job_id, latitude, longitude, device_id, log_time } = req.body;
  if (!emp_id || !site_id) return res.status(400).json({ error: 'emp_id and site_id required.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const punchTime = log_time ? new Date(log_time) : new Date();

    await client.query(`
      INSERT INTO active_sessions
        (employee_id, site_id, job_id, session_type, punched_in_at, device_id, latitude, longitude)
      VALUES ($1, $2, $3, 'site', $4, $5, $6, $7)
      ON CONFLICT DO NOTHING
    `, [emp_id, site_id, job_id || null, punchTime, device_id || null, latitude, longitude]);

    await client.query(`
      INSERT INTO attendance_logs
        (employee_id, action_type, log_time, latitude, longitude, site_id, job_id,
         location_type, is_approved)
      VALUES ($1, 'IN', $2, $3, $4, $5, $6, 'registered_site', TRUE)
    `, [emp_id, punchTime, latitude, longitude, site_id, job_id || null]);

    await client.query('COMMIT');
    io.emit('dashboard-update');
    res.json({ success: true, message: 'Punched IN successfully.' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /attendance/punch-out  (LEGACY)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/punch-out', async (req, res) => {
  const { emp_id, site_id, latitude, longitude, device_id, log_time } = req.body;
  if (!emp_id || !site_id) return res.status(400).json({ error: 'emp_id and site_id required.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sessionRes = await client.query(
      `SELECT * FROM active_sessions WHERE employee_id = $1 AND site_id = $2 AND session_type = 'site'`,
      [emp_id, site_id]
    );
    const job_id = sessionRes.rows[0]?.job_id || null;
    const punchTime = log_time ? new Date(log_time) : new Date();

    await client.query(`
      INSERT INTO attendance_logs
        (employee_id, action_type, log_time, latitude, longitude, site_id, job_id,
         location_type, is_approved)
      VALUES ($1, 'OUT', $2, $3, $4, $5, $6, 'registered_site', TRUE)
    `, [emp_id, punchTime, latitude, longitude, site_id, job_id]);

    await client.query(
      `DELETE FROM active_sessions WHERE employee_id = $1 AND site_id = $2 AND session_type = 'site'`,
      [emp_id, site_id]
    );

    await client.query('COMMIT');
    io.emit('dashboard-update');
    res.json({ success: true, message: 'Punched OUT successfully.' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /attendance/sync  (LEGACY offline batch — unchanged)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/sync', async (req, res) => {
  const logs = req.body;
  const client = await pool.connect();
  try {
    const sitesResult = await client.query('SELECT * FROM sites');
    const sites = sitesResult.rows;
    await client.query('BEGIN');

    for (const log of logs) {
      const nearest = findNearestSite(log.latitude, log.longitude, sites);
      const siteId  = nearest?.id || null;
      await client.query(
        `INSERT INTO attendance_logs
           (employee_id, action_type, log_time, latitude, longitude, site_id, job_id, is_approved)
         VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)`,
        [log.emp_id, log.action_type, log.log_time, log.latitude, log.longitude, siteId, log.job_id || null]
      );
    }

    await client.query('COMMIT');
    io.emit('dashboard-update');
    logger.info(`Offline sync: ${logs.length} punch(es) recorded`, { category: 'attendance' });
    res.status(201).json({ success: true, message: 'Logs synced.' });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`Sync failed: ${err.message}`, { category: 'attendance' });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /attendance/dashboard-stats  (updated to count new action types)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/dashboard-stats', async (req, res) => {
  try {
    const now      = new Date();
    const todayISO = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

    const [
      totalEmpRes, totalSitesRes, empInTodayRes, sitesActiveTodayRes,
      totalPunchesTodayRes, newEmpsTodayRes, newSitesTodayRes,
      newFaceEnrolmentsTodayRes, newDevicesTodayRes, newGpsEnrolmentsTodayRes,
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM employees'),
      pool.query('SELECT COUNT(*) FROM sites'),
      // Updated: count any type of "in" punch today
      pool.query(
        `SELECT COUNT(DISTINCT employee_id) FROM attendance_logs
         WHERE action_type IN ('IN','SITE_IN','DUTY_START') AND log_time >= $1`,
        [todayISO]
      ),
      pool.query(
        `SELECT COUNT(DISTINCT site_id) FROM attendance_logs
         WHERE site_id IS NOT NULL AND log_time >= $1`,
        [todayISO]
      ),
      pool.query('SELECT COUNT(*) FROM attendance_logs WHERE log_time >= $1', [todayISO]),
      pool.query('SELECT COUNT(*) FROM employees WHERE created_at >= $1', [todayISO]),
      pool.query('SELECT COUNT(*) FROM sites WHERE created_at >= $1', [todayISO]),
      pool.query(
        `SELECT COUNT(*) FROM employees WHERE enrollment_status = 'completed' AND created_at >= $1`,
        [todayISO]
      ),
      pool.query('SELECT COUNT(*) FROM devices WHERE created_at >= $1', [todayISO]),
      pool.query('SELECT COUNT(*) FROM sites WHERE gps_enrolled_at >= $1', [todayISO]),
    ]);

    res.json({
      total_employees:           parseInt(totalEmpRes.rows[0].count),
      total_sites:               parseInt(totalSitesRes.rows[0].count),
      employees_in_today:        parseInt(empInTodayRes.rows[0].count),
      sites_active_today:        parseInt(sitesActiveTodayRes.rows[0].count),
      total_punches_today:       parseInt(totalPunchesTodayRes.rows[0].count),
      new_employees_today:       parseInt(newEmpsTodayRes.rows[0].count),
      new_sites_today:           parseInt(newSitesTodayRes.rows[0].count),
      new_face_enrolments_today: parseInt(newFaceEnrolmentsTodayRes.rows[0].count),
      new_devices_today:         parseInt(newDevicesTodayRes.rows[0].count),
      new_gps_enrolments_today:  parseInt(newGpsEnrolmentsTodayRes.rows[0].count),
    });
  } catch (err) {
    logger.error(`Dashboard stats failed: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /attendance/logs  (unchanged — admin log viewer)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/logs', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        al.*,
        e.name  AS employee_name,
        s.site_name,
        j.job_code, j.job_number,
        jc.code AS category_code,
        appr.name AS approved_by_name
      FROM attendance_logs al
      JOIN employees e ON al.employee_id = e.emp_id
      LEFT JOIN sites          s    ON al.site_id    = s.id
      LEFT JOIN jobs           j    ON al.job_id     = j.id
      LEFT JOIN job_categories jc   ON j.job_category_id = jc.id
      LEFT JOIN employees      appr ON al.approved_by = appr.emp_id
      ORDER BY al.log_time DESC
    `);
    res.json(result.rows);
  } catch (err) {
    logger.error(`Fetch attendance logs failed: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

export default router;