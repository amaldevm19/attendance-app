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