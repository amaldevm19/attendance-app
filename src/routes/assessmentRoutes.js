// =============================================================================
// assessmentRoutes.js  (src/routes/assessmentRoutes.js)
// Handles Rate Poll sessions, score calculation, automation, and score display.
// =============================================================================

import express       from 'express';
import pool          from '../config/db.js';
import { io, connectedDevices } from '../server.js';
import logger        from '../logger.js';
import { notifyEmployee } from '../utils/notificationService.js';
import crypto        from 'crypto';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Insert a new score component row (append-only) then recalculate total.
 *
 * Formula (in PG function recalculate_employee_score):
 *   Total = ROUND((tl_rating + sup_rating) / 2)
 *           + qa + client_poll
 *           + auto_punch + auto_timeline + auto_qa_late
 *
 * Each new rating event inserts a row. Latest row per component wins.
 * Old rows kept forever — used for history and reporting.
 *
 * auto_* components start at max (full marks) and decrease on violations.
 * poll/qa/client components: each new session replaces previous in total.
 */
async function applyScoreComponent(client, empId, component, value, maxValue, reason, sessionId = null, qaId = null) {
  // 1. Current total before this change
  const beforeRes = await client.query(
    'SELECT score FROM employees WHERE emp_id = $1', [empId]
  );
  const before = parseInt(beforeRes.rows[0]?.score ?? 300);

  // 2. Insert component row (append-only — never UPDATE existing rows)
  await client.query(`
    INSERT INTO employee_score_components
      (employee_id, component, value, max_value, session_id, qa_id, note)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [empId, component, value, maxValue, sessionId, qaId, reason]);

  // 3. Recalculate total via PG function (reads latest row per component)
  const calcRes = await client.query(
    'SELECT recalculate_employee_score($1) AS total', [empId]
  );
  const after = parseInt(calcRes.rows[0].total);

  // 4. Audit trail in score_history
  await client.query(`
    INSERT INTO score_history
      (employee_id, score_before, score_after, delta, reason, session_id, qa_assignment_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [empId, before, after, after - before, reason, sessionId, qaId]);

  // 5. Notify primary device
  await emitToEmployeeDevices(empId, 'score-updated', {
    emp_id: empId, score: after, badge: computeBadge(after),
  }, true);
  io.emit('dashboard-update');

  logger.info(`Score [${component}]=${value} → ${empId}: ${before}→${after}`, {
    category: 'assessment', user_id: empId,
    meta: { component, value, maxValue, before, after, reason, session_id: sessionId },
  });
  return after;
}

/**
 * Auto-deduction wrapper for punch/timeline/qa-late violations.
 * Reads current auto_* component value, applies delta, inserts new row.
 * auto_* are floored at 0 (cannot go below zero).
 */
async function applyScoreDelta(client, empId, delta, reason, sessionId = null, qaId = null) {
  if (!delta || delta === 0) return;

  const componentMap = {
    'punch_rejection': 'auto_punch',
    'auto_punch':      'auto_punch',
    'auto_timeline':   'auto_timeline',
    'qa_late':         'auto_qa_late',
    'auto_qa_late':    'auto_qa_late',
  };
  const component = componentMap[reason];
  if (!component) {
    logger.warn(`applyScoreDelta: unknown reason "${reason}" for ${empId}`, { category: 'assessment' });
    return;
  }

  // Get current component value (latest row)
  const curRes = await client.query(`
    SELECT value, max_value FROM employee_score_components
    WHERE employee_id = $1 AND component = $2
    ORDER BY id DESC LIMIT 1
  `, [empId, component]);

  const curValue = parseFloat(curRes.rows[0]?.value ?? 25); // default is 25 (full marks)
  const maxValue = parseFloat(curRes.rows[0]?.max_value ?? 25);
  const newValue = Math.max(0, curValue + delta); // floor at 0, never negative

  await applyScoreComponent(client, empId, component, newValue, maxValue, reason, sessionId, qaId);
}

function computeBadge(score) {
  if (score <= 299) return 'red';
  if (score === 300) return 'blue';
  if (score <= 700) return 'yellow';
  return 'green';
}

/**
 * Emit a socket event to employee's devices.
 * primaryOnly = true  → only the employee's primary device (personalized notifications)
 * primaryOnly = false → all assigned devices (task notifications)
 */
async function emitToEmployeeDevices(empId, event, payload, primaryOnly = false) {
  const devRes = await pool.query(`
    SELECT d.device_unique_id, ed.is_primary
    FROM employee_devices ed
    JOIN devices d ON ed.device_id = d.id
    WHERE ed.employee_id = $1
      ${primaryOnly ? 'AND ed.is_primary = TRUE' : ''}
  `, [empId]);
  devRes.rows.forEach(row => {
    const socketId = connectedDevices.get(row.device_unique_id);
    if (socketId) io.to(socketId).emit(event, payload);
  });
}

/**
 * Calculate and apply poll rating score per component.
 *
 * by_tl session        → inserts new 'tl_rating'  component row
 * by_supervisor session → inserts new 'sup_rating' component row
 *
 * Both are stored independently. Total recalculates as:
 *   ROUND((latest_tl + latest_sup) / 2) + other components
 *
 * No double counting — new row for same component replaces old value
 * in the calculation (latest-row-wins via employee_score_current view).
 * Old row is kept in employee_score_components history forever.
 */
async function calculateAndApplyPollScore(client, session) {
  const { employee_id, session_type, id: sessionId } = session;
  if (!['by_supervisor', 'by_tl'].includes(session_type)) return;

  // Sum scores given by this rater for poll_avg criteria
  const responsesRes = await client.query(`
    SELECT ar.score_given, ac.max_score
    FROM assessment_responses ar
    JOIN assessment_criteria ac ON ar.criterion_id = ac.id
    WHERE ar.session_id = $1 AND ac.source = 'poll_avg' AND ac.is_active = TRUE
  `, [sessionId]);

  if (!responsesRes.rows.length) return;

  const totalGiven = responsesRes.rows.reduce((s, r) => s + parseFloat(r.score_given), 0);
  const totalMax   = responsesRes.rows.reduce((s, r) => s + parseFloat(r.max_score),   0);
  const component  = session_type === 'by_tl' ? 'tl_rating' : 'sup_rating';

  await applyScoreComponent(
    client, employee_id, component,
    Math.round(totalGiven), totalMax,
    'poll_applied', sessionId
  );

  await client.query(`
    UPDATE assessment_sessions
    SET calc_status = 'complete', score_delta = $1
    WHERE id = $2
  `, [Math.round(totalGiven), sessionId]);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /assessment/criteria
// Returns all active criteria (used by admin UI and mobile rating screens)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/criteria', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM assessment_criteria
      WHERE is_active = TRUE
      ORDER BY sort_order ASC
    `);
    res.json(result.rows);
  } catch (err) {
    logger.error(`Fetch criteria failed: ${err.message}`, { category: 'assessment' });
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /assessment/employees
// Returns all employees with their current score and badge, plus hierarchy info
// Used by the Rate Poll admin page
// ─────────────────────────────────────────────────────────────────────────────
router.get('/employees', async (req, res) => {
  const { portfolio_id, supervisor_id, tl_id } = req.query;
  try {
    const conditions = [];
    const params     = [];

    if (portfolio_id) {
      conditions.push(`EXISTS (
        SELECT 1 FROM employee_portfolios ep2
        JOIN employee_portfolios tlep ON tlep.portfolio_id = ep2.portfolio_id
        WHERE ep2.emp_id = e.emp_id AND tlep.portfolio_id = $${params.length+1}
      )`);
      params.push(parseInt(portfolio_id));
    }
    if (tl_id) {
      // mgr.reports_to is the TL — employees whose supervisor reports to this TL
      conditions.push(`mgr.reports_to = $${params.length+1}`);
      params.push(tl_id);
    }
    if (supervisor_id) {
      conditions.push(`e.reports_to = $${params.length+1}`);
      params.push(supervisor_id);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(`
      SELECT
        e.emp_id, e.name, e.designation, e.score, e.badge,
        e.reports_to,
        mgr.name        AS reports_to_name,
        mgr.designation AS reports_to_designation,
        mgr.emp_id      AS supervisor_emp_id,
        mgr.reports_to  AS tl_id,
        tl.name         AS tl_name,
        tl.emp_id       AS tl_emp_id,
        des.level       AS designation_level,
        e.email,
        COALESCE(
          JSON_AGG(DISTINCT JSONB_BUILD_OBJECT(
            'id', d.id, 'device_unique_id', d.device_unique_id,
            'device_name', COALESCE(d.friendly_name, d.device_name)
          )) FILTER (WHERE d.id IS NOT NULL), '[]'
        ) AS devices,
        COALESCE(
          JSON_AGG(DISTINCT JSONB_BUILD_OBJECT('id', pf.id, 'name', pf.name))
          FILTER (WHERE pf.id IS NOT NULL), '[]'
        ) AS portfolios
      FROM employees e
      LEFT JOIN employees   mgr ON e.reports_to = mgr.emp_id
      LEFT JOIN employees   tl  ON mgr.reports_to = tl.emp_id
      LEFT JOIN designations des ON e.designation_id = des.id
      LEFT JOIN employee_devices ed ON e.emp_id = ed.employee_id
      LEFT JOIN devices d ON ed.device_id = d.id
      LEFT JOIN employee_portfolios ep ON e.emp_id = ep.emp_id
      LEFT JOIN portfolios pf ON ep.portfolio_id = pf.id
      ${where}
      GROUP BY
        e.emp_id, e.name, e.designation, e.score, e.badge,
        e.reports_to, e.email,
        mgr.emp_id, mgr.name, mgr.designation, mgr.reports_to,
        tl.emp_id, tl.name,
        des.level
      ORDER BY des.level ASC NULLS LAST, e.name ASC
    `, params);
    res.json(result.rows);
  } catch (err) {
    logger.error(`Assessment employees fetch failed: ${err.message}`, { category: 'assessment' });
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /assessment/push
// Admin pushes assessment sessions.
// Body: { pushes: [{ employee_id, session_type, deadline_days? }], pushed_by }
//
// For each push:
//   1. Create assessment_session row
//   2. Determine respondent based on session_type + employee hierarchy
//   3. Push to respondent's device(s) via socket + pending_assessment_tasks
//   4. For 'client' type: generate token, send email
// ─────────────────────────────────────────────────────────────────────────────
router.post('/push', async (req, res) => {
  const { pushes, pushed_by } = req.body;
  if (!pushes?.length) return res.status(400).json({ error: 'pushes array required.' });

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    const created = [];

    for (const push of pushes) {
      const { employee_id, session_type, deadline_days = 1, client_email } = push;

      // Resolve respondent based on session_type
      let respondent_id = null;
      const empRes = await dbClient.query(
        'SELECT reports_to FROM employees WHERE emp_id = $1', [employee_id]
      );
      const supervisorId = empRes.rows[0]?.reports_to;

      if (session_type === 'self') {
        respondent_id = employee_id;
      } else if (session_type === 'by_supervisor') {
        respondent_id = supervisorId;
      } else if (session_type === 'by_tl') {
        // TL = supervisor's supervisor (or admin if no chain)
        if (supervisorId) {
          const tlRes = await dbClient.query(
            'SELECT reports_to FROM employees WHERE emp_id = $1', [supervisorId]
          );
          respondent_id = tlRes.rows[0]?.reports_to || supervisorId;
        }
      } else if (session_type === 'rate_supervisor') {
        respondent_id = employee_id; // employee rates their supervisor
      } else if (session_type === 'rate_tl') {
        respondent_id = employee_id; // employee rates their TL
      }
      // client: no respondent_id — emails sent to all client reps
      //         from jobs the employee has actually worked on (attendance-based)

      const deadline = new Date();
      deadline.setDate(deadline.getDate() + deadline_days);

      if (session_type === 'client') {
        // ── AUTO-FETCH client reps from jobs this employee worked on ──────────
        // Find all distinct jobs this employee has punched in to
        const workedJobsRes = await dbClient.query(`
          SELECT DISTINCT
            j.id        AS job_id,
            j.job_code,
            cr.email    AS client_rep_email,
            cr.name     AS client_rep_name,
            c.name      AS client_name
          FROM attendance_logs al
          JOIN jobs j ON al.job_id = j.id
          LEFT JOIN client_representatives cr ON j.client_rep_id = cr.id
          LEFT JOIN clients c ON j.client_id = c.id
          WHERE al.employee_id = $1
            AND al.action_type IN ('SITE_IN','SITE_OUT','IN','OUT')
            AND cr.email IS NOT NULL
            AND cr.email <> ''
        `, [employee_id]);

        if (workedJobsRes.rows.length === 0) {
          logger.warn(`Client push skipped for ${employee_id} — no worked jobs with client reps`, {
            category: 'assessment', user_id: pushed_by,
          });
          // Still create one placeholder session so admin sees it was attempted
          const token = crypto.randomUUID();
          const sessRes = await dbClient.query(`
            INSERT INTO assessment_sessions
              (employee_id, session_type, respondent_id, deadline, client_token, client_email, is_automated)
            VALUES ($1, 'client', NULL, $2, $3, NULL, FALSE)
            RETURNING *
          `, [employee_id, deadline, token]);
          created.push(sessRes.rows[0]);
        } else {
          // Create one session per unique client rep email
          const seen = new Set();
          for (const row of workedJobsRes.rows) {
            if (seen.has(row.client_rep_email)) continue; // deduplicate by email
            seen.add(row.client_rep_email);

            const token = crypto.randomUUID();
            const sessRes = await dbClient.query(`
              INSERT INTO assessment_sessions
                (employee_id, session_type, respondent_id, deadline, client_token, client_email, is_automated)
              VALUES ($1, 'client', NULL, $2, $3, $4, FALSE)
              RETURNING *
            `, [employee_id, deadline, token, row.client_rep_email]);

            const session = sessRes.rows[0];
            created.push(session);

            // Send email to this client rep (fire-and-forget)
            sendClientAssessmentEmail(row.client_rep_email, employee_id, token, row.client_rep_name, row.client_name)
              .then(() => logger.info(`Client assessment email sent to ${row.client_rep_email}`, { category: 'assessment' }))
              .catch(e => logger.error(`Client email FAILED to ${row.client_rep_email}: ${e.message}`, {
                category: 'assessment',
                meta: { error: e.message, stack: e.stack?.split('\n')[0] },
              }));

            logger.info(`Client assessment email queued: ${employee_id} → ${row.client_rep_email} (${row.client_name})`, {
              category: 'assessment', user_id: pushed_by,
              meta: { session_id: session.id, job_id: row.job_id, client: row.client_name },
            });
          }
        }

      } else {
        // ── Non-client session — standard flow ────────────────────────────────
        const clientToken = null;
        const sessRes = await dbClient.query(`
          INSERT INTO assessment_sessions
            (employee_id, session_type, respondent_id, deadline, client_token, client_email, is_automated)
          VALUES ($1, $2, $3, $4, $5, $6, FALSE)
          RETURNING *
        `, [employee_id, session_type, respondent_id, deadline, clientToken, null]);

        const session = sessRes.rows[0];
        created.push(session);

        // Push to respondent's devices
        if (respondent_id) {
          const devRes = await dbClient.query(`
            SELECT d.id AS device_id, d.device_unique_id
            FROM employee_devices ed
            JOIN devices d ON ed.device_id = d.id
            WHERE ed.employee_id = $1 AND d.is_active = TRUE
          `, [respondent_id]);

          for (const dev of devRes.rows) {
            await dbClient.query(`
              INSERT INTO pending_assessment_tasks (device_id, session_id)
              VALUES ($1, $2) ON CONFLICT DO NOTHING
            `, [dev.device_id, session.id]);

            const socketId = connectedDevices.get(dev.device_unique_id);
            if (socketId) {
              io.to(socketId).emit('new-assessment-task', { session_id: session.id, session_type });
            }
          }
        }

        logger.info(`Assessment pushed: ${employee_id} [${session_type}] respondent=${respondent_id}`, {
          category: 'assessment', user_id: pushed_by,
          meta: { session_id: session.id, deadline_days },
        });
      }
    }

    await dbClient.query('COMMIT');
    io.emit('dashboard-update');
    io.emit('assessment-update'); // triggers admin windows to re-fetch sessions
    res.json({ success: true, created: created.length, sessions: created });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    logger.error(`Assessment push failed: ${err.message}`, { category: 'assessment' });
    res.status(500).json({ error: err.message });
  } finally {
    dbClient.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /assessment/pending-assessment-tasks/:deviceId
// Mobile calls this to get pending assessment sessions for this device.
// Returns sessions grouped so one tile shows all.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/pending-assessment-tasks/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  try {
    const result = await pool.query(`
      SELECT
        pat.id     AS task_id,
        s.id       AS session_id,
        s.session_type,
        s.deadline,
        s.status   AS session_status,
        e.emp_id,
        e.name     AS employee_name,
        e.designation,
        e.badge,
        e.score,
        -- For rate_supervisor / rate_tl: who they are rating
        mgr.emp_id   AS subject_emp_id,
        mgr.name     AS subject_name
      FROM pending_assessment_tasks pat
      JOIN assessment_sessions s ON pat.session_id = s.id
      JOIN devices d ON pat.device_id = d.id
      JOIN employees e ON s.employee_id = e.emp_id
      LEFT JOIN employees mgr ON (
        CASE
          WHEN s.session_type = 'rate_supervisor' THEN e.reports_to
          WHEN s.session_type = 'rate_tl'         THEN (
            SELECT reports_to FROM employees WHERE emp_id = e.reports_to LIMIT 1
          )
          ELSE NULL
        END
      ) = mgr.emp_id
      WHERE d.device_unique_id = $1
        AND s.status = 'pending'
        AND s.deadline > NOW()
      ORDER BY s.created_at DESC
    `, [deviceId]);
    res.json(result.rows);
  } catch (err) {
    logger.error(`Pending assessment tasks failed: ${err.message}`, { category: 'assessment' });
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /assessment/submit/:sessionId
// Mobile submits completed responses for a session.
// Body: { responses: [{ criterion_id, score_given }], respondent_emp_id }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/submit/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { responses, respondent_emp_id } = req.body;

  if (!responses?.length) return res.status(400).json({ error: 'responses required.' });

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    // Validate session
    const sessRes = await dbClient.query(
      'SELECT * FROM assessment_sessions WHERE id = $1', [sessionId]
    );
    if (!sessRes.rows.length) {
      await dbClient.query('ROLLBACK');
      return res.status(404).json({ error: 'Session not found.' });
    }
    const session = sessRes.rows[0];

    if (session.status === 'submitted') {
      await dbClient.query('ROLLBACK');
      return res.status(409).json({ error: 'Session already submitted.' });
    }
    if (new Date(session.deadline) < new Date()) {
      await dbClient.query('ROLLBACK');
      return res.status(410).json({ error: 'Session deadline has passed.' });
    }

    // Insert responses
    for (const r of responses) {
      await dbClient.query(`
        INSERT INTO assessment_responses (session_id, criterion_id, score_given)
        VALUES ($1, $2, $3)
        ON CONFLICT (session_id, criterion_id) DO UPDATE SET score_given = $3
      `, [sessionId, r.criterion_id, r.score_given]);
    }

    // Mark session submitted
    await dbClient.query(`
      UPDATE assessment_sessions
      SET status = 'submitted', submitted_at = NOW(),
          calc_status = CASE
            WHEN session_type IN ('self','rate_supervisor','rate_tl','client') THEN 'not_scored'
            ELSE 'waiting'
          END
      WHERE id = $1
    `, [sessionId]);

    // Remove from pending tasks
    await dbClient.query(
      'DELETE FROM pending_assessment_tasks WHERE session_id = $1', [sessionId]
    );

    // Attempt score calculation (poll_avg types)
    if (['by_supervisor', 'by_tl'].includes(session.session_type)) {
      await calculateAndApplyPollScore(dbClient, session, false);
    }

    await dbClient.query('COMMIT');

    // Notify employee that someone rated them (only for by_supervisor, by_tl)
    if (['by_supervisor', 'by_tl'].includes(session.session_type)) {
      notifyEmployee(session.employee_id, 'correction_approved', {
        request_type: 'assessment',
        tl_comment: 'Your performance assessment has been updated.',
      }).catch(() => {});
    }

    io.emit('dashboard-update');

    logger.info(`Assessment submitted: session ${sessionId} by ${respondent_emp_id}`, {
      category: 'assessment', user_id: respondent_emp_id,
      meta: { session_type: session.session_type, response_count: responses.length },
    });

    res.json({ success: true });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    logger.error(`Assessment submit failed: ${err.message}`, { category: 'assessment' });
    res.status(500).json({ error: err.message });
  } finally {
    dbClient.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /assessment/client-form/:token
// Public endpoint — client opens email link, this returns the form data.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/client-form/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const sessRes = await pool.query(`
      SELECT s.id, s.status, s.deadline,
             e.name AS employee_name, e.emp_id,
             e.designation
      FROM assessment_sessions s
      JOIN employees e ON s.employee_id = e.emp_id
      WHERE s.client_token = $1 AND s.session_type = 'client'
    `, [token]);

    if (!sessRes.rows.length) return res.status(404).json({ error: 'Invalid or expired link.' });
    const session = sessRes.rows[0];
    if (session.status === 'submitted') return res.status(410).json({ error: 'Already submitted. Thank you!' });
    if (new Date(session.deadline) < new Date()) return res.status(410).json({ error: 'This assessment link has expired.' });

    const criteriaRes = await pool.query(`
      SELECT id, category, sub_item, max_score
      FROM assessment_criteria
      WHERE source IN ('client_poll') AND is_active = TRUE
      ORDER BY sort_order ASC
    `);

    res.json({ session, criteria: criteriaRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /assessment/client-form/:token
// Public — client submits their scores.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/client-form/:token', async (req, res) => {
  const { token } = req.params;
  const { responses } = req.body;

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    const sessRes = await dbClient.query(
      `SELECT * FROM assessment_sessions WHERE client_token = $1 AND session_type = 'client'`,
      [token]
    );
    if (!sessRes.rows.length) { await dbClient.query('ROLLBACK'); return res.status(404).json({ error: 'Invalid link.' }); }
    const session = sessRes.rows[0];
    if (session.status === 'submitted') { await dbClient.query('ROLLBACK'); return res.status(410).json({ error: 'Already submitted.' }); }

    for (const r of (responses || [])) {
      await dbClient.query(`
        INSERT INTO assessment_responses (session_id, criterion_id, score_given)
        VALUES ($1, $2, $3) ON CONFLICT (session_id, criterion_id) DO UPDATE SET score_given = $3
      `, [session.id, r.criterion_id, r.score_given]);
    }

    await dbClient.query(
      `UPDATE assessment_sessions SET status='submitted', submitted_at=NOW(), calc_status='complete' WHERE id=$1`,
      [session.id]
    );

    // Insert new client_poll component row.
    // Latest row wins in recalculation — previous client score kept in history.
    const totalGiven  = (responses || []).reduce((s, r) => s + (r.score_given || 0), 0);
    const criteriaSum = await dbClient.query(
      `SELECT COALESCE(SUM(max_score),0) AS total FROM assessment_criteria WHERE source='client_poll' AND is_active=TRUE`
    );
    const maxPossible = parseInt(criteriaSum.rows[0].total);
    await applyScoreComponent(
      dbClient, session.employee_id,
      'client_poll', Math.round(totalGiven), maxPossible,
      'client_poll', session.id
    );

    await dbClient.query('COMMIT');
    res.json({ success: true, message: 'Thank you for your feedback!' });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    dbClient.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /assessment/all-sessions
// Admin history panel: all sessions with employee + respondent + status
// Query params: status, session_type, employee_id, limit
// ─────────────────────────────────────────────────────────────────────────────
router.get('/all-sessions', async (req, res) => {
  const { status, session_type, employee_id, limit = 100 } = req.query;
  try {
    const conditions = [];
    const params     = [];

    if (status)       { conditions.push(`s.status = $${params.length+1}`);       params.push(status); }
    if (session_type) { conditions.push(`s.session_type = $${params.length+1}`); params.push(session_type); }
    if (employee_id)  { conditions.push(`s.employee_id = $${params.length+1}`);  params.push(employee_id); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(`
      SELECT
        s.id, s.employee_id, s.session_type, s.respondent_id,
        s.deadline, s.status, s.calc_status, s.score_delta,
        s.is_automated, s.submitted_at, s.created_at,
        s.client_email, s.client_token,
        e.name          AS employee_name,
        e.designation   AS employee_designation,
        e.badge, e.score,
        r.name          AS respondent_name,
        r.designation   AS respondent_designation
      FROM assessment_sessions s
      JOIN employees e ON s.employee_id = e.emp_id
      LEFT JOIN employees r ON s.respondent_id = r.emp_id
      ${where}
      ORDER BY s.created_at DESC
      LIMIT $${params.length+1}
    `, [...params, parseInt(limit)]);

    res.json(result.rows);
  } catch (err) {
    logger.error(`All sessions fetch failed: ${err.message}`, { category: 'assessment' });
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /assessment/session/:sessionId
// Admin cancels (expires) a pending session
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/session/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const result = await pool.query(
      `UPDATE assessment_sessions SET status = 'expired' WHERE id = $1 AND status = 'pending' RETURNING id`,
      [sessionId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Session not found or already closed.' });
    }
    await pool.query('DELETE FROM pending_assessment_tasks WHERE session_id = $1', [sessionId]);
    io.emit('assessment-update');
    logger.info(`Session ${sessionId} cancelled by admin`, { category: 'assessment' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /assessment/score-history/:empId
// Returns score change history for an employee (chart data + audit)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/score-history/:empId', async (req, res) => {
  const { empId } = req.params;
  try {
    const result = await pool.query(`
      SELECT sh.*,
             e.name AS triggered_by_name
      FROM score_history sh
      LEFT JOIN employees e ON sh.triggered_by = e.emp_id
      WHERE sh.employee_id = $1
      ORDER BY sh.created_at DESC
      LIMIT 100
    `, [empId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /assessment/automation-settings
// ─────────────────────────────────────────────────────────────────────────────
router.get('/automation-settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM assessment_automation_settings ORDER BY id ASC LIMIT 1');
    res.json(result.rows[0] || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /assessment/automation-settings
// Body: { is_enabled, push_type, frequency, target_levels, session_types,
//         qa_deadline_days }
// ─────────────────────────────────────────────────────────────────────────────
router.put('/automation-settings', async (req, res) => {
  const { is_enabled, push_type, frequency, target_levels, session_types, qa_deadline_days } = req.body;
  try {
    const existing = await pool.query('SELECT id FROM assessment_automation_settings LIMIT 1');
    let nextRun = null;
    if (is_enabled) {
      nextRun = new Date();
      if (frequency === 'daily')   nextRun.setDate(nextRun.getDate() + 1);
      if (frequency === 'weekly')  nextRun.setDate(nextRun.getDate() + 7);
      if (frequency === 'monthly') nextRun.setMonth(nextRun.getMonth() + 1);
    }

    if (existing.rows.length) {
      await pool.query(`
        UPDATE assessment_automation_settings SET
          is_enabled=$1, push_type=$2, frequency=$3, target_levels=$4,
          session_types=$5, qa_deadline_days=$6, next_run_at=$7, updated_at=NOW()
        WHERE id=$8
      `, [is_enabled, push_type, frequency, target_levels, session_types,
          qa_deadline_days, nextRun, existing.rows[0].id]);
    } else {
      await pool.query(`
        INSERT INTO assessment_automation_settings
          (is_enabled, push_type, frequency, target_levels, session_types, qa_deadline_days, next_run_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [is_enabled, push_type, frequency, target_levels, session_types, qa_deadline_days, nextRun]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /assessment/punch-deduction
// Called internally from attendanceRoutes when TL rejects a correction.
// Body: { employee_id, reason: 'correction_rejected'|'punch_rejected' }
// Deducts 5 points from relevant auto_punch criteria.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/punch-deduction', async (req, res) => {
  const { employee_id, reason } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id required.' });

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    await applyScoreDelta(dbClient, employee_id, -5, 'punch_rejection');
    await dbClient.query('COMMIT');
    res.json({ success: true, delta: -5 });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    dbClient.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /assessment/session-responses/:sessionId
// Admin view of individual responses for a submitted session
// ─────────────────────────────────────────────────────────────────────────────
router.get('/session-responses/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const result = await pool.query(`
      SELECT
        ar.id, ar.criterion_id, ar.score_given, ar.submitted_at,
        ac.category, ac.sub_item, ac.max_score, ac.source,
        s.session_type, s.employee_id, s.respondent_id, s.status,
        s.submitted_at AS session_submitted_at,
        e.name  AS employee_name,
        r.name  AS respondent_name
      FROM assessment_responses ar
      JOIN assessment_criteria ac ON ar.criterion_id = ac.id
      JOIN assessment_sessions s  ON ar.session_id = s.id
      JOIN employees e ON s.employee_id = e.emp_id
      LEFT JOIN employees r ON s.respondent_id = r.emp_id
      WHERE ar.session_id = $1
      ORDER BY ac.sort_order ASC
    `, [sessionId]);
    res.json(result.rows);
  } catch (err) {
    logger.error(`session-responses failed: ${err.message}`, { category: 'assessment' });
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /assessment/sessions/:empId
// Admin / TL view of all sessions for an employee
// ─────────────────────────────────────────────────────────────────────────────
router.get('/sessions/:empId', async (req, res) => {
  const { empId } = req.params;
  try {
    const result = await pool.query(`
      SELECT s.*,
             r.name AS respondent_name
      FROM assessment_sessions s
      LEFT JOIN employees r ON s.respondent_id = r.emp_id
      WHERE s.employee_id = $1
      ORDER BY s.created_at DESC
      LIMIT 50
    `, [empId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPER: send client assessment email
// ─────────────────────────────────────────────────────────────────────────────
async function sendClientAssessmentEmail(toEmail, empId, token, clientRepName = null, clientName = null) {
  const { default: nodemailer } = await import('nodemailer');

  // Read all SMTP config from system_config (set via System Settings page)
  const cfgRes = await pool.query(
    `SELECT key, value FROM system_config WHERE key = ANY($1)`,
    [['smtp_host','smtp_port','smtp_user','smtp_pass','company_name','sender_name','frontend_url']]
  );
  const cfg = {};
  cfgRes.rows.forEach(r => { cfg[r.key] = r.value; });

  const smtpUser = cfg.smtp_user;
  const smtpPass = cfg.smtp_pass;

  if (!smtpUser || !smtpPass) {
    logger.warn('SMTP not configured — client assessment email not sent. Configure in System Settings.', { category: 'assessment' });
    return;
  }

  const empRes = await pool.query('SELECT name FROM employees WHERE emp_id = $1', [empId]);
  const empName = empRes.rows[0]?.name || empId;

  // Use configured frontend URL, fall back to env, then hardcoded default
  const baseUrl = cfg.frontend_url || process.env.FRONTEND_URL || 'https://btdadmin.technodevenv.dpdns.org';
  const link    = `${baseUrl}/client-assessment/${token}`;

  const company  = cfg.company_name || 'BTD Building Technologies';
  const sender   = cfg.sender_name  || company;
  const greeting = clientRepName ? `Dear ${clientRepName},` : 'Dear Valued Client,';
  const companyLine = clientName ? ` at ${clientName}` : '';

  const transporter = nodemailer.createTransport({
    host:   cfg.smtp_host || 'smtp.gmail.com',
    port:   parseInt(cfg.smtp_port || '587'),
    secure: parseInt(cfg.smtp_port || '587') === 465,
    auth:   { user: smtpUser, pass: smtpPass },
  });
  await transporter.sendMail({
    from:    `"${sender}" <${smtpUser}>`,
    to:      toEmail,
    subject: `Service Feedback Request — ${empName} | BTD Building Technologies`,
    text: `${greeting}

We hope you are satisfied with the services provided by BTD Building Technologies${companyLine}.

We would appreciate a few minutes of your time to rate the service provided by ${empName} from our team. Your feedback helps us maintain and improve our service quality.

Please click the link below to complete the short assessment:
${link}

This feedback link will expire in 7 days.

Thank you for your time and continued support.

Best regards,
BTD Building Technologies Division`,
  });
  logger.info(`Client assessment email sent: ${empId} → ${toEmail}${clientName ? ` (${clientName})` : ''}`, {
    category: 'assessment', meta: { emp_id: empId, client_rep: clientRepName, client: clientName },
  });
}

// =============================================================================
// SCORE COMPONENT ENDPOINTS
// =============================================================================

// GET /assessment/score-breakdown/:empId
// Returns current component values + history for each component.
// Used by Employee Score mobile tile.
router.get('/score-breakdown/:empId', async (req, res) => {
  const { empId } = req.params;
  try {
    // Current values from view
    const currentRes = await pool.query(`
      SELECT component, value, max_value, session_id, created_at
      FROM employee_score_current
      WHERE employee_id = $1
      ORDER BY component
    `, [empId]);

    // Full history per component (last 10 rows each)
    const historyRes = await pool.query(`
      SELECT component, value, max_value, note, session_id, created_at
      FROM employee_score_components
      WHERE employee_id = $1
      ORDER BY component, id DESC
    `, [empId]);

    // Employee current total
    const empRes = await pool.query(
      'SELECT score, badge FROM employees WHERE emp_id = $1', [empId]
    );

    // Group history by component
    const history = {};
    historyRes.rows.forEach(r => {
      if (!history[r.component]) history[r.component] = [];
      history[r.component].push(r);
    });

    res.json({
      employee_id:  empId,
      total_score:  empRes.rows[0]?.score  ?? 300,
      badge:        empRes.rows[0]?.badge  ?? 'blue',
      components:   currentRes.rows,
      history,
    });
  } catch (err) {
    logger.error(`Score breakdown failed for ${empId}: ${err.message}`, { category: 'assessment' });
    res.status(500).json({ error: err.message });
  }
});

// POST /assessment/seed-employee-components/:empId
// Seeds default score components for a newly created employee.
// Called from employeeRoutes after INSERT INTO employees.
router.post('/seed-employee-components/:empId', async (req, res) => {
  const { empId } = req.params;
  try {
    // Check if already seeded
    const existing = await pool.query(
      'SELECT 1 FROM employee_score_components WHERE employee_id = $1 LIMIT 1', [empId]
    );
    if (existing.rows.length) {
      return res.json({ success: true, seeded: false, message: 'Already seeded' });
    }

    const [qaRes, cliRes, tlRes] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(max_score),125) AS t FROM assessment_criteria WHERE source='qa'          AND is_active=TRUE`),
      pool.query(`SELECT COALESCE(SUM(max_score),325) AS t FROM assessment_criteria WHERE source='client_poll' AND is_active=TRUE`),
      pool.query(`SELECT COALESCE(SUM(max_score),450) AS t FROM assessment_criteria WHERE source='poll_avg'    AND is_active=TRUE`),
    ]);
    const qaMax  = parseFloat(qaRes.rows[0].t);
    const cliMax = parseFloat(cliRes.rows[0].t);
    const tlMax  = parseFloat(tlRes.rows[0].t);
    const qaDef  = Math.floor(75 * qaMax  / (qaMax + cliMax));
    const cliDef = 75 - qaDef;

    await pool.query(`
      INSERT INTO employee_score_components
        (employee_id, component, value, max_value, note)
      VALUES
        ($1, 'tl_rating',     150,    $2, 'default'),
        ($1, 'sup_rating',    150,    $2, 'default'),
        ($1, 'qa',            $3,     $4, 'default'),
        ($1, 'client_poll',   $5,     $6, 'default'),
        ($1, 'auto_punch',    25,     25, 'default'),
        ($1, 'auto_timeline', 25,     25, 'default'),
        ($1, 'auto_qa_late',  25,     25, 'default')
    `, [empId, tlMax, qaDef, qaMax, cliDef, cliMax]);

    // Recalculate score
    await pool.query('SELECT recalculate_employee_score($1)', [empId]);

    logger.info(`Score components seeded for new employee: ${empId}`, { category: 'assessment' });
    res.json({ success: true, seeded: true });
  } catch (err) {
    logger.error(`Seed components failed for ${empId}: ${err.message}`, { category: 'assessment' });
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// EXPERTISE ENDPOINTS
// =============================================================================

// ── GET /assessment/expertise/:empId ─────────────────────────────────────────
// Returns employee's declared expertise with latest endorsements per system.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/expertise/:empId', async (req, res) => {
  const { empId } = req.params;
  try {
    // Get declared systems
    const expertiseRes = await pool.query(`
      SELECT
        ee.id, ee.system_id, ee.added_at,
        s.name  AS system_name,
        p.name  AS portfolio_name,
        p.id    AS portfolio_id
      FROM employee_expertise ee
      JOIN systems    s ON ee.system_id = s.id
      LEFT JOIN portfolios p ON s.portfolio_id = p.id
      WHERE ee.employee_id = $1
      ORDER BY p.name ASC, s.name ASC
    `, [empId]);

    // For each system, get latest endorsements (from most recent submitted session)
    const systems = expertiseRes.rows;
    for (const sys of systems) {
      const endRes = await pool.query(`
        SELECT
          en.endorsement, en.rater_id, en.created_at,
          e.name AS rater_name,
          s.session_type,
          s.submitted_at
        FROM expertise_endorsements en
        JOIN employees e ON en.rater_id = e.emp_id
        JOIN assessment_sessions s ON en.session_id = s.id
        WHERE en.employee_id = $1 AND en.system_id = $2
        ORDER BY s.submitted_at DESC
      `, [empId, sys.system_id]);
      sys.endorsements = endRes.rows;
    }

    res.json(systems);
  } catch (err) {
    logger.error(`Expertise fetch failed for ${empId}: ${err.message}`, { category: 'assessment' });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /assessment/expertise/:empId ────────────────────────────────────────
// Employee adds a system to their expertise.
// Body: { system_id }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/expertise/:empId', async (req, res) => {
  const { empId }    = req.params;
  const { system_id } = req.body;
  if (!system_id) return res.status(400).json({ error: 'system_id required.' });
  try {
    await pool.query(`
      INSERT INTO employee_expertise (employee_id, system_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `, [empId, system_id]);
    logger.info(`Expertise added: emp=${empId} system=${system_id}`, { category: 'assessment' });
    res.json({ success: true });
  } catch (err) {
    logger.error(`Expertise add failed: ${err.message}`, { category: 'assessment' });
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /assessment/expertise/:empId/:systemId ────────────────────────────
// Employee removes a system from their expertise.
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/expertise/:empId/:systemId', async (req, res) => {
  const { empId, systemId } = req.params;
  try {
    await pool.query(
      'DELETE FROM employee_expertise WHERE employee_id = $1 AND system_id = $2',
      [empId, systemId]
    );
    logger.info(`Expertise removed: emp=${empId} system=${systemId}`, { category: 'assessment' });
    res.json({ success: true });
  } catch (err) {
    logger.error(`Expertise remove failed: ${err.message}`, { category: 'assessment' });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /assessment/expertise-endorsements ───────────────────────────────────
// TL/Supervisor records endorsements during an assessment session.
// Body: { session_id, employee_id, rater_id, endorsements: [{ system_id, endorsement }] }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/expertise-endorsements', async (req, res) => {
  const { session_id, employee_id, rater_id, endorsements } = req.body;
  if (!session_id || !employee_id || !rater_id || !endorsements?.length) {
    return res.status(400).json({ error: 'session_id, employee_id, rater_id, endorsements required.' });
  }
  try {
    for (const { system_id, endorsement } of endorsements) {
      await pool.query(`
        INSERT INTO expertise_endorsements
          (session_id, employee_id, system_id, rater_id, endorsement)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (session_id, employee_id, system_id, rater_id)
        DO UPDATE SET endorsement = EXCLUDED.endorsement
      `, [session_id, employee_id, system_id, rater_id, endorsement]);
    }
    logger.info(`Expertise endorsed: emp=${employee_id} by ${rater_id} session=${session_id}`, {
      category: 'assessment',
      meta: { count: endorsements.length },
    });
    res.json({ success: true });
  } catch (err) {
    logger.error(`Expertise endorsement failed: ${err.message}`, { category: 'assessment' });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /assessment/expertise-for-session/:sessionId ─────────────────────────
// Mobile: get employee's expertise list when rater opens a session.
// Used to show endorsement options during by_supervisor / by_tl sessions.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/expertise-for-session/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    // Get the employee from the session
    const sessRes = await pool.query(
      'SELECT employee_id FROM assessment_sessions WHERE id = $1', [sessionId]
    );
    if (!sessRes.rows.length) return res.status(404).json({ error: 'Session not found.' });
    const empId = sessRes.rows[0].employee_id;

    // Get their declared expertise
    const result = await pool.query(`
      SELECT ee.system_id, s.name AS system_name, p.name AS portfolio_name
      FROM employee_expertise ee
      JOIN systems s ON ee.system_id = s.id
      LEFT JOIN portfolios p ON s.portfolio_id = p.id
      WHERE ee.employee_id = $1
      ORDER BY s.name ASC
    `, [empId]);

    res.json({ employee_id: empId, expertise: result.rows });
  } catch (err) {
    logger.error(`Expertise for session failed: ${err.message}`, { category: 'assessment' });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /assessment/all-employees-expertise ───────────────────────────────────
// Admin: get expertise for all employees (for Employees table column).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/all-employees-expertise', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        ee.employee_id,
        JSONB_AGG(JSONB_BUILD_OBJECT(
          'system_id', ee.system_id,
          'system_name', s.name,
          'portfolio_name', p.name
        ) ORDER BY s.name) AS expertise
      FROM employee_expertise ee
      JOIN systems s ON ee.system_id = s.id
      LEFT JOIN portfolios p ON s.portfolio_id = p.id
      GROUP BY ee.employee_id
    `);
    // Return as { emp_id: [...expertise] }
    const map = {};
    result.rows.forEach(r => { map[r.employee_id] = r.expertise; });
    res.json(map);
  } catch (err) {
    logger.error(`All employees expertise failed: ${err.message}`, { category: 'assessment' });
    res.status(500).json({ error: err.message });
  }
});

export default router;

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT helpers for use in the automation cron
// ─────────────────────────────────────────────────────────────────────────────
export { applyScoreDelta, calculateAndApplyPollScore, computeBadge };