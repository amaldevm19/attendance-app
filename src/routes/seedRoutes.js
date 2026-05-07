import express from 'express';
import pool from '../config/db.js';
import logger from '../logger.js';
import authMiddleware from '../middleware/authMiddleware.js';

const router = express.Router();

// Admin only
router.use(authMiddleware);
router.use((req, res, next) => {
  if (req.user?.role !== 'Admin') {
    return res.status(403).json({ error: 'Only Admin can seed data.' });
  }
  next();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randFloat = (min, max, dec = 6) => parseFloat((Math.random() * (max - min) + min).toFixed(dec));
const pad = (n, len = 3) => String(n).padStart(len, '0');
const unique = (prefix, existing = new Set()) => {
  let id, attempts = 0;
  do { id = `${prefix}${pad(rand(100, 999))}`; attempts++; } while (existing.has(id) && attempts < 100);
  return id;
};

// ── Seed data pools ───────────────────────────────────────────────────────────
const FIRST_NAMES = ['Amal','Rahul','Priya','Mohammed','Sara','Anand','Divya','Ravi','Nisha','Arjun','Fatima','Sanjay','Deepa','Vikram','Layla','Hassan','Meera','Omar','Sunita','Ali'];
const LAST_NAMES  = ['Kumar','Sharma','Patel','Khan','Singh','Nair','Verma','Ahmed','Reddy','Gupta','Ali','Mehta','Joshi','Das','Pillai','Menon','Rao','Malik','Iyer','Sinha'];
const DESIGNATIONS= ['Team Lead','Supervisor','Technician','Engineer','Senior Technician','Field Supervisor'];
const CLIENT_NAMES= ['Emaar Properties','Damac Group','Aldar Properties','Meraas Holding','Nakheel','Dubai Holding','Sobha Realty','Azizi Developments','Omniyat','Select Group','Masdar','DP World','Etihad Aviation','ADNOC','Mubadala'];
const PORTFOLIOS  = ['Fire Life Safety','ELV','Mechanical','Electrical','Civil','IT Infrastructure','Security Systems','Building Automation'];
const SYSTEMS     = ['Fire Alarm','CCTV','Access Control','PA System','BMS','HVAC Control','Intercom','Structured Cabling','UPS','Emergency Lighting'];
const MANUFACTURERS=['Siemens','Honeywell','Bosch','Dahua','Hikvision','Notifier','EST','Hochiki','Kidde','Pelco','Axis','Genetec','Johnson Controls','Schneider','ABB'];
const MODELS      = ['FS720','IPC-T26G','DS-2CD2143','V-1001','BCS-10','FP-11050','XLS-1000','ALG-E','KS-430','EX-500','IM-300','CX-100','DX-200','FX-400','TX-600'];
const BRANDS      = ['Cerberus','Galaxy','Pro Series','Ultra','Fusion','Nexus','Apex','Elite','Prime','Core'];
const LOCATIONS_UAE = [
  { name: 'Downtown Dubai',    emirate: 'Dubai' },
  { name: 'Business Bay',      emirate: 'Dubai' },
  { name: 'Deira',             emirate: 'Dubai' },
  { name: 'Jumeirah',          emirate: 'Dubai' },
  { name: 'Al Barsha',         emirate: 'Dubai' },
  { name: 'Marina',            emirate: 'Dubai' },
  { name: 'Al Reem Island',    emirate: 'Abu Dhabi' },
  { name: 'Khalifa City',      emirate: 'Abu Dhabi' },
  { name: 'Al Ain Downtown',   emirate: 'Al Ain' },
  { name: 'Al Majaz',          emirate: 'Sharjah' },
  { name: 'Al Khan',           emirate: 'Sharjah' },
  { name: 'Al Nakheel',        emirate: 'Ras Al Khaimah' },
  { name: 'Al Hamra',          emirate: 'Ras Al Khaimah' },
  { name: 'Ajman Downtown',    emirate: 'Ajman' },
  { name: 'Fujairah City',     emirate: 'Fujairah' },
];
const SITE_NAMES = ['Tower A','Tower B','Villa Complex','Mall Annex','Office Block','Residential Block','Data Centre','Hotel Wing','Retail Plaza','Sports Complex','Community Centre','Medical Centre','School Campus','Warehouse Unit','Industrial Park'];
const JOB_CODES  = ['AMC','FAT','SAT','PMC','EMG','INS','COM','SRV','TRN','AUD'];
const JOB_NUMS   = () => `JB-${new Date().getFullYear()}-${pad(rand(1,999))}`;

// ── GET stats ─────────────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const tables = ['employees','clients','sites','jobs','portfolios','systems','products','locations','job_categories','client_categories','designations'];
    const counts = {};
    await Promise.all(tables.map(async (t) => {
      try {
        const r = await pool.query(`SELECT COUNT(*) FROM ${t}`);
        counts[t] = parseInt(r.rows[0].count);
      } catch { counts[t] = 0; }
    }));
    res.json(counts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Seed: Designations ────────────────────────────────────────────────────────
router.post('/designations', async (req, res) => {
  const { count = 10 } = req.body;
  const seeds = [
    { name: 'Team Lead',         level: 1 },
    { name: 'Supervisor',        level: 2 },
    { name: 'Senior Engineer',   level: 2 },
    { name: 'Engineer',          level: 2 },
    { name: 'Senior Technician', level: 3 },
    { name: 'Technician',        level: 3 },
    { name: 'Helper',            level: 3 },
    { name: 'Field Supervisor',  level: 2 },
    { name: 'Project Coordinator',level: 2 },
    { name: 'Site In-charge',    level: 1 },
  ].slice(0, count);

  try {
    let inserted = 0;
    for (const d of seeds) {
      await pool.query(
        'INSERT INTO designations (name, level) SELECT $1,$2 WHERE NOT EXISTS (SELECT 1 FROM designations WHERE name=$3)',
        [d.name, d.level, d.name]
      );
      inserted++;
    }
    logger.info(`Seeded ${inserted} designations`, { category: 'database', user_id: req.user?.emp_id });
    res.json({ success: true, inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Seed: Job Categories ───────────────────────────────────────────────────────
router.post('/job-categories', async (req, res) => {
  const seeds = [
    { code: 'AMC', description: 'Annual Maintenance Contract' },
    { code: 'FAT', description: 'Factory Acceptance Testing' },
    { code: 'SAT', description: 'Site Acceptance Testing' },
    { code: 'PMC', description: 'Preventive Maintenance Check' },
    { code: 'EMG', description: 'Emergency Call-out' },
    { code: 'INS', description: 'Installation' },
    { code: 'COM', description: 'Commissioning' },
    { code: 'SRV', description: 'Service & Repair' },
    { code: 'TRN', description: 'Training' },
    { code: 'AUD', description: 'Audit & Inspection' },
  ];
  try {
    let inserted = 0;
    for (const s of seeds) {
      await pool.query(
        'INSERT INTO job_categories (code, description) SELECT $1,$2 WHERE NOT EXISTS (SELECT 1 FROM job_categories WHERE code=$3)',
        [s.code, s.description, s.code]
      );
      inserted++;
    }
    logger.info(`Seeded ${inserted} job categories`, { category: 'database', user_id: req.user?.emp_id });
    res.json({ success: true, inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Seed: Client Categories ────────────────────────────────────────────────────
router.post('/client-categories', async (req, res) => {
  const seeds = [
    { name: 'Developer',      description: 'Real estate developer' },
    { name: 'Contractor',     description: 'Main contractor' },
    { name: 'Consultant',     description: 'Engineering consultant' },
    { name: 'End User',       description: 'Building owner/operator' },
    { name: 'Government',     description: 'Government entity' },
    { name: 'Industrial',     description: 'Industrial/factory client' },
    { name: 'Hospitality',    description: 'Hotel/resort' },
    { name: 'Healthcare',     description: 'Hospital/clinic' },
    { name: 'Retail',         description: 'Retail/mall' },
    { name: 'Education',      description: 'School/university' },
  ];
  try {
    let inserted = 0;
    for (const s of seeds) {
      await pool.query(
        'INSERT INTO client_categories (name, description) SELECT $1,$2 WHERE NOT EXISTS (SELECT 1 FROM client_categories WHERE name=$3)',
        [s.name, s.description, s.name]
      );
      inserted++;
    }
    logger.info(`Seeded ${inserted} client categories`, { category: 'database', user_id: req.user?.emp_id });
    res.json({ success: true, inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Seed: Portfolios + Systems ─────────────────────────────────────────────────
router.post('/portfolios', async (req, res) => {
  try {
    let pfInserted = 0, sysInserted = 0;
    for (const pfName of PORTFOLIOS) {
      await pool.query(
        'INSERT INTO portfolios (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
        [pfName]
      );
      pfInserted++;
      // Add 2-3 systems per portfolio
      const pfRes = await pool.query('SELECT id FROM portfolios WHERE name=$1', [pfName]);
      const pfId = pfRes.rows[0]?.id;
      if (pfId) {
        const sysSample = SYSTEMS.sort(() => 0.5 - Math.random()).slice(0, rand(2, 3));
        for (const sysName of sysSample) {
          await pool.query(
            `INSERT INTO systems (name, portfolio_id)
             SELECT $1,$2 WHERE NOT EXISTS (
               SELECT 1 FROM systems WHERE name=$3 AND portfolio_id=$4
             )`,
            [sysName, pfId, sysName, pfId]
          );
          sysInserted++;
        }
      }
    }
    logger.info(`Seeded ${pfInserted} portfolios, ${sysInserted} systems`, { category: 'database', user_id: req.user?.emp_id });
    res.json({ success: true, portfolios: pfInserted, systems: sysInserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Seed: Products — matched to correct systems by domain ────────────────────
const PRODUCT_CATALOG = [
  { system: 'Fire Alarm',        mfr: 'Notifier',  brand: 'Onyx',    model: `NFS2-${rand(640,3030)}` },
  { system: 'Fire Alarm',        mfr: 'EST',        brand: 'Edwards', model: `iO${rand(64,1000)}` },
  { system: 'Fire Alarm',        mfr: 'Hochiki',    brand: 'Hochiki', model: `ALG-E${rand(1,5)}` },
  { system: 'CCTV',              mfr: 'Hikvision',  brand: 'HikVision',model: `DS-2CD${rand(2000,9999)}` },
  { system: 'CCTV',              mfr: 'Dahua',      brand: 'Dahua',   model: `IPC-HDW${rand(1000,9999)}` },
  { system: 'CCTV',              mfr: 'Axis',       brand: 'Axis',    model: `P${rand(1000,9999)}` },
  { system: 'Access Control',    mfr: 'HID',        brand: 'HID',     model: `VertX V${rand(100,999)}` },
  { system: 'Access Control',    mfr: 'Honeywell',  brand: 'Pro-Watch',model: `PW${rand(1000,9999)}` },
  { system: 'PA System',         mfr: 'Bosch',      brand: 'Praesideo',model: `PRS-${rand(1000,9999)}` },
  { system: 'PA System',         mfr: 'TOA',        brand: 'TOA',     model: `N-${rand(1000,9999)}` },
  { system: 'BMS',               mfr: 'Siemens',    brand: 'Desigo',  model: `DXR${rand(1,9)}.E` },
  { system: 'BMS',               mfr: 'Honeywell',  brand: 'EBI',     model: `XCL${rand(5000,8000)}` },
  { system: 'HVAC Control',      mfr: 'Johnson Controls',brand:'Metasys',model:`NAE${rand(3500,5500)}` },
  { system: 'Emergency Lighting',mfr: 'Legrand',    brand: 'URA',     model: `BAES${rand(1,9)}` },
  { system: 'Structured Cabling',mfr: 'Panduit',    brand: 'NetKey',  model: `NK${rand(100,999)}` },
];

router.post('/products', async (req, res) => {
  const { count = 10 } = req.body;
  try {
    const sysRes = await pool.query('SELECT id, name FROM systems');
    const sysMap = {}; // name → id
    sysRes.rows.forEach(r => { sysMap[r.name] = r.id; });

    if (Object.keys(sysMap).length === 0) {
      return res.status(400).json({ error: 'No systems found — seed Portfolios & Systems first.' });
    }

    let inserted = 0;
    const sample = PRODUCT_CATALOG.sort(() => 0.5 - Math.random()).slice(0, count);
    for (const p of sample) {
      const sysId = sysMap[p.system] || Object.values(sysMap)[0];
      const model = typeof p.model === 'function' ? p.model() : p.model;
      await pool.query(
        'INSERT INTO products (manufacturer, brand, model, system_id) VALUES ($1,$2,$3,$4)',
        [p.mfr, p.brand, model, sysId]
      );
      inserted++;
    }
    logger.info(`Seeded ${inserted} products`, { category: 'database', user_id: req.user?.emp_id });
    res.json({ success: true, inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Seed: Locations ────────────────────────────────────────────────────────────
router.post('/locations', async (req, res) => {
  const { count = 10 } = req.body;
  try {
    let inserted = 0;
    const sample = LOCATIONS_UAE.sort(() => 0.5 - Math.random()).slice(0, count);
    for (const loc of sample) {
      // Get or create emirate
      let emRes = await pool.query('SELECT id FROM emirates WHERE name=$1', [loc.emirate]);
      if (emRes.rows.length === 0) {
        const ins = await pool.query('INSERT INTO emirates (name) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM emirates WHERE name=$2) RETURNING id', [loc.emirate, loc.emirate]);
        if (ins.rows.length === 0) {
          emRes = await pool.query('SELECT id FROM emirates WHERE name=$1', [loc.emirate]);
          continue;
        }
        emRes = ins;
      }
      const emirateId = emRes.rows[0]?.id;
      await pool.query(
        'INSERT INTO locations (name, emirate_id) VALUES ($1,$2)',
        [loc.name, emirateId]
      );
      inserted++;
    }
    logger.info(`Seeded ${inserted} locations`, { category: 'database', user_id: req.user?.emp_id });
    res.json({ success: true, inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Seed: Clients ──────────────────────────────────────────────────────────────
router.post('/clients', async (req, res) => {
  const { count = 10 } = req.body;
  try {
    const catRes = await pool.query('SELECT id FROM client_categories LIMIT 10');
    const catIds = catRes.rows.map(r => r.id);
    let inserted = 0;
    const sample = CLIENT_NAMES.sort(() => 0.5 - Math.random()).slice(0, count);
    for (const name of sample) {
      const catId = catIds.length ? pick(catIds) : null;
      const res = await pool.query(
        'INSERT INTO clients (name, client_category_id) SELECT $1,$2 WHERE NOT EXISTS (SELECT 1 FROM clients WHERE name=$3) RETURNING id',
        [name, catId, name]
      );
      if (res.rows.length > 0) {
        // Add 1-2 reps per client
        const clientId = res.rows[0].id;
        const repCount = rand(1, 2);
        for (let r = 0; r < repCount; r++) {
          const repName = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
          await pool.query(
            'INSERT INTO client_representatives (client_id, name, designation, email, phone) VALUES ($1,$2,$3,$4,$5)',
            [clientId, repName, pick(['PM','Director','Manager','Engineer']),
             `${repName.toLowerCase().replace(' ','.')}@${name.toLowerCase().replace(/\s+/g,'')}.com`,
             `+971 5${rand(0,9)} ${rand(100,999)} ${rand(1000,9999)}`]
          );
        }
        inserted++;
      }
    }
    logger.info(`Seeded ${inserted} clients`, { category: 'database', user_id: req.user?.emp_id });
    res.json({ success: true, inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Seed: Employees ────────────────────────────────────────────────────────────
router.post('/employees', async (req, res) => {
  const { count = 10 } = req.body;
  try {
    const desRes  = await pool.query('SELECT id, name FROM designations');
    const roleRes = await pool.query('SELECT id, name FROM roles');
    const existRes= await pool.query('SELECT emp_id FROM employees');
    const existing= new Set(existRes.rows.map(r => r.emp_id));

    // Get existing team leads/supervisors for reports_to
    const mgrsRes = await pool.query(`SELECT emp_id FROM employees WHERE designation IN ('Team Lead','Supervisor') LIMIT 20`);
    const managers = mgrsRes.rows.map(r => r.emp_id);

    let inserted = 0;
    for (let i = 0; i < count; i++) {
      const empId   = unique('EMP', existing);
      existing.add(empId);
      const name    = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
      const des     = desRes.rows.length ? pick(desRes.rows) : null;
      const desName = des?.name || pick(DESIGNATIONS);
      const desId   = des?.id   || null;
      const role    = roleRes.rows.find(r => r.name === desName) || null;
      const roleId  = role?.id || null;
      const reportsTo = managers.length && desName !== 'Team Lead' ? pick(managers) : null;
      const email   = `${name.toLowerCase().replace(' ','.')}${rand(1,99)}@company.ae`;
      const phone   = `+971 5${rand(0,9)} ${rand(100,999)} ${rand(1000,9999)}`;

      await pool.query(
        `INSERT INTO employees (emp_id, name, designation, designation_id, phone, email, reports_to, role_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [empId, name, desName, desId, phone, email, reportsTo, roleId]
      );

      // If team lead, add to managers pool for subsequent employees
      if (desName === 'Team Lead' || desName === 'Supervisor') managers.push(empId);
      inserted++;
    }
    logger.info(`Seeded ${inserted} employees`, { category: 'database', user_id: req.user?.emp_id });
    res.json({ success: true, inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Seed: Sites (no GPS — admin will enroll manually) ─────────────────────────
router.post('/sites', async (req, res) => {
  const { count = 10 } = req.body;
  try {
    const locRes = await pool.query('SELECT id FROM locations LIMIT 20');
    const locIds = locRes.rows.map(r => r.id);
    let inserted = 0;
    for (let i = 0; i < count; i++) {
      const siteName = `${pick(SITE_NAMES)} ${rand(1,50)}`;
      const locId    = locIds.length ? pick(locIds) : null;
      const needsGps = Math.random() < 0.5;
      const lat    = needsGps ? 0 : randFloat(24.0, 25.5);
      const lng    = needsGps ? 0 : randFloat(54.0, 55.5);
      const status = needsGps ? 'none' : 'completed';
      await pool.query(
        `INSERT INTO sites (site_name, location_id, latitude, longitude, enrollment_status)
         VALUES ($1,$2,$3,$4,$5)`,
        [siteName, locId, lat, lng, status]
      );
      inserted++;
    }
    logger.info(`Seeded ${inserted} sites (no GPS)`, { category: 'database', user_id: req.user?.emp_id });
    res.json({ success: true, inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Seed: Jobs ─────────────────────────────────────────────────────────────────
router.post('/jobs', async (req, res) => {
  const { count = 10 } = req.body;
  try {
    const [catRes, clientRes, empRes, pfRes] = await Promise.all([
      pool.query('SELECT id FROM job_categories LIMIT 10'),
      pool.query('SELECT id FROM clients LIMIT 20'),
      pool.query(`SELECT emp_id FROM employees WHERE designation IN ('Team Lead','Supervisor') LIMIT 20`),
      pool.query('SELECT id FROM portfolios LIMIT 10'),
    ]);
    const catIds    = catRes.rows.map(r => r.id);
    const clientIds = clientRes.rows.map(r => r.id);
    const empIds    = empRes.rows.map(r => r.emp_id);
    const pfIds     = pfRes.rows.map(r => r.id);

    let inserted = 0;
    for (let i = 0; i < count; i++) {
      // job_code and job_number share the same base code so they match
      const baseCode = pick(JOB_CODES);
      const jobCode  = `${baseCode}-${rand(100,999)}`;
      const jobNum   = `${baseCode}-JB-${new Date().getFullYear()}-${pad(rand(1,999))}`;
      // Match job category to the job code
      const catRes2 = await pool.query('SELECT id FROM job_categories WHERE code=$1 LIMIT 1', [baseCode]);
      const catId   = catRes2.rows[0]?.id || (catIds.length ? pick(catIds) : null);
      const clientId= clientIds.length ? pick(clientIds) : null;
      const supId  = empIds.length ? pick(empIds) : null;
      const tlId   = empIds.length ? pick(empIds) : null;

      const jobRes = await pool.query(
        `INSERT INTO jobs (job_number, job_code, job_category_id, client_id,
          estimated_manhours, project_value, supervisor_id, team_lead_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [jobNum, jobCode, catId, clientId, rand(50,2000), rand(10000,500000), supId, tlId]
      );

      if (jobRes.rows.length > 0 && pfIds.length) {
        const jobId = jobRes.rows[0].id;
        // Link 1-2 portfolios
        const pfSample = pfIds.sort(() => 0.5 - Math.random()).slice(0, rand(1, 2));
        for (const pfId of pfSample) {
          await pool.query('INSERT INTO job_portfolios (job_id, portfolio_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [jobId, pfId]);
        }
        inserted++;
      } else if (jobRes.rows.length > 0) {
        inserted++;
      }
    }
    logger.info(`Seeded ${inserted} jobs`, { category: 'database', user_id: req.user?.emp_id });
    res.json({ success: true, inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Seed: Attendance Logs ──────────────────────────────────────────────────────
router.post('/attendance', async (req, res) => {
  const { count = 10 } = req.body;
  try {
    const [empRes, siteRes] = await Promise.all([
      pool.query('SELECT emp_id FROM employees LIMIT 30'),
      pool.query('SELECT id FROM sites LIMIT 20'),
    ]);
    const empIds  = empRes.rows.map(r => r.emp_id);
    const siteIds = siteRes.rows.map(r => r.id);

    if (!empIds.length) return res.status(400).json({ error: 'Seed employees first.' });

    let inserted = 0;
    for (let i = 0; i < count; i++) {
      const empId  = pick(empIds);
      const siteId = siteIds.length ? pick(siteIds) : null;
      // Random time in last 7 days
      const hoursAgo = rand(0, 168);
      const logTime  = new Date(Date.now() - hoursAgo * 3600000);
      const actionType = pick(['IN','OUT']);
      // Slightly randomise UAE coordinates
      const lat = randFloat(24.0, 25.5);
      const lng = randFloat(54.0, 55.5);

      await pool.query(
        `INSERT INTO attendance_logs (employee_id, action_type, log_time, latitude, longitude, site_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [empId, actionType, logTime, lat, lng, siteId]
      );
      inserted++;
    }
    logger.info(`Seeded ${inserted} attendance logs`, { category: 'database', user_id: req.user?.emp_id });
    res.json({ success: true, inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;