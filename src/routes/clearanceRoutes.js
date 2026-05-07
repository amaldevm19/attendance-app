import express from 'express';
import pool from '../config/db.js';
import logger from '../logger.js';
import authMiddleware from '../middleware/authMiddleware.js';

const router = express.Router();

// All clearance routes require auth + Admin role
router.use(authMiddleware);
router.use((req, res, next) => {
  if (req.user?.role !== 'Admin') {
    return res.status(403).json({ error: 'Only Admin can perform table clearance.' });
  }
  next();
});

// ── Table definitions ─────────────────────────────────────────────────────────
// Truncate lists derived from actual FK graph (check_fkeys.sql output)
// Order: leaves first → roots last, so no FK violations occur
const SAFE_ORDER = ['attendance_logs', 'employee_devices', 'employee_portfolios', 'job_portfolios', 'job_products', 'job_systems', 'pending_enrollments', 'pending_site_enrollments', 'site_assets', 'site_jobs', 'jobs', 'products', 'sites', 'client_representatives', 'employees', 'job_categories', 'locations', 'systems', 'clients', 'designations', 'devices', 'portfolios', 'client_categories'];

const TABLES = {
  designations: {
    label: 'Designations',
    truncate: ['attendance_logs', 'employee_devices', 'employee_portfolios', 'job_portfolios', 'job_products', 'job_systems', 'pending_enrollments', 'pending_site_enrollments', 'site_assets', 'site_jobs', 'jobs', 'sites', 'client_representatives', 'employees', 'designations'],
    sequence: 'designations_id_seq',
  },
  job_categories: {
    label: 'Job Categories',
    truncate: ['job_portfolios', 'job_products', 'job_systems', 'site_assets', 'site_jobs', 'jobs', 'job_categories'],
    sequence: 'job_categories_id_seq',
  },
  client_categories: {
    label: 'Client Categories',
    truncate: ['attendance_logs', 'pending_site_enrollments', 'job_portfolios', 'job_products', 'job_systems', 'site_assets', 'site_jobs', 'jobs', 'sites', 'client_representatives', 'clients', 'client_categories'],
    sequence: 'client_categories_id_seq',
  },
  portfolios: {
    label: 'Portfolios & Systems',
    truncate: ['employee_portfolios', 'job_portfolios', 'job_products', 'job_systems', 'site_assets', 'products', 'systems', 'portfolios'],
    sequence: 'portfolios_id_seq',
  },
  products: {
    label: 'Products',
    truncate: ['job_products', 'site_assets', 'products'],
    sequence: 'products_id_seq',
  },
  locations: {
    label: 'Locations',
    truncate: ['attendance_logs', 'pending_site_enrollments', 'site_assets', 'site_jobs', 'sites', 'locations'],
    sequence: 'locations_id_seq',
  },
  employees: {
    label: 'Employees',
    truncate: ['attendance_logs', 'employee_devices', 'employee_portfolios', 'pending_enrollments', 'pending_site_enrollments', 'site_assets', 'site_jobs', 'jobs', 'sites', 'employees'],
    sequence: 'employees_id_seq',
  },
  devices: {
    label: 'Devices',
    truncate: ['attendance_logs', 'employee_devices', 'pending_enrollments', 'pending_site_enrollments', 'site_assets', 'site_jobs', 'jobs', 'sites', 'employees', 'devices'],
    sequence: 'devices_id_seq',
  },
  sites: {
    label: 'Sites',
    truncate: ['attendance_logs', 'pending_site_enrollments', 'site_assets', 'site_jobs', 'sites'],
    sequence: 'sites_id_seq',
  },
  attendance_logs: {
    label: 'Attendance Logs',
    truncate: ['attendance_logs'],
    sequence: 'attendance_logs_id_seq',
  },
  jobs: {
    label: 'Jobs',
    truncate: ['job_portfolios', 'job_products', 'job_systems', 'site_assets', 'site_jobs', 'jobs'],
    sequence: 'jobs_id_seq',
  },
  clients: {
    label: 'Clients',
    truncate: ['job_portfolios', 'job_products', 'job_systems', 'site_assets', 'site_jobs', 'jobs', 'client_representatives', 'clients'],
    sequence: 'clients_id_seq',
  },
  logs: {
    label: 'System Logs',
    truncate: ['logs'],
    sequence: null,
  },
};

// ── GET: table stats (row counts) ─────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const counts = {};
    await Promise.all(
      Object.entries(TABLES).map(async ([key, def]) => {
        const mainTable = def.truncate[def.truncate.length - 1];
        try {
          const r = await pool.query(`SELECT COUNT(*) FROM ${mainTable}`);
          counts[key] = { label: def.label, count: parseInt(r.rows[0].count), table: mainTable };
        } catch {
          counts[key] = { label: def.label, count: 0, table: mainTable };
        }
      })
    );
    res.json(counts);
  } catch (err) {
    logger.error(`DB clearance stats failed: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// ── POST: clear a specific table group ───────────────────────────────────────
router.post('/clear/:tableKey', async (req, res) => {
  const { tableKey } = req.params;
  const def = TABLES[tableKey];

  if (!def) {
    return res.status(400).json({ error: `Unknown table key: ${tableKey}` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Single TRUNCATE with all tables at once — PostgreSQL handles FK resolution
    // when all related tables are listed together in one statement
    const tableList = def.truncate.join(', ');
    await client.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY`);

    // RESTART IDENTITY in the TRUNCATE already resets sequences — no extra step needed

    await client.query('COMMIT');

    logger.warn(`DB table cleared: ${def.label} by admin ${req.user?.emp_id}`, {
      category: 'database',
      user_id:  req.user?.emp_id,
      meta: {
        table_key:        tableKey,
        tables_truncated: def.truncate,
        sequence_reset:   def.sequence || 'n/a',
        cleared_by:       req.user?.emp_id,
        cleared_by_name:  req.user?.name,
      },
    });

    res.json({
      success: true,
      message: `${def.label} table cleared and ID sequence reset to 1.`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`DB clearance failed for ${tableKey}: ${err.message}`, {
      category: 'database',
      user_id:  req.user?.emp_id,
      meta: { table_key: tableKey, error: err.message },
    });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── POST: clear ALL tables (nuclear option) ───────────────────────────────────
router.post('/clear-all', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Use the exact FK-derived safe order
    const allTables = [
      'attendance_logs', 'employee_devices', 'employee_portfolios',
      'job_portfolios', 'job_products', 'job_systems', 'pending_enrollments',
      'pending_site_enrollments', 'site_assets', 'site_jobs',
      'jobs', 'products', 'sites', 'client_representatives',
      'employees', 'job_categories', 'locations', 'systems',
      'clients', 'designations', 'devices', 'portfolios', 'client_categories',
      'logs',
    ];

    // Single TRUNCATE + RESTART IDENTITY resets all sequences automatically
    const tableList = allTables.join(', ');
    await client.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY`);

    await client.query('COMMIT');

    logger.warn(`FULL DB clearance performed by admin ${req.user?.emp_id}`, {
      category: 'database',
      user_id:  req.user?.emp_id,
      meta: { cleared_by: req.user?.emp_id, cleared_by_name: req.user?.name },
    });

    res.json({ success: true, message: 'All tables cleared and sequences reset.' });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`Full DB clearance failed: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export default router;