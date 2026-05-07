// =============================================================================
// assessmentCron.js  (src/utils/assessmentCron.js)
// Runs periodically to:
//   1. Push automated assessment sessions + Q&A assignments
//   2. Expire overdue sessions and apply partial scores
//   3. Apply timeliness deductions for late Q&A
// Import and call startAssessmentCron() once from server.js
// =============================================================================

import pool   from '../config/db.js';
import logger from '../logger.js';
import { applyScoreDelta, calculateAndApplyPollScore } from '../routes/assessmentRoutes.js';
import crypto from 'crypto';
import { io, connectedDevices } from '../server.js';

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SWEEP — runs every hour
// ─────────────────────────────────────────────────────────────────────────────
async function runAssessmentSweep() {
  logger.info('Assessment cron sweep started', { category: 'system' });
  await Promise.allSettled([
    expireOverdueSessions(),
    expireOverdueQA(),
    runAutomatedPushIfDue(),
  ]);
  logger.info('Assessment cron sweep complete', { category: 'system' });
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPIRE OVERDUE SESSIONS — apply partial score if one side submitted
// ─────────────────────────────────────────────────────────────────────────────
async function expireOverdueSessions() {
  const client = await pool.connect();
  try {
    // Find pending sessions past deadline
    const overdue = await client.query(`
      SELECT * FROM assessment_sessions
      WHERE status = 'pending'
        AND deadline < NOW()
    `);

    for (const session of overdue.rows) {
      await client.query('BEGIN');
      try {
        await client.query(
          `UPDATE assessment_sessions SET status = 'expired' WHERE id = $1`,
          [session.id]
        );

        // For by_supervisor / by_tl — check if partner submitted; apply partial
        if (['by_supervisor', 'by_tl'].includes(session.session_type)) {
          const partnerRes = await client.query(`
            SELECT id FROM assessment_sessions
            WHERE employee_id = $1
              AND session_type IN ('by_supervisor','by_tl')
              AND status = 'submitted'
              AND id != $2
            LIMIT 1
          `, [session.employee_id, session.id]);

          if (partnerRes.rows.length > 0) {
            // Partner submitted but this one didn't — apply partial score from partner only
            await calculateAndApplyPollScore(client, partnerRes.rows[0], true);
          }
        }

        // Remove from pending tasks
        await client.query('DELETE FROM pending_assessment_tasks WHERE session_id = $1', [session.id]);

        await client.query('COMMIT');
        logger.info(`Assessment session ${session.id} expired for ${session.employee_id}`, { category: 'system' });
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error(`Expire session ${session.id} failed: ${err.message}`, { category: 'system' });
      }
    }
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPIRE OVERDUE Q&A — mark expired + deduct timeliness score
// ─────────────────────────────────────────────────────────────────────────────
async function expireOverdueQA() {
  const client = await pool.connect();
  try {
    const overdue = await client.query(`
      SELECT * FROM qa_assignments
      WHERE status = 'pending' AND deadline < NOW()
    `);

    for (const assignment of overdue.rows) {
      await client.query('BEGIN');
      try {
        await client.query(
          `UPDATE qa_assignments SET status = 'expired' WHERE id = $1`,
          [assignment.id]
        );
        await client.query('DELETE FROM pending_qa_tasks WHERE assignment_id = $1', [assignment.id]);

        // Deduct 5 points for Q&A timeliness (auto_qa)
        await applyScoreDelta(client, assignment.employee_id, -5, 'qa_late', null, assignment.id);

        await client.query('COMMIT');
        logger.warn(`Q&A assignment ${assignment.id} expired for ${assignment.employee_id} — timeliness deduction applied`, {
          category: 'system',
        });
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error(`Expire Q&A ${assignment.id} failed: ${err.message}`, { category: 'system' });
      }
    }
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTOMATED PUSH — runs when next_run_at has passed
// ─────────────────────────────────────────────────────────────────────────────
async function runAutomatedPushIfDue() {
  const client = await pool.connect();
  try {
    const settingsRes = await client.query(`
      SELECT * FROM assessment_automation_settings
      WHERE is_enabled = TRUE AND next_run_at IS NOT NULL AND next_run_at <= NOW()
      LIMIT 1
    `);
    if (!settingsRes.rows.length) return;
    const settings = settingsRes.rows[0];

    // Fetch employees matching target_levels
    const empRes = await client.query(`
      SELECT e.emp_id, e.email, des.level AS designation_level,
             e.reports_to
      FROM employees e
      LEFT JOIN designations des ON e.designation_id = des.id
      WHERE des.level = ANY($1::int[])
        AND e.emp_id IS NOT NULL
    `, [settings.target_levels]);

    const employees = empRes.rows;
    let pushCount = 0;

    // Assessment push
    if (['assessment', 'both'].includes(settings.push_type)) {
      for (const emp of employees) {
        for (const sessionType of settings.session_types) {
          try {
            await createAutomatedSession(client, emp, sessionType, settings.qa_deadline_days);
            pushCount++;
          } catch (err) {
            logger.warn(`Auto session failed for ${emp.emp_id}: ${err.message}`, { category: 'system' });
          }
        }
      }
    }

    // Q&A push
    if (['qa', 'both'].includes(settings.push_type)) {
      for (const emp of employees) {
        try {
          await createAutomatedQA(client, emp, settings.qa_deadline_days);
          pushCount++;
        } catch (err) {
          logger.warn(`Auto QA failed for ${emp.emp_id}: ${err.message}`, { category: 'system' });
        }
      }
    }

    // Calculate next run time
    const nextRun = new Date();
    if (settings.frequency === 'daily')   nextRun.setDate(nextRun.getDate() + 1);
    if (settings.frequency === 'weekly')  nextRun.setDate(nextRun.getDate() + 7);
    if (settings.frequency === 'monthly') nextRun.setMonth(nextRun.getMonth() + 1);

    await client.query(`
      UPDATE assessment_automation_settings
      SET next_run_at = $1, last_run_at = NOW(), last_run_count = $2
      WHERE id = $3
    `, [nextRun, pushCount, settings.id]);

    io.emit('dashboard-update');
    logger.info(`Automated assessment push complete: ${pushCount} sessions/assignments created`, { category: 'system' });
  } finally {
    client.release();
  }
}

async function createAutomatedSession(client, emp, sessionType, deadlineDays) {
  let respondentId = null;

  if (sessionType === 'self') {
    respondentId = emp.emp_id;
  } else if (sessionType === 'by_supervisor') {
    respondentId = emp.reports_to;
  } else if (sessionType === 'by_tl') {
    if (emp.reports_to) {
      const tlRes = await client.query('SELECT reports_to FROM employees WHERE emp_id = $1', [emp.reports_to]);
      respondentId = tlRes.rows[0]?.reports_to || emp.reports_to;
    }
  }

  if (!respondentId && !['client'].includes(sessionType)) return;

  const deadline = new Date();
  deadline.setDate(deadline.getDate() + deadlineDays);

  const sessRes = await client.query(`
    INSERT INTO assessment_sessions
      (employee_id, session_type, respondent_id, deadline, is_automated, automation_period)
    VALUES ($1, $2, $3, $4, TRUE, 'auto')
    RETURNING *
  `, [emp.emp_id, sessionType, respondentId, deadline]);

  const session = sessRes.rows[0];

  // Push to devices
  if (respondentId) {
    const devRes = await client.query(`
      SELECT d.id AS device_id, d.device_unique_id
      FROM employee_devices ed JOIN devices d ON ed.device_id = d.id
      WHERE ed.employee_id = $1 AND d.is_active = TRUE
    `, [respondentId]);

    for (const dev of devRes.rows) {
      await client.query(
        'INSERT INTO pending_assessment_tasks (device_id, session_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [dev.device_id, session.id]
      );
      const socketId = connectedDevices.get(dev.device_unique_id);
      if (socketId) io.to(socketId).emit('new-assessment-task', { session_id: session.id, session_type: sessionType });
    }
  }
}

async function createAutomatedQA(client, emp, deadlineDays) {
  // Lazy import to avoid circular dep
  const { default: qaModule } = await import('../routes/qaRoutes.js');

  const empRes = await client.query(
    'SELECT des.level FROM employees e LEFT JOIN designations des ON e.designation_id = des.id WHERE e.emp_id = $1',
    [emp.emp_id]
  );
  const level = empRes.rows[0]?.level || 3;

  // Pick questions
  const QA_CONFIG = {
    general_technical: { count: 5, marks_each: 10 },
    ppm_fitout:        { count: 5, marks_each: 5  },
    new_systems:       { count: 5, marks_each: 5  },
    portfolio_systems: { count: 5, marks_each: 5  },
  };

  // Get employee's portfolio system IDs for portfolio-aware selection
  const pfRes = await client.query(`
    SELECT DISTINCT s.id FROM employee_portfolios ep
    JOIN portfolios p ON ep.portfolio_id = p.id
    JOIN systems s ON s.portfolio_id = p.id
    WHERE ep.emp_id = $1
  `, [emp.emp_id]);
  const portfolioSystemIds = pfRes.rows.map(r => r.id);

  const questions = [];
  for (const [category, config] of Object.entries(QA_CONFIG)) {
    let res;
    if (category === 'portfolio_systems' && portfolioSystemIds.length > 0) {
      res = await client.query(`
        SELECT id, marks FROM qa_questions
        WHERE question_category = $1 AND target_level >= $2 AND is_active = TRUE
          AND system_id = ANY($3::int[])
        ORDER BY RANDOM() LIMIT $4
      `, [category, level, portfolioSystemIds, config.count]);
    } else if (category === 'new_systems' && portfolioSystemIds.length > 0) {
      res = await client.query(`
        SELECT id, marks FROM qa_questions
        WHERE question_category = $1 AND target_level >= $2 AND is_active = TRUE
          AND (system_id IS NULL OR system_id <> ALL($3::int[]))
        ORDER BY RANDOM() LIMIT $4
      `, [category, level, portfolioSystemIds, config.count]);
    } else {
      res = await client.query(`
        SELECT id, marks FROM qa_questions
        WHERE question_category = $1 AND target_level >= $2 AND is_active = TRUE
        ORDER BY RANDOM() LIMIT $3
      `, [category, level, config.count]);
    }
    res.rows.forEach(q => { q.marks = config.marks_each; });
    questions.push(...res.rows);
  }
  if (!questions.length) return;

  const questionIds = questions.map(q => q.id);
  const totalMarks  = questions.reduce((s, q) => s + q.marks, 0);
  const deadline    = new Date();
  deadline.setDate(deadline.getDate() + deadlineDays);

  const assignRes = await client.query(`
    INSERT INTO qa_assignments (employee_id, question_ids, total_marks, deadline, deadline_days, is_automated)
    VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING *
  `, [emp.emp_id, questionIds, totalMarks, deadline, deadlineDays]);

  const assignment = assignRes.rows[0];

  const devRes = await client.query(`
    SELECT d.id AS device_id, d.device_unique_id
    FROM employee_devices ed JOIN devices d ON ed.device_id = d.id
    WHERE ed.employee_id = $1 AND d.is_active = TRUE
  `, [emp.emp_id]);

  for (const dev of devRes.rows) {
    await client.query(
      'INSERT INTO pending_qa_tasks (device_id, assignment_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [dev.device_id, assignment.id]
    );
    const socketId = connectedDevices.get(dev.device_unique_id);
    if (socketId) io.to(socketId).emit('new-qa-task', { assignment_id: assignment.id });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTED STARTER
// ─────────────────────────────────────────────────────────────────────────────
export function startAssessmentCron() {
  runAssessmentSweep();
  setInterval(runAssessmentSweep, 60 * 60 * 1000); // every hour
  logger.info('Assessment automation cron started (runs every 1h)', { category: 'system' });
}