// =============================================================================
// notificationService.js  (src/utils/notificationService.js)
// Handles email (Nodemailer/Gmail SMTP) + WhatsApp (CallMeBot) notifications.
// Credentials are read from the system_config table at send-time so they can
// be updated in the admin UI without a server restart.
// =============================================================================

import nodemailer from 'nodemailer';
import pool from '../config/db.js';
import logger from '../logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: fetch a system_config value by key
// ─────────────────────────────────────────────────────────────────────────────
async function getConfig(key) {
  const res = await pool.query(
    'SELECT value FROM system_config WHERE key = $1',
    [key]
  );
  return res.rows[0]?.value || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: build a one-shot Nodemailer transporter using Gmail SMTP creds
// stored in system_config (keys: smtp_user, smtp_pass).
// ─────────────────────────────────────────────────────────────────────────────
async function getTransporter() {
  const user = await getConfig('smtp_user');
  const pass = await getConfig('smtp_pass');

  if (!user || !pass) {
    throw new Error('SMTP credentials not configured in system_config.');
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: send a WhatsApp message via CallMeBot API
// Each employee can have a whatsapp_api_key stored in system_config under
// key pattern:  whatsapp_key_<emp_id>
// and their phone under the employees table (employees.phone).
// ─────────────────────────────────────────────────────────────────────────────
async function sendWhatsApp(empId, message) {
  try {
    const apiKey = await getConfig(`whatsapp_key_${empId}`);
    const phoneRes = await pool.query(
      'SELECT phone FROM employees WHERE emp_id = $1',
      [empId]
    );
    const phone = phoneRes.rows[0]?.phone;

    if (!apiKey || !phone) {
      logger.warn(`WhatsApp skipped for ${empId}: missing api_key or phone`, {
        category: 'notification',
      });
      return;
    }

    // CallMeBot endpoint
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(message)}&apikey=${apiKey}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`CallMeBot returned ${response.status}`);
    }

    logger.info(`WhatsApp sent to ${empId}`, { category: 'notification' });
  } catch (err) {
    logger.warn(`WhatsApp failed for ${empId}: ${err.message}`, {
      category: 'notification',
    });
    // Non-fatal — do not rethrow
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: fetch employee name + email by emp_id
// ─────────────────────────────────────────────────────────────────────────────
async function getEmployee(empId) {
  const res = await pool.query(
    'SELECT emp_id, name, email, phone FROM employees WHERE emp_id = $1',
    [empId]
  );
  return res.rows[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTED: notifyTL
// Triggered when an employee submits a correction or special punch.
// type: 'correction' | 'special_punch'
// payload: { emp_id, proposed_out_time?, reason, sub_type?, punch_time?, site_id? }
// ─────────────────────────────────────────────────────────────────────────────
export async function notifyTL(tlEmpId, type, payload) {
  try {
    const tl  = await getEmployee(tlEmpId);
    const emp = await getEmployee(payload.emp_id);
    if (!tl || !tl.email) return;

    const transporter = await getTransporter();
    const fromEmail   = await getConfig('smtp_user');

    let subject, text;

    if (type === 'correction') {
      subject = `[BTD Attendance] Correction Request from ${emp?.name || payload.emp_id}`;
      text = `
Dear ${tl.name},

${emp?.name || payload.emp_id} has submitted a correction request for a missed punch-out.

Details:
  Employee  : ${emp?.name} (${payload.emp_id})
  Reason    : ${payload.reason}
  Proposed Out Time: ${payload.proposed_out_time ? new Date(payload.proposed_out_time).toLocaleString('en-AE', { timeZone: 'Asia/Dubai' }) : 'N/A'}

Please open the BTD Attendance app to approve or reject this request.

— BTD Attendance System
      `.trim();
    } else {
      // special_punch
      subject = `[BTD Attendance] Special Punch Approval Required — ${emp?.name || payload.emp_id}`;
      text = `
Dear ${tl.name},

${emp?.name || payload.emp_id} has submitted a special punch from an unauthorized location.

Details:
  Employee  : ${emp?.name} (${payload.emp_id})
  Activity  : ${payload.sub_type || 'N/A'}
  Reason    : ${payload.reason}
  Time      : ${payload.punch_time ? new Date(payload.punch_time).toLocaleString('en-AE', { timeZone: 'Asia/Dubai' }) : 'N/A'}

Please open the BTD Attendance app to approve or reject this request.

— BTD Attendance System
      `.trim();
    }

    await transporter.sendMail({
      from:    `"BTD Attendance" <${fromEmail}>`,
      to:      tl.email,
      subject,
      text,
    });

    logger.info(`Email sent to TL ${tlEmpId} [${type}]`, { category: 'notification' });

    // WhatsApp
    await sendWhatsApp(tlEmpId, `${subject}\n\n${text.substring(0, 200)}...`);
  } catch (err) {
    logger.error(`notifyTL failed for ${tlEmpId}: ${err.message}`, {
      category: 'notification',
    });
    // Non-fatal — caller uses .catch()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTED: notifyEmployee
// Triggered after TL approves or rejects a request.
// type: 'correction_approved' | 'correction_rejected'
// ─────────────────────────────────────────────────────────────────────────────
export async function notifyEmployee(empId, type, payload) {
  try {
    const emp = await getEmployee(empId);
    if (!emp || !emp.email) return;

    const transporter = await getTransporter();
    const fromEmail   = await getConfig('smtp_user');

    let subject, text;

    if (type === 'correction_approved') {
      subject = `[BTD Attendance] Your ${payload.request_type === 'special_punch' ? 'Special Punch' : 'Correction'} has been Approved`;
      text = `
Dear ${emp.name},

Your attendance correction / special punch request has been approved by your Team Lead.

${payload.tl_comment ? `TL Comment: ${payload.tl_comment}` : ''}

The punch has been recorded in the system.

— BTD Attendance System
      `.trim();
    } else {
      subject = `[BTD Attendance] Your ${payload.request_type === 'special_punch' ? 'Special Punch' : 'Correction'} has been Rejected`;
      text = `
Dear ${emp.name},

Your attendance correction / special punch request has been rejected by your Team Lead.

${payload.tl_comment ? `Reason: ${payload.tl_comment}` : ''}

Note: This rejection has been noted against your attendance record. For queries, please contact your Team Lead.

— BTD Attendance System
      `.trim();
    }

    await transporter.sendMail({
      from:    `"BTD Attendance" <${fromEmail}>`,
      to:      emp.email,
      subject,
      text,
    });

    logger.info(`Email sent to employee ${empId} [${type}]`, { category: 'notification' });

    await sendWhatsApp(empId, `${subject}\n\n${text.substring(0, 200)}...`);
  } catch (err) {
    logger.error(`notifyEmployee failed for ${empId}: ${err.message}`, {
      category: 'notification',
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTED: notifyPM
// Triggered on rejection — notifies the Project Manager above the TL.
// pm: { emp_id, email } object from DB query
// ─────────────────────────────────────────────────────────────────────────────
export async function notifyPM(pm, empId, payload) {
  try {
    if (!pm?.email) return;

    const emp         = await getEmployee(empId);
    const transporter = await getTransporter();
    const fromEmail   = await getConfig('smtp_user');

    const subject = `[BTD Attendance] Correction Rejected — ${emp?.name || empId}`;
    const text = `
Dear Project Manager,

A correction request submitted by ${emp?.name || empId} has been rejected by their Team Lead.

Details:
  Employee      : ${emp?.name} (${empId})
  Request Type  : ${payload.request_type || 'N/A'}
  TL Comment    : ${payload.tl_comment || 'No comment provided'}

A score reduction has been applied to the employee's record.

— BTD Attendance System
    `.trim();

    await transporter.sendMail({
      from:    `"BTD Attendance" <${fromEmail}>`,
      to:      pm.email,
      subject,
      text,
    });

    logger.info(`Email sent to PM ${pm.emp_id} for rejected correction of ${empId}`, {
      category: 'notification',
    });
  } catch (err) {
    logger.error(`notifyPM failed: ${err.message}`, { category: 'notification' });
  }
}


// =============================================================================
// EXPORTED: getApproverChain
// Resolves the full approver chain for an employee based on their role.
//
// Rules:
//   Technician  → [Supervisor, Team Lead, Admin]
//   Supervisor  → [Team Lead, Admin]
//   Team Lead   → [Admin]
//   Admin/other → [Admin]  (fallback)
//
// Walks the reports_to chain upward from the submitter.
// Returns array of { emp_id, name, email, phone, role_name } — all approvers
// who should see and be notified of this request.
// =============================================================================
export async function getApproverChain(empId) {
  try {
    // Fetch submitter's role
    const submitterRes = await pool.query(`
      SELECT e.emp_id, r.name AS role_name
      FROM employees e
      LEFT JOIN roles r ON e.role_id = r.id
      WHERE e.emp_id = $1
    `, [empId]);

    const submitterRole = submitterRes.rows[0]?.role_name || '';

    // Determine how many levels up we need to go
    // Technician → 3 levels, Supervisor → 2 levels, Team Lead → 1 level
    const levelMap = {
      'Technician': 3,
      'Supervisor':  2,
      'Team Lead':   1,
    };
    const maxLevels = levelMap[submitterRole] ?? 1;

    const approvers = [];
    const seen = new Set();
    let currentId = empId;

    for (let i = 0; i < maxLevels; i++) {
      const res = await pool.query(`
        SELECT e.emp_id, e.name, e.email, e.phone, r.name AS role_name
        FROM employees e
        LEFT JOIN roles r ON e.role_id = r.id
        WHERE e.emp_id = (
          SELECT reports_to FROM employees WHERE emp_id = $1
        )
      `, [currentId]);

      const approver = res.rows[0];
      if (!approver || seen.has(approver.emp_id)) break;

      seen.add(approver.emp_id);
      approvers.push(approver);
      currentId = approver.emp_id;

      // If we've reached Admin, stop — Admin is always the top
      if (approver.role_name === 'Admin') break;
    }

    // Always ensure Admin is included if not already in chain
    if (!approvers.some(a => a.role_name === 'Admin')) {
      const adminRes = await pool.query(`
        SELECT e.emp_id, e.name, e.email, e.phone, r.name AS role_name
        FROM employees e
        JOIN roles r ON e.role_id = r.id
        WHERE LOWER(r.name) = 'admin'
        ORDER BY e.created_at ASC
        LIMIT 1
      `);
      const admin = adminRes.rows[0];
      if (admin && !seen.has(admin.emp_id)) {
        approvers.push(admin);
      }
    }

    return approvers; // ordered: closest approver first → Admin last
  } catch (err) {
    logger.error(`getApproverChain failed for ${empId}: ${err.message}`, {
      category: 'notification',
    });
    return [];
  }
}

// =============================================================================
// EXPORTED: insertApprovalReviewers
// Inserts rows into approval_reviewers table for each approver in the chain.
// Called right after INSERT INTO approval_requests.
// client: pg PoolClient (already in transaction)
// =============================================================================
export async function insertApprovalReviewers(client, approvalRequestId, approvers) {
  for (const approver of approvers) {
    await client.query(`
      INSERT INTO approval_reviewers (approval_request_id, reviewer_emp_id, role_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (approval_request_id, reviewer_emp_id) DO NOTHING
    `, [approvalRequestId, approver.emp_id, approver.role_name || null]);
  }
}

// =============================================================================
// EXPORTED: notifyApprovers
// Replaces all notifyTL + notifyTLSocket calls.
// Resolves the full approver chain for empId, then:
//   - Emits socket event to each approver's emp room
//   - Sends email + WhatsApp to each approver
//
// io: socket.io Server instance (passed in to avoid circular imports)
// event: socket event name e.g. 'new-approval-task'
// socketPayload: object emitted via socket
// type: email template type ('correction' | 'special_punch' | 'long_duty')
// emailPayload: { emp_id, reason, sub_type?, proposed_out_time?, punch_time? }
// =============================================================================
export async function notifyApprovers(io, empId, event, socketPayload, type, emailPayload) {
  try {
    const approvers = await getApproverChain(empId);
    if (!approvers.length) {
      logger.warn(`notifyApprovers: no approvers found for ${empId}`, {
        category: 'notification',
      });
      return approvers;
    }

    const emp = await getEmployee(empId);

    for (const approver of approvers) {
      // Socket notify
      io.to(`emp-${approver.emp_id}`).emit(event, {
        ...socketPayload,
        routed_to: approver.emp_id,
        routed_to_role: approver.role_name,
      });

      // Email notify (fire-and-forget per approver)
      notifyTL(approver.emp_id, type, emailPayload).catch(e =>
        logger.warn(`notifyApprovers email failed for ${approver.emp_id}: ${e.message}`, {
          category: 'notification',
        })
      );
    }

    logger.info(
      `Approvers notified for ${empId} [${type}]: ${approvers.map(a => a.emp_id).join(', ')}`,
      { category: 'notification', user_id: empId }
    );

    return approvers;
  } catch (err) {
    logger.error(`notifyApprovers failed for ${empId}: ${err.message}`, {
      category: 'notification',
    });
    return [];
  }
}