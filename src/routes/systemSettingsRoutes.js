// =============================================================================
// systemSettingsRoutes.js  (src/routes/systemSettingsRoutes.js)
// Manages company + SMTP settings stored in system_config table.
// Password is stored as-is (plaintext in DB) but NEVER returned in GET —
// instead returns has_smtp_pass: true/false so UI can show masked state.
// =============================================================================

import express    from 'express';
import pool       from '../config/db.js';
import logger     from '../logger.js';
import nodemailer from 'nodemailer';

const router = express.Router();

// Keys managed by this route
const MANAGED_KEYS = [
  'company_name',
  'sender_name',
  'frontend_url',
  'smtp_host',
  'smtp_port',
  'smtp_user',
  'smtp_pass',   // never returned to client
];

// ─────────────────────────────────────────────────────────────────────────────
// Helper: get a single config value
// ─────────────────────────────────────────────────────────────────────────────
async function getConfig(key) {
  const res = await pool.query('SELECT value FROM system_config WHERE key = $1', [key]);
  return res.rows[0]?.value || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: upsert a config key
// ─────────────────────────────────────────────────────────────────────────────
async function setConfig(key, value) {
  await pool.query(`
    INSERT INTO system_config (key, value)
    VALUES ($1, $2)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `, [key, value]);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /system/settings
// Returns all config except smtp_pass (returns has_smtp_pass bool instead)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT key, value FROM system_config WHERE key = ANY($1)`,
      [MANAGED_KEYS]
    );

    const cfg = {};
    result.rows.forEach(r => { cfg[r.key] = r.value; });

    // Never expose the password — return presence flag only
    const hasPass = !!(cfg.smtp_pass);
    delete cfg.smtp_pass;

    res.json({
      company_name: cfg.company_name || '',
      sender_name:  cfg.sender_name  || '',
      frontend_url: cfg.frontend_url || '',
      smtp_host:    cfg.smtp_host    || 'smtp.gmail.com',
      smtp_port:    cfg.smtp_port    || '587',
      smtp_user:    cfg.smtp_user    || '',
      has_smtp_pass: hasPass,
    });
  } catch (err) {
    logger.error(`Settings fetch failed: ${err.message}`, { category: 'system' });
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /system/settings
// Saves settings. smtp_pass is only updated when explicitly provided (not null).
// ─────────────────────────────────────────────────────────────────────────────
router.put('/', async (req, res) => {
  const {
    company_name, sender_name, frontend_url,
    smtp_host, smtp_port, smtp_user, smtp_pass,
  } = req.body;

  try {
    const updates = {
      company_name, sender_name, frontend_url,
      smtp_host, smtp_port, smtp_user,
    };

    // Only update password when explicitly provided
    if (smtp_pass !== undefined && smtp_pass !== null) {
      updates.smtp_pass = smtp_pass;
    }

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined && value !== null) {
        await setConfig(key, String(value));
      }
    }

    logger.info('System settings updated', {
      category: 'system',
      meta: {
        updated_keys: Object.keys(updates).filter(k => k !== 'smtp_pass'),
        smtp_pass_changed: smtp_pass !== undefined && smtp_pass !== null,
      },
    });

    res.json({ success: true });
  } catch (err) {
    logger.error(`Settings save failed: ${err.message}`, { category: 'system' });
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /system/settings/test-email
// Sends a test email using current SMTP settings.
// Body: { to: 'email@example.com' }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/test-email', async (req, res) => {
  const { to } = req.body;
  if (!to || !to.includes('@')) {
    return res.status(400).json({ error: 'Valid recipient email required.' });
  }

  try {
    const [smtpHost, smtpPort, smtpUser, smtpPass, companyName, senderName] = await Promise.all([
      getConfig('smtp_host'),
      getConfig('smtp_port'),
      getConfig('smtp_user'),
      getConfig('smtp_pass'),
      getConfig('company_name'),
      getConfig('sender_name'),
    ]);

    if (!smtpUser || !smtpPass) {
      return res.status(400).json({ error: 'SMTP username and password are not configured. Save your settings first.' });
    }

    const transporter = nodemailer.createTransport({
      host:   smtpHost || 'smtp.gmail.com',
      port:   parseInt(smtpPort || '587'),
      secure: parseInt(smtpPort || '587') === 465,
      auth:   { user: smtpUser, pass: smtpPass },
    });

    await transporter.verify();

    const company = companyName || 'BTD Building Technologies';
    const sender  = senderName  || company;

    await transporter.sendMail({
      from:    `"${sender}" <${smtpUser}>`,
      to,
      subject: `✅ Email Test — ${company} System Settings`,
      text:    `This is a test email from ${company}.\n\nYour SMTP settings are configured correctly.\n\nSMTP Host: ${smtpHost}\nSMTP Port: ${smtpPort}\nUsername: ${smtpUser}\n\n— ${company}`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:20px 24px;margin-bottom:24px;">
            <h2 style="margin:0 0 8px;color:#166534;font-size:18px;">✅ Email Test Successful</h2>
            <p style="margin:0;color:#166534;font-size:14px;">Your SMTP settings are configured correctly.</p>
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:13px;color:#374151;">
            <tr><td style="padding:6px 0;color:#6b7280;">SMTP Host</td><td style="padding:6px 0;font-weight:600;">${smtpHost}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280;">SMTP Port</td><td style="padding:6px 0;font-weight:600;">${smtpPort}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280;">Username</td><td style="padding:6px 0;font-weight:600;">${smtpUser}</td></tr>
          </table>
          <p style="margin-top:24px;font-size:12px;color:#9ca3af;">— ${company}</p>
        </div>
      `,
    });

    logger.info(`Test email sent to ${to}`, { category: 'system', meta: { smtp_host: smtpHost, to } });
    res.json({ success: true });
  } catch (err) {
    logger.error(`Test email failed: ${err.message}`, { category: 'system' });
    res.status(500).json({ error: err.message });
  }
});

export default router;