// =============================================================================
// correctionCron.js  (src/utils/correctionCron.js)
// Auto-approves correction_requests that have been pending for more than 24h.
// Flags admin via a system log entry.
// Import and call startCorrectionCron() once from server.js.
// =============================================================================

import pool from '../config/db.js';
import logger from '../logger.js';
import { notifyEmployee } from './notificationService.js';

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

async function runCorrectionAutoApproval() {
  logger.info('Running correction auto-approval sweep...', { category: 'system' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Find all correction_requests pending for > 24h
    const staleRes = await client.query(`
      SELECT cr.*
      FROM correction_requests cr
      WHERE cr.status = 'pending'
        AND cr.created_at < NOW() - INTERVAL '24 hours'
    `);

    if (!staleRes.rows.length) {
      await client.query('ROLLBACK');
      logger.info('Correction auto-approval: no stale requests found.', { category: 'system' });
      return;
    }

    for (const cr of staleRes.rows) {
      // Insert the resolved SITE_OUT log (auto-approved, no score_flag)
      const logRes = await client.query(`
        INSERT INTO attendance_logs
          (employee_id, action_type, log_time, site_id, job_id,
           sub_type, location_type, is_approved, approved_by, approved_at, score_flag)
        VALUES ($1, 'SITE_OUT', $2, $3, $4, $5, 'registered_site', TRUE, 'system', NOW(), FALSE)
        RETURNING id
      `, [
        cr.employee_id,
        cr.proposed_out_time,
        cr.session_site_id,
        cr.session_job_id,
        cr.sub_type,
      ]);

      // Update correction_request
      await client.query(`
        UPDATE correction_requests
        SET status = 'approved',
            reviewed_by = 'system',
            reviewed_at = NOW(),
            tl_comment  = 'Auto-approved after 24h: TL did not respond.',
            score_flag  = FALSE,
            resolved_log_id = $1
        WHERE id = $2
      `, [logRes.rows[0].id, cr.id]);

      // Update the linked approval_request
      await client.query(`
        UPDATE approval_requests
        SET status = 'approved',
            reviewed_by = 'system',
            reviewed_at = NOW(),
            tl_comment  = 'Auto-approved after 24h timeout.'
        WHERE correction_request_id = $1 AND status = 'pending'
      `, [cr.id]);

      // Notify employee
      notifyEmployee(cr.employee_id, 'correction_approved', {
        request_type: 'correction',
        tl_comment: 'Your correction was auto-approved because your Team Lead did not respond within 24 hours.',
      }).catch(e =>
        logger.warn(`Auto-approval notify failed for ${cr.employee_id}: ${e.message}`, {
          category: 'notification',
        })
      );

      logger.warn(
        `Auto-approved correction_request ${cr.id} for ${cr.employee_id} (TL timeout)`,
        { category: 'system', meta: { correction_id: cr.id, employee_id: cr.employee_id } }
      );
    }

    await client.query('COMMIT');

    logger.warn(
      `Correction auto-approval complete: ${staleRes.rows.length} request(s) auto-approved. Admin review recommended.`,
      { category: 'system' }
    );
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`Correction auto-approval failed: ${err.message}`, { category: 'system' });
  } finally {
    client.release();
  }
}

/**
 * Call once from server.js after startup.
 * Runs immediately on boot, then every 1 hour.
 * (Hourly sweep means max ~1h delay past the 24h mark — acceptable.)
 */
export function startCorrectionCron() {
  // Run once at startup (catches anything missed during downtime)
  runCorrectionAutoApproval();
  // Then every hour
  setInterval(runCorrectionAutoApproval, 60 * 60 * 1000);
  logger.info('Correction auto-approval cron started (runs every 1h).', { category: 'system' });
}