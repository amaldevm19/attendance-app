-- =============================================================================
-- BTD Attendance App - Complete Migration SQL
-- =============================================================================
-- Created: 2025-05-09
-- Purpose: Consolidated migration combining all SQL files from sql-migrations folder
-- Sources: 08052026.sql, master.sql, migration_v9.sql, migration_v10.sql, 
--          migration_v11.sql, migration_v12.sql, migration_v13.sql, 
--          migration_v14.sql, migration_v15.sql, schema.sql
-- =============================================================================
-- IMPORTANT: All statements use IF NOT EXISTS for safety
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1: Core Infrastructure Tables
-- Source: 08052026.sql, master.sql
-- =============================================================================

-- Roles table (Admin, Team Lead, Supervisor, Technician)
CREATE TABLE IF NOT EXISTS roles (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  description TEXT,
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Permissions table (e.g., 'employees:read', 'sites:write')
CREATE TABLE IF NOT EXISTS permissions (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Role-Permission mapping (many-to-many)
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- System configuration (runtime editable)
CREATE TABLE IF NOT EXISTS system_config (
  key         VARCHAR(100) PRIMARY KEY,
  value       TEXT         NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ  DEFAULT NOW(),
  updated_by  VARCHAR(100) DEFAULT 'system'
);

-- =============================================================================
-- SECTION 2: Emirates & Locations
-- Source: 08052026.sql, master.sql
-- =============================================================================

-- Emirates (seeded, static 7)
CREATE TABLE IF NOT EXISTS emirates (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Locations
CREATE TABLE IF NOT EXISTS locations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  emirate_id INTEGER REFERENCES emirates(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- =============================================================================
-- SECTION 3: Device Management
-- Source: 08052026.sql, master.sql, migration_v12.sql
-- =============================================================================

-- Track registered mobile devices
CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  device_unique_id VARCHAR(255) UNIQUE NOT NULL,
  device_name VARCHAR(100),
  is_active BOOLEAN DEFAULT TRUE,
  friendly_name VARCHAR(100),
  is_online BOOLEAN DEFAULT FALSE,
  last_seen_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Link Many Employees to Many Devices
CREATE TABLE IF NOT EXISTS employee_devices (
  employee_id VARCHAR(50) REFERENCES employees(emp_id),
  device_id INTEGER REFERENCES devices(id),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (employee_id, device_id)
);

-- =============================================================================
-- SECTION 4: Employee Management
-- Source: 08052026.sql, master.sql, migration_v10.sql, migration_v11.sql
-- =============================================================================

-- Designations with levels (1=TL, 2=Supervisor, 3=Technician)
CREATE TABLE IF NOT EXISTS designations (
  id    SERIAL PRIMARY KEY,
  name  VARCHAR(100) NOT NULL UNIQUE,
  level INTEGER NOT NULL DEFAULT 3,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Main employees table
CREATE TABLE IF NOT EXISTS employees (
  id SERIAL PRIMARY KEY,
  emp_id VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  designation VARCHAR(50), -- Legacy text field
  designation_id INTEGER REFERENCES designations(id) ON DELETE SET NULL,
  role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL,
  password VARCHAR(255),
  face_descriptor JSONB, -- Storing the face mathematical vector
  enrollment_status VARCHAR(20) DEFAULT 'none',
  target_enrollment_device_id INTEGER REFERENCES devices(id),
  profile_image BYTEA,
  phone VARCHAR(30),
  email VARCHAR(150),
  reports_to VARCHAR(50) REFERENCES employees(emp_id) ON DELETE SET NULL,
  -- Expanded location/comm fields from Migration V10
  home_latitude DOUBLE PRECISION,
  home_longitude DOUBLE PRECISION,
  home_radius INTEGER DEFAULT 100,
  -- Assessment fields from Migration V11
  score INTEGER NOT NULL DEFAULT 300,
  badge VARCHAR(10) NOT NULL DEFAULT 'blue' CHECK (badge IN ('red','blue','yellow','green')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Employee ↔ Portfolios (for Team Leads)
CREATE TABLE IF NOT EXISTS employee_portfolios (
  emp_id       VARCHAR(50) REFERENCES employees(emp_id) ON DELETE CASCADE,
  portfolio_id INTEGER     REFERENCES portfolios(id)    ON DELETE CASCADE,
  PRIMARY KEY (emp_id, portfolio_id)
);

-- =============================================================================
-- SECTION 5: Client Hierarchy
-- Source: 08052026.sql, master.sql
-- =============================================================================

-- Client Categories
CREATE TABLE IF NOT EXISTS client_categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Clients
CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  client_category_id INTEGER REFERENCES client_categories(id) ON DELETE SET NULL,
  client_category VARCHAR(20) CHECK (client_category IN ('direct_client', 'indirect_client')),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Client Representatives
CREATE TABLE IF NOT EXISTS client_representatives (
  id SERIAL PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  designation VARCHAR(100),
  email VARCHAR(150),
  phone VARCHAR(30),
  created_at TIMESTAMP DEFAULT NOW()
);

-- =============================================================================
-- SECTION 6: Portfolios & Systems
-- Source: 08052026.sql, master.sql
-- =============================================================================

-- Portfolios
CREATE TABLE IF NOT EXISTS portfolios (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Systems (each belongs to ONE portfolio)
CREATE TABLE IF NOT EXISTS systems (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  portfolio_id INTEGER REFERENCES portfolios(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Products (manufacturer + brand + model, under a system)
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  system_id INTEGER REFERENCES systems(id) ON DELETE SET NULL,
  manufacturer VARCHAR(100) NOT NULL,
  brand VARCHAR(100),
  model VARCHAR(100) NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- =============================================================================
-- SECTION 7: Jobs
-- Source: 08052026.sql, master.sql
-- =============================================================================

-- Job Categories
CREATE TABLE IF NOT EXISTS job_categories (
  id SERIAL PRIMARY KEY,
  code VARCHAR(20) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Jobs
CREATE TABLE IF NOT EXISTS jobs (
  id SERIAL PRIMARY KEY,
  job_number VARCHAR(50),
  job_category_id INTEGER REFERENCES job_categories(id) ON DELETE SET NULL,
  job_code VARCHAR(50),
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  client_rep_id INTEGER REFERENCES client_representatives(id) ON DELETE SET NULL,
  estimated_manhours DECIMAL(10,2) DEFAULT 0,
  used_manhours DECIMAL(10,2) DEFAULT 0,
  project_value DECIMAL(15,2) DEFAULT 0,
  cost_incurred DECIMAL(15,2) DEFAULT 0,
  team_lead_id VARCHAR(50) REFERENCES employees(emp_id) ON DELETE SET NULL,
  supervisor_id VARCHAR(50) REFERENCES employees(emp_id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- =============================================================================
-- SECTION 8: Job Junction Tables
-- Source: 08052026.sql, master.sql, migration_v9.sql
-- =============================================================================

-- JOB ↔ PORTFOLIOS (many-to-many)
CREATE TABLE IF NOT EXISTS job_portfolios (
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  portfolio_id INTEGER REFERENCES portfolios(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, portfolio_id)
);

-- JOB ↔ SYSTEMS (admin picks specific systems from job's portfolios)
CREATE TABLE IF NOT EXISTS job_systems (
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  system_id INTEGER REFERENCES systems(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, system_id)
);

-- Job ↔ Products (many-to-many)
CREATE TABLE IF NOT EXISTS job_products (
  job_id     INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, product_id)
);

-- =============================================================================
-- SECTION 9: Sites
-- Source: 08052026.sql, master.sql
-- =============================================================================

-- Sites Table
CREATE TABLE IF NOT EXISTS sites (
  id SERIAL PRIMARY KEY,
  site_name VARCHAR(100) NOT NULL,
  latitude DECIMAL(10, 8) NOT NULL,
  longitude DECIMAL(11, 8) NOT NULL,
  enrollment_status VARCHAR(20) DEFAULT 'completed',
  target_device_id INTEGER REFERENCES devices(id),
  gps_enrolled_at TIMESTAMP,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  gps_captured_by_device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  gps_requested_by_emp_id VARCHAR(50) REFERENCES employees(emp_id) ON DELETE SET NULL,
  supervisor_id VARCHAR(50) REFERENCES employees(emp_id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- SITE ↔ JOBS (one site can have multiple jobs)
CREATE TABLE IF NOT EXISTS site_jobs (
  id SERIAL PRIMARY KEY,
  site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  is_primary BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(site_id, job_id)
);

-- SITE ASSETS (future use — products installed at site)
CREATE TABLE IF NOT EXISTS site_assets (
  id SERIAL PRIMARY KEY,
  site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  quantity INTEGER DEFAULT 1,
  serial_number VARCHAR(100),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- =============================================================================
-- SECTION 10: Attendance & Sessions
-- Source: 08052026.sql, master.sql, migration_v10.sql
-- =============================================================================

-- Attendance Logs
CREATE TABLE IF NOT EXISTS attendance_logs (
  id SERIAL PRIMARY KEY,
  employee_id VARCHAR(50) REFERENCES employees(emp_id),
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  site_id INTEGER REFERENCES sites(id),
  action_type VARCHAR(20), -- 'IN', 'OUT', 'DUTY_START', 'DUTY_END', 'SITE_IN', 'SITE_OUT', 'SPECIAL_IN', 'SPECIAL_OUT'
  log_time TIMESTAMP NOT NULL,
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  is_synced BOOLEAN DEFAULT TRUE,
  -- Expanded from Migration V10
  sub_type VARCHAR(50),
  location_type VARCHAR(20) DEFAULT 'registered_site',
  is_approved BOOLEAN DEFAULT true,
  approved_by VARCHAR(50) REFERENCES employees(emp_id) ON DELETE SET NULL,
  approved_at TIMESTAMP,
  score_flag BOOLEAN DEFAULT false
);

-- Active Sessions
CREATE TABLE IF NOT EXISTS active_sessions (
  id SERIAL PRIMARY KEY,
  employee_id VARCHAR(50) NOT NULL REFERENCES employees(emp_id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  punched_in_at TIMESTAMP NOT NULL DEFAULT NOW(),
  device_id VARCHAR(100),
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  session_type VARCHAR(20) DEFAULT 'site',
  UNIQUE (employee_id, site_id)
);

-- =============================================================================
-- SECTION 11: Pending Enrollments
-- Source: 08052026.sql, master.sql, migration_v9.sql
-- =============================================================================

-- Pending Employee Enrollments
CREATE TABLE IF NOT EXISTS pending_enrollments (
  id SERIAL PRIMARY KEY,
  employee_id VARCHAR(50) REFERENCES employees(emp_id) ON DELETE CASCADE,
  device_id   INTEGER     REFERENCES devices(id)       ON DELETE CASCADE,
  created_at  TIMESTAMP DEFAULT NOW(),
  UNIQUE(employee_id, device_id)
);

-- Pending Site Enrollments
CREATE TABLE IF NOT EXISTS pending_site_enrollments (
  site_id   INTEGER NOT NULL REFERENCES sites(id)   ON DELETE CASCADE,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (site_id, device_id)
);

-- =============================================================================
-- SECTION 12: Requests & Approvals (Migration V10)
-- Source: migration_v10.sql
-- =============================================================================

-- Correction Requests
CREATE TABLE IF NOT EXISTS correction_requests (
  id SERIAL PRIMARY KEY,
  employee_id VARCHAR(50) NOT NULL REFERENCES employees(emp_id) ON DELETE CASCADE,
  -- Snapshot of the open session at submission time (session may be deleted)
  open_session_id INTEGER,          -- no FK — session deleted on close
  session_site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  session_job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  session_punched_in_at TIMESTAMP,
  -- What the employee is claiming
  proposed_out_time TIMESTAMP NOT NULL,
  reason TEXT NOT NULL,
  -- sub_type mirrors attendance_logs.sub_type
  sub_type VARCHAR(50),
  -- Workflow state
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  -- TL review fields
  reviewed_by VARCHAR(50) REFERENCES employees(emp_id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP,
  tl_comment TEXT,
  -- Links to the attendance_log row created on approval/rejection
  resolved_log_id INTEGER REFERENCES attendance_logs(id) ON DELETE SET NULL,
  -- Set TRUE on rejection; feeds employee evaluation later
  score_flag BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Approval Requests
CREATE TABLE IF NOT EXISTS approval_requests (
  id SERIAL PRIMARY KEY,
  employee_id VARCHAR(50) NOT NULL REFERENCES employees(emp_id) ON DELETE CASCADE,
  -- The attendance_log row awaiting approval (nullable for correction-type)
  attendance_log_id INTEGER REFERENCES attendance_logs(id) ON DELETE SET NULL,
  -- Link back to correction_requests when request_type = 'correction'
  correction_request_id INTEGER REFERENCES correction_requests(id) ON DELETE SET NULL,
  -- Type of approval needed
  request_type VARCHAR(30) NOT NULL
    CHECK (request_type IN ('correction', 'special_punch')),
  -- Snapshot fields so TL sees context without extra joins
  sub_type VARCHAR(50),
  reason TEXT,
  punch_time TIMESTAMP,        -- the time being approved
  site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  -- Workflow state
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  -- TL review fields
  reviewed_by VARCHAR(50) REFERENCES employees(emp_id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP,
  tl_comment TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- SECTION 13: Assessment System (Migration V11)
-- Source: migration_v11.sql
-- =============================================================================

-- Assessment Criteria (the KPI table — seeded statically)
CREATE TABLE IF NOT EXISTS assessment_criteria (
  id SERIAL PRIMARY KEY,
  category VARCHAR(100) NOT NULL,  -- e.g. 'Technical Knowledge'
  sub_item VARCHAR(150) NOT NULL,  -- e.g. 'General Technical Knowledge'
  source VARCHAR(30) NOT NULL   -- where the score comes from
    CHECK (source IN (
      'poll_avg',        -- (supervisor_score + tl_score) / 2
      'qa',              -- Q&A quiz result
      'auto_punch',      -- automatic from punch rejection events
      'auto_assessment', -- automatic from assessment timeliness
      'auto_qa',         -- automatic from Q&A timeliness
      'client_poll'      -- client email form
    )),
  max_score INTEGER NOT NULL,
  applies_to_levels INTEGER[] NOT NULL DEFAULT ARRAY[1,2,3],
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_automated BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Assessment Sessions
CREATE TABLE IF NOT EXISTS assessment_sessions (
  id SERIAL PRIMARY KEY,
  employee_id VARCHAR(50) NOT NULL REFERENCES employees(emp_id) ON DELETE CASCADE,
  -- Who is the respondent?
  session_type VARCHAR(20) NOT NULL
    CHECK (session_type IN (
      'self',
      'by_supervisor',
      'by_tl',
      'rate_supervisor', -- employee rates their supervisor
      'rate_tl',         -- employee rates their TL
      'client'
    )),
  -- The respondent (who fills this in).
  respondent_id VARCHAR(50) REFERENCES employees(emp_id) ON DELETE SET NULL,
  -- Deadline: respondent must submit by this time
  deadline TIMESTAMP NOT NULL DEFAULT (NOW() + INTERVAL '1 day'),
  -- Workflow state
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','submitted','expired','auto_applied')),
  -- Score calculation state
  calc_status VARCHAR(20) NOT NULL DEFAULT 'waiting'
    CHECK (calc_status IN ('waiting','partial','complete','not_scored')),
  -- Score applied to employee.score (delta, positive or negative)
  score_delta INTEGER,
  -- Automation metadata
  is_automated BOOLEAN NOT NULL DEFAULT FALSE,
  automation_period VARCHAR(10)   -- 'daily'|'weekly'|'monthly'
    CHECK (automation_period IN ('daily','weekly','monthly',NULL)),
  -- Client email form token (UUID link in email)
  client_token UUID UNIQUE,
  client_email VARCHAR(150),
  submitted_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Assessment Responses
CREATE TABLE IF NOT EXISTS assessment_responses (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES assessment_sessions(id) ON DELETE CASCADE,
  criterion_id INTEGER NOT NULL REFERENCES assessment_criteria(id) ON DELETE CASCADE,
  score_given INTEGER NOT NULL CHECK (score_given >= 0),
  submitted_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, criterion_id)
);

-- Score History
CREATE TABLE IF NOT EXISTS score_history (
  id BIGSERIAL PRIMARY KEY,
  employee_id VARCHAR(50) NOT NULL REFERENCES employees(emp_id) ON DELETE CASCADE,
  score_before INTEGER NOT NULL,
  score_after INTEGER NOT NULL,
  delta INTEGER NOT NULL,  -- score_after - score_before
  reason VARCHAR(100) NOT NULL,
  session_id INTEGER REFERENCES assessment_sessions(id) ON DELETE SET NULL,
  qa_assignment_id INTEGER REFERENCES qa_assignments(id) ON DELETE SET NULL,
  triggered_by VARCHAR(50) REFERENCES employees(emp_id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- SECTION 14: Q&A System (Migration V11, V13)
-- Source: migration_v11.sql, migration_v13.sql
-- =============================================================================

-- QA Questions (question bank)
CREATE TABLE IF NOT EXISTS qa_questions (
  id SERIAL PRIMARY KEY,
  question_text TEXT NOT NULL,
  options JSONB NOT NULL,
  correct_answer VARCHAR(1) NOT NULL CHECK (correct_answer IN ('A','B','C','D')),
  marks INTEGER NOT NULL DEFAULT 5,
  difficulty VARCHAR(10) NOT NULL DEFAULT 'basic'
    CHECK (difficulty IN ('basic','medium','advanced')),
  target_level INTEGER NOT NULL DEFAULT 3 CHECK (target_level IN (1,2,3)),
  question_category VARCHAR(50) NOT NULL
    CHECK (question_category IN (
      'general_technical',   -- Technical Knowledge QA (50 marks total)
      'ppm_fitout',          -- Operational Skill QA  (25 marks total)
      'new_systems',         -- Learning Mentality - New Systems (25 marks)
      'portfolio_systems'    -- Learning Mentality - Portfolio Systems (25 marks)
    )),
  system_id INTEGER REFERENCES systems(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by VARCHAR(50) REFERENCES employees(emp_id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- QA Assignments
CREATE TABLE IF NOT EXISTS qa_assignments (
  id SERIAL PRIMARY KEY,
  employee_id VARCHAR(50) NOT NULL REFERENCES employees(emp_id) ON DELETE CASCADE,
  question_ids INTEGER[] NOT NULL,
  total_marks INTEGER NOT NULL DEFAULT 125,
  deadline TIMESTAMP NOT NULL DEFAULT (NOW() + INTERVAL '1 day'),
  deadline_days INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','submitted','expired')),
  score_achieved INTEGER,
  score_delta INTEGER,
  email_sent BOOLEAN NOT NULL DEFAULT FALSE,
  assigned_by VARCHAR(50) REFERENCES employees(emp_id) ON DELETE SET NULL,
  submitted_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- QA Answers
CREATE TABLE IF NOT EXISTS qa_answers (
  id SERIAL PRIMARY KEY,
  assignment_id INTEGER NOT NULL REFERENCES qa_assignments(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES qa_questions(id) ON DELETE CASCADE,
  selected_answer VARCHAR(1) NOT NULL CHECK (selected_answer IN ('A','B','C','D')),
  is_correct BOOLEAN NOT NULL,
  marks_earned INTEGER NOT NULL DEFAULT 0,
  answered_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (assignment_id, question_id)
);

-- =============================================================================
-- SECTION 15: Automation & Tasks (Migration V11)
-- Source: migration_v11.sql
-- =============================================================================

-- Assessment Automation Settings
CREATE TABLE IF NOT EXISTS assessment_automation_settings (
  id SERIAL PRIMARY KEY,
  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  push_type VARCHAR(20) NOT NULL
    CHECK (push_type IN ('assessment','qa','both')),
  frequency VARCHAR(10) NOT NULL DEFAULT 'weekly'
    CHECK (frequency IN ('daily','weekly','monthly')),
  target_levels INTEGER[] NOT NULL DEFAULT ARRAY[1,2,3],
  session_types VARCHAR(20)[] NOT NULL DEFAULT ARRAY['by_supervisor','by_tl'],
  qa_deadline_days INTEGER NOT NULL DEFAULT 1,
  next_run_at TIMESTAMP,
  last_run_at TIMESTAMP,
  last_run_count INTEGER,
  created_by VARCHAR(50) REFERENCES employees(emp_id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Pending Assessment Tasks (device-level push queue)
CREATE TABLE IF NOT EXISTS pending_assessment_tasks (
  id SERIAL PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES assessment_sessions(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(device_id, session_id)
);

-- Pending QA Tasks (device-level push queue for Q&A)
CREATE TABLE IF NOT EXISTS pending_qa_tasks (
  id SERIAL PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  assignment_id INTEGER NOT NULL REFERENCES qa_assignments(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(device_id, assignment_id)
);

-- =============================================================================
-- SECTION 16: Expertise System (Migration V14)
-- Source: migration_v14.sql
-- =============================================================================

-- Employee expertise declarations
CREATE TABLE IF NOT EXISTS employee_expertise (
  id SERIAL PRIMARY KEY,
  employee_id VARCHAR(50) NOT NULL REFERENCES employees(emp_id) ON DELETE CASCADE,
  system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  added_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (employee_id, system_id)
);

-- Expertise endorsements by TL / Supervisor during a rating session
CREATE TABLE IF NOT EXISTS expertise_endorsements (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES assessment_sessions(id) ON DELETE CASCADE,
  employee_id VARCHAR(50) NOT NULL REFERENCES employees(emp_id) ON DELETE CASCADE,
  system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  rater_id VARCHAR(50) NOT NULL REFERENCES employees(emp_id) ON DELETE CASCADE,
  endorsement VARCHAR(20) NOT NULL CHECK (endorsement IN ('strongly_agree','agree','disagree')),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (session_id, employee_id, system_id, rater_id)
);

-- =============================================================================
-- SECTION 17: Score Components (Migration V15)
-- Source: migration_v15.sql
-- =============================================================================

-- Employee Score Components (append-only log)
CREATE TABLE IF NOT EXISTS employee_score_components (
  id SERIAL PRIMARY KEY,
  employee_id VARCHAR(50) NOT NULL REFERENCES employees(emp_id) ON DELETE CASCADE,
  component VARCHAR(20) NOT NULL CHECK (component IN (
    'tl_rating','sup_rating','qa','client_poll',
    'auto_punch','auto_timeline','auto_qa_late'
  )),
  value NUMERIC(8,2) NOT NULL,
  max_value NUMERIC(8,2) NOT NULL,
  session_id INTEGER REFERENCES assessment_sessions(id) ON DELETE SET NULL,
  qa_id INTEGER REFERENCES qa_assignments(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- SECTION 18: Logging System
-- Source: 08052026.sql, migration_v9.sql
-- =============================================================================

-- Logs table (partitioned by month)
CREATE TABLE IF NOT EXISTS logs (
  id BIGSERIAL,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  level VARCHAR(10) NOT NULL CHECK (level IN ('debug','info','warn','error','fatal')),
  service VARCHAR(50) NOT NULL CHECK (service IN ('api','mobile','admin','database','system')),
  category VARCHAR(50) NOT NULL DEFAULT 'general',
  message TEXT NOT NULL,
  meta JSONB,
  user_id VARCHAR(50),
  device_id VARCHAR(100),
  session_id VARCHAR(100),
  ip_address VARCHAR(45),
  duration_ms INTEGER,
  status_code INTEGER,
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

-- Log sessions (track who viewed logs + audit trail)
CREATE TABLE IF NOT EXISTS log_sessions (
  id SERIAL PRIMARY KEY,
  opened_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  opened_by VARCHAR(100), -- admin user identifier
  ip_address VARCHAR(45),
  filters JSONB         -- what filters were applied during this session
);

-- =============================================================================
-- SECTION 19: Functions & Triggers
-- Source: migration_v11.sql, migration_v12.sql, 08052026.sql, migration_v15.sql
-- =============================================================================

-- Function to sync employee badge with score (Migration V11)
CREATE OR REPLACE FUNCTION sync_employee_badge()
RETURNS TRIGGER AS $$
BEGIN
  NEW.badge := CASE
    WHEN NEW.score <= 299                    THEN 'red'
    WHEN NEW.score = 300                     THEN 'blue'
    WHEN NEW.score >= 301 AND NEW.score <= 700 THEN 'yellow'
    ELSE 'green'
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function to set primary device (Migration V12)
CREATE OR REPLACE FUNCTION set_primary_device(p_employee_id VARCHAR, p_device_id INTEGER)
RETURNS VOID AS $$
BEGIN
  -- Clear existing primary for this employee (one primary device per employee)
  UPDATE employee_devices
  SET is_primary = FALSE
  WHERE employee_id = p_employee_id AND is_primary = TRUE;

  -- Clear existing primary for this device (one primary employee per device)
  UPDATE employee_devices
  SET is_primary = FALSE
  WHERE device_id = p_device_id AND is_primary = TRUE;

  -- Set new primary (row must already exist in employee_devices)
  UPDATE employee_devices
  SET is_primary = TRUE
  WHERE employee_id = p_employee_id AND device_id = p_device_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Device % is not assigned to employee %', p_device_id, p_employee_id;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Function to recalculate employee score (Migration V15)
CREATE OR REPLACE FUNCTION recalculate_employee_score(p_emp_id VARCHAR)
RETURNS INTEGER AS $$
DECLARE
  v_tl       NUMERIC := 0;
  v_sup      NUMERIC := 0;
  v_qa       NUMERIC := 0;
  v_client   NUMERIC := 0;
  v_punch    NUMERIC := 0;
  v_timeline NUMERIC := 0;
  v_qa_late  NUMERIC := 0;
  v_total    INTEGER;
BEGIN
  SELECT
    COALESCE(MAX(CASE WHEN component = 'tl_rating'     THEN value END), 0),
    COALESCE(MAX(CASE WHEN component = 'sup_rating'    THEN value END), 0),
    COALESCE(MAX(CASE WHEN component = 'qa'            THEN value END), 0),
    COALESCE(MAX(CASE WHEN component = 'client_poll'   THEN value END), 0),
    COALESCE(MAX(CASE WHEN component = 'auto_punch'    THEN value END), 0),
    COALESCE(MAX(CASE WHEN component = 'auto_timeline' THEN value END), 0),
    COALESCE(MAX(CASE WHEN component = 'auto_qa_late'  THEN value END), 0)
  INTO v_tl, v_sup, v_qa, v_client, v_punch, v_timeline, v_qa_late
  FROM employee_score_current
  WHERE employee_id = p_emp_id;

  v_total := ROUND((v_tl + v_sup) / 2.0)
           + v_qa::INTEGER + v_client::INTEGER
           + v_punch::INTEGER + v_timeline::INTEGER + v_qa_late::INTEGER;

  v_total := GREATEST(0, LEAST(1000, v_total));
  UPDATE employees SET score = v_total WHERE emp_id = p_emp_id;
  RETURN v_total;
END;
$$ LANGUAGE plpgsql;

-- Function to cleanup old logs (08052026.sql)
CREATE OR REPLACE FUNCTION cleanup_old_logs()
RETURNS INTEGER AS $$
DECLARE
  retention_days INTEGER;
  deleted_count  INTEGER;
BEGIN
  SELECT value::INTEGER INTO retention_days
  FROM system_config WHERE key = 'log_retention_days';
  
  retention_days := COALESCE(retention_days, 14);
  
  DELETE FROM logs WHERE ts < NOW() - (retention_days || ' days')::INTERVAL;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  
  -- Log the cleanup itself
  INSERT INTO logs (level, service, category, message, meta)
  VALUES ('info', 'system', 'maintenance', 
          FORMAT('Auto-cleanup removed %s log entries older than %s days', deleted_count, retention_days),
          jsonb_build_object('deleted_count', deleted_count, 'retention_days', retention_days));
  
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- SECTION 20: Views
-- Source: 08052026.sql, migration_v15.sql
-- =============================================================================

-- View: latest value per employee per component (Migration V15)
CREATE OR REPLACE VIEW employee_score_current AS
SELECT DISTINCT ON (employee_id, component)
  id, employee_id, component, value, max_value, session_id, note, created_at
FROM employee_score_components
ORDER BY employee_id, component, id DESC;

-- Helpful views for common log queries (08052026.sql)
CREATE OR REPLACE VIEW logs_today AS
  SELECT * FROM logs WHERE ts >= DATE_TRUNC('day', NOW()) ORDER BY ts DESC;

CREATE OR REPLACE VIEW logs_errors AS
  SELECT * FROM logs WHERE level IN ('error','fatal') ORDER BY ts DESC LIMIT 500;

CREATE OR REPLACE VIEW log_summary AS
  SELECT
    service,
    level,
    DATE_TRUNC('hour', ts) AS hour,
    COUNT(*) AS count
  FROM logs
  WHERE ts >= NOW() - INTERVAL '24 hours'
  GROUP BY service, level, DATE_TRUNC('hour', ts)
  ORDER BY hour DESC, service, level;

-- =============================================================================
-- SECTION 21: Indexes
-- Source: Various files
-- =============================================================================

-- Indexes for employee_devices primary device constraints (Migration V12)
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_primary_device
  ON employee_devices (employee_id)
  WHERE is_primary = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_device_primary_employee
  ON employee_devices (device_id)
  WHERE is_primary = TRUE;

-- Indexes for active_sessions (Migration V10)
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_sessions_duty
  ON active_sessions (employee_id)
  WHERE session_type = 'duty';

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_sessions_site
  ON active_sessions (employee_id, site_id)
  WHERE session_type = 'site' AND site_id IS NOT NULL;

-- Indexes for assessment system (Migration V11)
CREATE INDEX IF NOT EXISTS idx_criteria_category ON assessment_criteria(category);
CREATE INDEX IF NOT EXISTS idx_criteria_source ON assessment_criteria(source);
CREATE INDEX IF NOT EXISTS idx_sessions_employee ON assessment_sessions(employee_id);
CREATE INDEX IF NOT EXISTS idx_sessions_respondent ON assessment_sessions(respondent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON assessment_sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_deadline ON assessment_sessions(deadline) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_responses_session ON assessment_responses(session_id);
CREATE INDEX IF NOT EXISTS idx_responses_criterion ON assessment_responses(criterion_id);
CREATE INDEX IF NOT EXISTS idx_score_history_employee ON score_history(employee_id);
CREATE INDEX IF NOT EXISTS idx_score_history_created ON score_history(created_at DESC);

-- Indexes for Q&A system (Migration V11)
CREATE INDEX IF NOT EXISTS idx_qa_questions_category ON qa_questions(question_category);
CREATE INDEX IF NOT EXISTS idx_qa_questions_level ON qa_questions(target_level);
CREATE INDEX IF NOT EXISTS idx_qa_questions_active ON qa_questions(is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_qa_questions_system ON qa_questions(system_id) WHERE system_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_qa_assignments_employee ON qa_assignments(employee_id);
CREATE INDEX IF NOT EXISTS idx_qa_assignments_status ON qa_assignments(status);
CREATE INDEX IF NOT EXISTS idx_qa_assignments_deadline ON qa_assignments(deadline) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_qa_answers_assignment ON qa_answers(assignment_id);

-- Indexes for expertise system (Migration V14)
CREATE INDEX IF NOT EXISTS idx_expertise_employee ON employee_expertise(employee_id);
CREATE INDEX IF NOT EXISTS idx_expertise_system ON employee_expertise(system_id);
CREATE INDEX IF NOT EXISTS idx_endorsements_employee ON expertise_endorsements(employee_id);
CREATE INDEX IF NOT EXISTS idx_endorsements_session ON expertise_endorsements(session_id);

-- Indexes for score components (Migration V15)
CREATE INDEX IF NOT EXISTS idx_esc_employee ON employee_score_components(employee_id);
CREATE INDEX IF NOT EXISTS idx_esc_component ON employee_score_components(employee_id, component);
CREATE INDEX IF NOT EXISTS idx_esc_created ON employee_score_components(employee_id, component, id DESC);

-- Indexes for logs (08052026.sql)
CREATE INDEX IF NOT EXISTS logs_ts_idx ON logs (ts DESC);
CREATE INDEX IF NOT EXISTS logs_level_idx ON logs (level, ts DESC);
CREATE INDEX IF NOT EXISTS logs_service_idx ON logs (service, ts DESC);
CREATE INDEX IF NOT EXISTS logs_category_idx ON logs (category, ts DESC);
CREATE INDEX IF NOT EXISTS logs_user_idx ON logs (user_id, ts DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS logs_device_idx ON logs (device_id, ts DESC) WHERE device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS logs_message_idx ON logs USING GIN (to_tsvector('english', message));

-- Indexes for requests and attendance (master.sql)
CREATE INDEX IF NOT EXISTS idx_correction_requests_emp ON correction_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_emp ON approval_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_attendance_logs_job ON attendance_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_active_sessions_emp ON active_sessions(employee_id);

-- Indexes for correction_requests (Migration V10)
CREATE INDEX IF NOT EXISTS idx_correction_requests_employee ON correction_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_correction_requests_status ON correction_requests(status);
CREATE INDEX IF NOT EXISTS idx_correction_requests_reviewed_by ON correction_requests(reviewed_by);

-- Indexes for approval_requests (Migration V10)
CREATE INDEX IF NOT EXISTS idx_approval_requests_employee ON approval_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_approval_requests_pending ON approval_requests(status, employee_id) WHERE status = 'pending';

-- Indexes for pending tasks (Migration V11)
CREATE INDEX IF NOT EXISTS idx_pending_assess_device ON pending_assessment_tasks(device_id);
CREATE INDEX IF NOT EXISTS idx_pending_qa_device ON pending_qa_tasks(device_id);

-- =============================================================================
-- SECTION 22: Triggers
-- Source: migration_v11.sql
-- =============================================================================

-- Trigger to keep badge in sync whenever score changes
DROP TRIGGER IF EXISTS trg_sync_badge ON employees;
CREATE TRIGGER trg_sync_badge
  BEFORE INSERT OR UPDATE OF score ON employees
  FOR EACH ROW EXECUTE FUNCTION sync_employee_badge();

-- =============================================================================
-- SECTION 23: Seed Data
-- Source: 08052026.sql, master.sql, migration_v11.sql
-- =============================================================================

-- Seed Emirates
INSERT INTO emirates (name) VALUES
  ('Abu Dhabi'),
  ('Dubai'),
  ('Sharjah'),
  ('Ajman'),
  ('Umm Al Quwain'),
  ('Ras Al Khaimah'),
  ('Fujairah')
ON CONFLICT (name) DO NOTHING;

-- Seed default roles
INSERT INTO roles (name, description, is_default) VALUES
  ('Admin', 'Superuser with full access', true),
  ('Team Lead', 'Manages teams and portfolios', false),
  ('Supervisor', 'Supervises technicians and jobs', false),
  ('Technician', 'Ground-level employee', false)
ON CONFLICT (name) DO NOTHING;

-- Seed default permissions
INSERT INTO permissions (name, description) VALUES
  -- Dashboard
  ('dashboard:read', 'View dashboard'),
  -- Employees
  ('employees:read', 'View employees list'),
  ('employees:write', 'Add/edit/delete employees'),
  ('employees:attendance:read', 'View employee attendance logs'),
  ('employees:designations:read', 'View designations'),
  ('employees:designations:write', 'Manage designations'),
  -- Sites
  ('sites:read', 'View sites list'),
  ('sites:write', 'Add/edit/delete sites'),
  ('sites:locations:read', 'View locations'),
  ('sites:locations:write', 'Manage locations'),
  -- Jobs
  ('jobs:read', 'View jobs list'),
  ('jobs:write', 'Add/edit/delete jobs'),
  ('jobs:categories:read', 'View job categories'),
  ('jobs:categories:write', 'Manage job categories'),
  -- Clients
  ('clients:read', 'View clients list'),
  ('clients:write', 'Add/edit/delete clients'),
  ('clients:categories:read', 'View client categories'),
  ('clients:categories:write', 'Manage client categories'),
  -- Systems & Portfolios
  ('systems:portfolios:read', 'View portfolios and systems'),
  ('systems:portfolios:write', 'Manage portfolios and systems'),
  ('systems:products:read', 'View products'),
  ('systems:products:write', 'Manage products'),
  -- Devices
  ('devices:read', 'View devices list'),
  ('devices:write', 'Manage devices'),
  -- System Logs
  ('logs:read', 'View system logs')
ON CONFLICT (name) DO NOTHING;

-- Assign all permissions to Admin role (full access)
INSERT INTO role_permissions (role_id, permission_id)
SELECT
  (SELECT id FROM roles WHERE name = 'Admin'),
  id
FROM permissions
ON CONFLICT DO NOTHING;

-- Seed default config values
INSERT INTO system_config (key, value, description) VALUES
  ('log_level',              'info',   'Minimum log level: debug | info | warn | error | fatal'),
  ('log_retention_days',     '14',     'How many days to keep logs in DB'),
  ('log_file_retention_days','14',     'How many days to keep log files on disk'),
  ('log_db_enabled',         'true',   'Write logs to PostgreSQL'),
  ('log_file_enabled',       'true',   'Write logs to disk files'),
  ('log_socket_enabled',     'true',   'Stream logs to admin dashboard via socket'),
  ('log_slow_query_ms',      '500',    'Log DB queries slower than this many milliseconds'),
  ('mobile_batch_interval_s','30',     'How often mobile sends batched logs (seconds'),
  ('api_url',                'http://btdapp.technodevenv.dpdns.org:3000/api', 'Backend API URL'),
  ('admin_url',              'http://btdadmin.technodevenv.dpdns.org',        'Admin dashboard URL')
ON CONFLICT (key) DO NOTHING;

-- Seed Assessment Criteria (Migration V11)
INSERT INTO assessment_criteria
  (category, sub_item, source, max_score, applies_to_levels, sort_order)
SELECT * FROM (VALUES
  -- Technical Knowledge (150)
  ('Technical Knowledge'::TEXT,'General Technical Knowledge'::TEXT,'qa'::TEXT,         50::INT, ARRAY[1,2,3], 10::INT),
  ('Technical Knowledge',      'General Technical Knowledge',       'poll_avg',         75,      ARRAY[1,2,3], 11),
  ('Technical Knowledge',      'General Technical Knowledge',       'client_poll',       25,      ARRAY[1,2,3], 12),
  -- Operational Skill (150)
  ('Operational Skill',        'PPM / Fitout Skill',                'qa',               25,      ARRAY[1,2,3], 20),
  ('Operational Skill',        'PPM / Fitout Skill',                'poll_avg',         75,      ARRAY[1,2,3], 21),
  ('Operational Skill',        'PPM / Fitout Skill',                'client_poll',      50,      ARRAY[1,2,3], 22),
  -- Responsiveness, Efficiency & Reliability (150)
  ('Responsiveness & Efficiency','Task Completion',                 'poll_avg',         25,      ARRAY[1,2,3], 30),
  ('Responsiveness & Efficiency','Task Completion',                 'client_poll',      50,      ARRAY[1,2,3], 31),
  ('Responsiveness & Efficiency','Punch Compliance',                'auto_punch',       25,      ARRAY[1,2,3], 32),
  ('Responsiveness & Efficiency','Assessment Timeliness',           'auto_assessment',  25,      ARRAY[1,2,3], 33),
  ('Responsiveness & Efficiency','Q&A Timeliness',                  'auto_qa',          25,      ARRAY[1,2,3], 34),
  -- Behavior & Obedience (150)
  ('Behavior & Obedience',     'Following Instructions',            'poll_avg',         25,      ARRAY[1,2,3], 40),
  ('Behavior & Obedience',     'Professionalism',                   'poll_avg',         25,      ARRAY[1,2,3], 41),
  ('Behavior & Obedience',     'Professionalism',                   'client_poll',      50,      ARRAY[1,2,3], 42),
  ('Behavior & Obedience',     'Discipline',                        'poll_avg',         25,      ARRAY[1,2,3], 43),
  ('Behavior & Obedience',     'Discipline (Punch)',                'auto_punch',       25,      ARRAY[1,2,3], 44),
  -- Learning Mentality (150)
  ('Learning Mentality',       'New Systems',                       'qa',               25,      ARRAY[1,2,3], 50),
  ('Learning Mentality',       'New Systems',                       'poll_avg',         50,      ARRAY[1,2,3], 51),
  ('Learning Mentality',       'Portfolio Systems',                 'qa',               25,      ARRAY[1,2,3], 52),
  ('Learning Mentality',       'Portfolio Systems',                 'poll_avg',         50,      ARRAY[1,2,3], 53),
  -- Customer Satisfaction (250)
  ('Customer Satisfaction',    'Client Feedback',                   'client_poll',      150,     ARRAY[1,2,3], 60),
  ('Customer Satisfaction',    'Client Feedback',                   'poll_avg',         100,     ARRAY[1,2,3], 61)
) AS v(category, sub_item, source, max_score, applies_to_levels, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM assessment_criteria LIMIT 1);

-- Default disabled row for assessment automation
INSERT INTO assessment_automation_settings
  (is_enabled, push_type, frequency, target_levels, session_types, qa_deadline_days)
VALUES
  (FALSE, 'both', 'weekly', ARRAY[1,2,3], ARRAY['by_supervisor','by_tl'], 1)
ON CONFLICT DO NOTHING;

-- =============================================================================
-- SECTION 24: Data Migration
-- Source: schema.sql, 08052026.sql
-- =============================================================================

-- Migrate existing designation text → designation_id
UPDATE employees e
SET designation_id = d.id
FROM designations d
WHERE LOWER(TRIM(e.designation)) = LOWER(TRIM(d.name))
AND e.designation_id IS NULL;

-- Assign Admin role to any existing employee with 'Admin' designation (if any)
UPDATE employees
SET role_id = (SELECT id FROM roles WHERE name = 'Admin')
WHERE LOWER(designation) = 'admin' AND role_id IS NULL;

-- =============================================================================
-- SECTION 25: Partition Creation for Logs
-- Source: 08052026.sql
-- =============================================================================

-- Create partitions for current and next 3 months
DO $$
DECLARE
  start_date DATE;
  end_date   DATE;
  part_name  TEXT;
BEGIN
  FOR i IN 0..5 LOOP
    start_date := DATE_TRUNC('month', NOW()) + (i || ' months')::INTERVAL;
    end_date   := start_date + INTERVAL '1 month';
    part_name  := 'logs_' || TO_CHAR(start_date, 'YYYY_MM');
    IF NOT EXISTS (
      SELECT 1 FROM pg_class WHERE relname = part_name
    ) THEN
      EXECUTE FORMAT(
        'CREATE TABLE %I PARTITION OF logs FOR VALUES FROM (%L) TO (%L)',
        part_name, start_date, end_date
      );
      RAISE NOTICE 'Created partition: %', part_name;
    END IF;
  END LOOP;
END $$;

-- =============================================================================
-- SECTION 26: Comments
-- Source: Various files
-- =============================================================================

COMMENT ON TABLE logs IS 'Central log store for all BTD app services. Partitioned by month. Use cleanup_old_logs() to purge old data.';
COMMENT ON TABLE system_config IS 'Runtime configuration editable from admin UI or psql. App reads this every 60s — no restart needed.';

COMMENT ON COLUMN employees.score IS '1000-point scale. 0-299=red, 300=blue(new), 301-700=yellow, 701-1000=green';
COMMENT ON COLUMN qa_questions.options IS 'JSONB array: [{"key":"A","text":"..."},{"key":"B","text":"..."},...]';
COMMENT ON COLUMN qa_questions.system_id IS 'The specific system this question is about. Used for portfolio-aware assignment: portfolio_systems questions → matched to employee''s own portfolio systems. new_systems questions → matched to systems NOT in employee''s portfolio. NULL = general question, not system-specific.';

COMMENT ON COLUMN attendance_logs.action_type IS 'Allowed values: IN, OUT (legacy), DUTY_START, DUTY_END, SITE_IN, SITE_OUT, SPECIAL_IN, SPECIAL_OUT';
COMMENT ON COLUMN attendance_logs.sub_type IS 'Optional sub-classification: site_survey, material_purchase, others, forgot_punch, battery_dead';
COMMENT ON COLUMN attendance_logs.location_type IS 'Where the punch happened: home | registered_site | unauthorized';
COMMENT ON COLUMN attendance_logs.is_approved IS 'FALSE for special/correction punches awaiting TL approval. TRUE for all normal punches.';
COMMENT ON COLUMN attendance_logs.score_flag IS 'TRUE when TL rejects a correction — feeds employee evaluation module (Phase N).';
COMMENT ON COLUMN active_sessions.session_type IS 'duty = morning duty session (no site_id), site = site visit, special = unauthorized location punch';
COMMENT ON TABLE correction_requests IS 'Submitted when an employee missed a punch-out. TL approves/rejects the proposed_out_time.';
COMMENT ON TABLE approval_requests IS 'Unified TL approval queue for special punches and corrections. One row per item needing review.';
COMMENT ON TABLE assessment_sessions IS 'One push = one session. Respondent fills criteria scores.';
COMMENT ON TABLE assessment_responses IS 'Criterion-level score given per session.';
COMMENT ON TABLE score_history IS 'Full audit trail of every employee score change.';
COMMENT ON TABLE qa_questions IS 'Question bank. Admin/TL adds questions manually.';
COMMENT ON TABLE qa_assignments IS 'Admin assigns random question sets to employees.';
COMMENT ON TABLE qa_answers IS 'Employee answers per assignment question.';
COMMENT ON TABLE assessment_automation_settings IS 'Controls automated push of assessments and Q&A.';
COMMENT ON TABLE pending_assessment_tasks IS 'Device push queue for assessment tile.';
COMMENT ON TABLE pending_qa_tasks IS 'Device push queue for Q&A tile.';
COMMENT ON COLUMN clients.client_category IS 'Static category: direct_client = end user, indirect_client = contractor or FM company';

COMMIT;

-- =============================================================================
-- END OF COMPLETE MIGRATION
-- =============================================================================