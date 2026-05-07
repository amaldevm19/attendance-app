// =============================================================================
// qaRoutes.js  (src/routes/qaRoutes.js)
// Q&A question bank CRUD, assignment, mobile submission, score application.
// =============================================================================

import express from 'express';
import pool    from '../config/db.js';
import { io, connectedDevices } from '../server.js';
import logger  from '../logger.js';
import { applyScoreDelta } from './assessmentRoutes.js';

const router = express.Router();

// Q&A marks structure:
// general_technical  → 5 questions × 10 marks = 50
// ppm_fitout         → 5 questions × 5  marks = 25
// new_systems        → 5 questions × 5  marks = 25
// portfolio_systems  → 5 questions × 5  marks = 25
// Total = 125 (maps to criteria sum for qa source)

const QA_CONFIG = {
  general_technical: { count: 5, marks_each: 10 },
  ppm_fitout:        { count: 5, marks_each: 5  },
  new_systems:       { count: 5, marks_each: 5  },
  portfolio_systems: { count: 5, marks_each: 5  },
};

// ─────────────────────────────────────────────────────────────────────────────
// QUESTION BANK CRUD
// ─────────────────────────────────────────────────────────────────────────────

// GET all questions (with filters)
router.get('/questions', async (req, res) => {
  const { category, level, difficulty, active } = req.query;
  try {
    const conditions = [];
    const params     = [];
    if (category)   { conditions.push(`question_category = $${params.length+1}`); params.push(category); }
    if (level)      { conditions.push(`target_level = $${params.length+1}`);      params.push(parseInt(level)); }
    if (difficulty) { conditions.push(`difficulty = $${params.length+1}`);        params.push(difficulty); }
    if (active !== undefined) {
      conditions.push(`is_active = $${params.length+1}`);
      params.push(active === 'true');
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(`
      SELECT q.*, e.name AS created_by_name
      FROM qa_questions q
      LEFT JOIN employees e ON q.created_by = e.emp_id
      ${where}
      ORDER BY q.question_category ASC, q.difficulty ASC, q.created_at DESC
    `, params);
    res.json(result.rows);
  } catch (err) {
    logger.error(`Fetch questions failed: ${err.message}`, { category: 'qa' });
    res.status(500).json({ error: err.message });
  }
});

// POST create question
router.post('/questions', async (req, res) => {
  const {
    question_text, options, correct_answer, marks,
    difficulty, target_level, question_category, created_by,
  } = req.body;

  if (!question_text || !options || !correct_answer || !question_category) {
    return res.status(400).json({ error: 'question_text, options, correct_answer, question_category required.' });
  }

  try {
    const result = await pool.query(`
      INSERT INTO qa_questions
        (question_text, options, correct_answer, marks, difficulty, target_level, question_category, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      question_text,
      JSON.stringify(options),
      correct_answer,
      marks || QA_CONFIG[question_category]?.marks_each || 5,
      difficulty || 'basic',
      target_level || 3,
      question_category,
      created_by || null,
    ]);
    logger.info(`Question created: ${question_category} by ${created_by}`, { category: 'qa' });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error(`Create question failed: ${err.message}`, { category: 'qa' });
    res.status(500).json({ error: err.message });
  }
});

// PATCH update question
router.patch('/questions/:id', async (req, res) => {
  const { id } = req.params;
  const { question_text, options, correct_answer, marks, difficulty, target_level, is_active } = req.body;
  try {
    await pool.query(`
      UPDATE qa_questions SET
        question_text  = COALESCE($1, question_text),
        options        = COALESCE($2, options),
        correct_answer = COALESCE($3, correct_answer),
        marks          = COALESCE($4, marks),
        difficulty     = COALESCE($5, difficulty),
        target_level   = COALESCE($6, target_level),
        is_active      = COALESCE($7, is_active)
      WHERE id = $8
    `, [question_text, options ? JSON.stringify(options) : null, correct_answer, marks, difficulty, target_level, is_active, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE question (soft delete)
router.delete('/questions/:id', async (req, res) => {
  try {
    await pool.query('UPDATE qa_questions SET is_active = FALSE WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /qa/questions/preview-random/:empId
// Returns a preview of the random question set that would be assigned.
// Admin calls this before confirming the push.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/questions/preview-random/:empId', async (req, res) => {
  const { empId } = req.params;
  try {
    const empRes = await pool.query(
      'SELECT des.level FROM employees e LEFT JOIN designations des ON e.designation_id = des.id WHERE e.emp_id = $1',
      [empId]
    );
    const level = empRes.rows[0]?.level || 3;

    const questions = await pickRandomQuestions(level, empId);
    res.json({ questions, total_marks: questions.reduce((s, q) => s + q.marks, 0) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /qa/assign
// Admin assigns a Q&A set to one or more employees.
// Body: { employee_ids: [], deadline_days: 1, assigned_by }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/assign', async (req, res) => {
  const { employee_ids, deadline_days = 1, assigned_by } = req.body;
  if (!employee_ids?.length) return res.status(400).json({ error: 'employee_ids required.' });

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const assignments = [];

    for (const empId of employee_ids) {
      // Get employee designation level
      const empRes = await dbClient.query(
        'SELECT des.level FROM employees e LEFT JOIN designations des ON e.designation_id = des.id WHERE e.emp_id = $1',
        [empId]
      );
      const level = empRes.rows[0]?.level || 3;

      // Pick random questions — portfolio-aware
      const questions = await pickRandomQuestions(level, empId);
      if (!questions.length) continue;

      const questionIds  = questions.map(q => q.id);
      const totalMarks   = questions.reduce((s, q) => s + q.marks, 0);
      const deadline     = new Date();
      deadline.setDate(deadline.getDate() + deadline_days);

      const assignRes = await dbClient.query(`
        INSERT INTO qa_assignments
          (employee_id, question_ids, total_marks, deadline, deadline_days, assigned_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `, [empId, questionIds, totalMarks, deadline, deadline_days, assigned_by || null]);

      const assignment = assignRes.rows[0];
      assignments.push(assignment);

      // Push to employee's devices
      const devRes = await dbClient.query(`
        SELECT d.id AS device_id, d.device_unique_id
        FROM employee_devices ed
        JOIN devices d ON ed.device_id = d.id
        WHERE ed.employee_id = $1 AND d.is_active = TRUE
      `, [empId]);

      for (const dev of devRes.rows) {
        await dbClient.query(`
          INSERT INTO pending_qa_tasks (device_id, assignment_id)
          VALUES ($1, $2) ON CONFLICT DO NOTHING
        `, [dev.device_id, assignment.id]);

        const socketId = connectedDevices.get(dev.device_unique_id);
        if (socketId) {
          io.to(socketId).emit('new-qa-task', { assignment_id: assignment.id });
        }
      }

      logger.info(`Q&A assigned: ${empId} — ${questions.length} questions, deadline ${deadline_days}d`, {
        category: 'qa', user_id: assigned_by,
        meta: { assignment_id: assignment.id, question_ids: questionIds },
      });
    }

    await dbClient.query('COMMIT');
    io.emit('dashboard-update');
    res.json({ success: true, assigned: assignments.length, assignments });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    logger.error(`Q&A assign failed: ${err.message}`, { category: 'qa' });
    res.status(500).json({ error: err.message });
  } finally {
    dbClient.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /qa/pending-qa-tasks/:deviceId
// Mobile calls to get pending Q&A assignments for this device.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/pending-qa-tasks/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  try {
    const result = await pool.query(`
      SELECT
        pqt.id  AS task_id,
        qa.id   AS assignment_id,
        qa.deadline,
        qa.deadline_days,
        qa.total_marks,
        qa.status AS assignment_status,
        e.emp_id, e.name AS employee_name, e.badge, e.score, e.designation,
        e.email
      FROM pending_qa_tasks pqt
      JOIN devices d ON pqt.device_id = d.id
      JOIN qa_assignments qa ON pqt.assignment_id = qa.id
      JOIN employees e ON qa.employee_id = e.emp_id
      WHERE d.device_unique_id = $1
        AND qa.status = 'pending'
        AND qa.deadline > NOW()
      ORDER BY qa.created_at DESC
    `, [deviceId]);
    res.json(result.rows);
  } catch (err) {
    logger.error(`Pending QA tasks failed: ${err.message}`, { category: 'qa' });
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /qa/assignment/:assignmentId/questions
// Mobile fetches the actual question content for an assignment.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/assignment/:assignmentId/questions', async (req, res) => {
  const { assignmentId } = req.params;
  try {
    const assignRes = await pool.query(
      'SELECT question_ids, employee_id FROM qa_assignments WHERE id = $1', [assignmentId]
    );
    if (!assignRes.rows.length) return res.status(404).json({ error: 'Assignment not found.' });

    const { question_ids, employee_id } = assignRes.rows[0];

    const qRes = await pool.query(`
      SELECT id, question_text, options, marks, difficulty, question_category
      FROM qa_questions
      WHERE id = ANY($1::int[])
      ORDER BY question_category, difficulty
    `, [question_ids]);

    // Randomise order for anti-cheating
    const shuffled = qRes.rows.sort(() => Math.random() - 0.5);
    res.json(shuffled);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /qa/submit/:assignmentId
// Mobile submits answers.
// Body: { answers: [{ question_id, selected_answer }], emp_id, send_email? }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/submit/:assignmentId', async (req, res) => {
  const { assignmentId } = req.params;
  const { answers, emp_id, send_email = false } = req.body;

  if (!answers?.length) return res.status(400).json({ error: 'answers required.' });

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    const assignRes = await dbClient.query(
      'SELECT * FROM qa_assignments WHERE id = $1', [assignmentId]
    );
    if (!assignRes.rows.length) { await dbClient.query('ROLLBACK'); return res.status(404).json({ error: 'Assignment not found.' }); }
    const assignment = assignRes.rows[0];

    if (assignment.status === 'submitted') { await dbClient.query('ROLLBACK'); return res.status(409).json({ error: 'Already submitted.' }); }
    if (new Date(assignment.deadline) < new Date()) { await dbClient.query('ROLLBACK'); return res.status(410).json({ error: 'Deadline passed.' }); }

    // Fetch correct answers
    const qRes = await dbClient.query(
      'SELECT id, correct_answer, marks FROM qa_questions WHERE id = ANY($1::int[])',
      [assignment.question_ids]
    );
    const correctMap = {};
    qRes.rows.forEach(q => { correctMap[q.id] = { correct: q.correct_answer, marks: q.marks }; });

    let totalEarned = 0;
    const answerRows = [];

    for (const ans of answers) {
      const q         = correctMap[ans.question_id];
      if (!q) continue;
      const isCorrect   = ans.selected_answer === q.correct;
      const marksEarned = isCorrect ? q.marks : 0;
      totalEarned += marksEarned;
      answerRows.push({ question_id: ans.question_id, selected: ans.selected_answer, correct: isCorrect, marks: marksEarned });
    }

    // Insert answers
    for (const a of answerRows) {
      await dbClient.query(`
        INSERT INTO qa_answers (assignment_id, question_id, selected_answer, is_correct, marks_earned)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT (assignment_id, question_id) DO UPDATE
        SET selected_answer=$3, is_correct=$4, marks_earned=$5
      `, [assignmentId, a.question_id, a.selected, a.correct, a.marks]);
    }

    // Map QA score to criteria max and compute delta
    // qa source criteria total max = 50+25+25+25 = 125 (same as totalMarks)
    const criteriaRes = await dbClient.query(
      `SELECT COALESCE(SUM(max_score),0) AS total FROM assessment_criteria WHERE source='qa' AND is_active=TRUE`
    );
    const criteriaMax = parseInt(criteriaRes.rows[0].total); // 125
    const scoreDelta  = assignment.total_marks > 0
      ? Math.round((totalEarned / assignment.total_marks) * criteriaMax)
      : 0;

    // Update assignment
    await dbClient.query(`
      UPDATE qa_assignments
      SET status='submitted', submitted_at=NOW(), score_achieved=$1, score_delta=$2
      WHERE id=$3
    `, [totalEarned, scoreDelta, assignmentId]);

    // Remove from pending tasks
    await dbClient.query('DELETE FROM pending_qa_tasks WHERE assignment_id = $1', [assignmentId]);

    // Apply score delta
    if (scoreDelta > 0) {
      await applyScoreDelta(dbClient, assignment.employee_id, scoreDelta, 'qa_result', null, parseInt(assignmentId));
    }

    await dbClient.query('COMMIT');

    // Send email if requested
    if (send_email) {
      sendQAResultEmail(assignment.employee_id, assignmentId, answerRows, totalEarned, assignment.total_marks)
        .catch(e => logger.warn(`QA email failed: ${e.message}`, { category: 'qa' }));
    }

    io.emit('dashboard-update');

    logger.info(`Q&A submitted: assignment ${assignmentId} by ${emp_id} — ${totalEarned}/${assignment.total_marks} marks`, {
      category: 'qa', user_id: emp_id,
      meta: { score_delta: scoreDelta, correct: answerRows.filter(a => a.correct).length },
    });

    res.json({
      success: true,
      marks_earned: totalEarned,
      total_marks: assignment.total_marks,
      score_delta: scoreDelta,
      breakdown: answerRows,
    });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    logger.error(`Q&A submit failed: ${err.message}`, { category: 'qa' });
    res.status(500).json({ error: err.message });
  } finally {
    dbClient.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /qa/assignments (admin list view)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/assignments', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        qa.*,
        e.name AS employee_name, e.designation, e.score, e.badge,
        assigner.name AS assigned_by_name
      FROM qa_assignments qa
      JOIN employees e ON qa.employee_id = e.emp_id
      LEFT JOIN employees assigner ON qa.assigned_by = assigner.emp_id
      ORDER BY qa.created_at DESC
      LIMIT 200
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: pick random questions for all 4 categories — portfolio-aware
//
// general_technical: any question in category, no system filter
// ppm_fitout:        any question in category, no system filter
// portfolio_systems: questions tagged to systems IN the employee's portfolio
// new_systems:       questions tagged to systems NOT in the employee's portfolio
// ─────────────────────────────────────────────────────────────────────────────
async function pickRandomQuestions(designationLevel, empId = null) {
  const questions = [];

  // Get employee's portfolio system IDs (if empId provided)
  let portfolioSystemIds = [];
  if (empId) {
    const pfRes = await pool.query(`
      SELECT DISTINCT s.id
      FROM employee_portfolios ep
      JOIN portfolios p ON ep.portfolio_id = p.id
      JOIN systems s ON s.portfolio_id = p.id
      WHERE ep.emp_id = $1
    `, [empId]);
    portfolioSystemIds = pfRes.rows.map(r => r.id);
  }

  for (const [category, config] of Object.entries(QA_CONFIG)) {
    let queryText;
    let queryParams;

    if (category === 'portfolio_systems') {
      if (portfolioSystemIds.length === 0) {
        // Employee has no portfolio — skip, can't pick portfolio questions
        continue;
      }
      // Questions tagged to systems IN employee's portfolio
      queryText = `
        SELECT id, question_text, options, correct_answer, marks, difficulty, question_category, system_id
        FROM qa_questions
        WHERE question_category = $1
          AND target_level >= $2
          AND is_active = TRUE
          AND system_id = ANY($3::int[])
        ORDER BY RANDOM()
        LIMIT $4
      `;
      queryParams = [category, designationLevel, portfolioSystemIds, config.count];

    } else if (category === 'new_systems') {
      // Questions tagged to systems NOT in employee's portfolio
      // If employee has no portfolio, all systems are "new" — pick any
      if (portfolioSystemIds.length === 0) {
        queryText = `
          SELECT id, question_text, options, correct_answer, marks, difficulty, question_category, system_id
          FROM qa_questions
          WHERE question_category = $1
            AND target_level >= $2
            AND is_active = TRUE
          ORDER BY RANDOM()
          LIMIT $3
        `;
        queryParams = [category, designationLevel, config.count];
      } else {
        queryText = `
          SELECT id, question_text, options, correct_answer, marks, difficulty, question_category, system_id
          FROM qa_questions
          WHERE question_category = $1
            AND target_level >= $2
            AND is_active = TRUE
            AND (system_id IS NULL OR system_id <> ALL($3::int[]))
          ORDER BY RANDOM()
          LIMIT $4
        `;
        queryParams = [category, designationLevel, portfolioSystemIds, config.count];
      }

    } else {
      // general_technical and ppm_fitout — no system filter needed
      queryText = `
        SELECT id, question_text, options, correct_answer, marks, difficulty, question_category, system_id
        FROM qa_questions
        WHERE question_category = $1
          AND target_level >= $2
          AND is_active = TRUE
        ORDER BY RANDOM()
        LIMIT $3
      `;
      queryParams = [category, designationLevel, config.count];
    }

    const result = await pool.query(queryText, queryParams);
    result.rows.forEach(q => { q.marks = config.marks_each; });
    questions.push(...result.rows);
  }
  return questions;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: send Q&A result email
// ─────────────────────────────────────────────────────────────────────────────
async function sendQAResultEmail(empId, assignmentId, answerRows, earned, total) {
  const { default: nodemailer } = await import('nodemailer');
  const smtpUser = (await pool.query(`SELECT value FROM system_config WHERE key='smtp_user'`)).rows[0]?.value;
  const smtpPass = (await pool.query(`SELECT value FROM system_config WHERE key='smtp_pass'`)).rows[0]?.value;
  if (!smtpUser || !smtpPass) return;

  const empRes = await pool.query('SELECT name, email FROM employees WHERE emp_id = $1', [empId]);
  const { name, email } = empRes.rows[0] || {};
  if (!email) return;

  const qRes = await pool.query(
    'SELECT id, question_text, correct_answer, options FROM qa_questions WHERE id = ANY($1::int[])',
    [answerRows.map(a => a.question_id)]
  );
  const qMap = {};
  qRes.rows.forEach(q => { qMap[q.id] = q; });

  const lines = answerRows.map(a => {
    const q = qMap[a.question_id];
    return `Q: ${q?.question_text}\nYour answer: ${a.selected} | Correct: ${q?.correct_answer} | ${a.correct ? '✓' : '✗'} (${a.marks} marks)`;
  }).join('\n\n');

  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: smtpUser, pass: smtpPass } });
  await transporter.sendMail({
    from:    `"BTD Assessment" <${smtpUser}>`,
    to:      email,
    subject: `Your Q&A Results — ${earned}/${total} marks`,
    text:    `Hi ${name},\n\nHere are your Q&A results:\n\nTotal: ${earned}/${total} marks\n\n${lines}\n\n— BTD Building Technologies`,
  });
}

export default router;