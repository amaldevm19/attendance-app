-- =============================================================================
-- MIGRATION v10 — Attendance Workflow Expansion
-- Builds on migration_v9.sql
-- Run once against attendance_db
-- Safe to re-run: uses IF NOT EXISTS / IF EXISTS guards throughout
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1: WIDEN attendance_logs.action_type
-- Currently VARCHAR(10) storing 'IN' / 'OUT'.
-- DUTY_START (10), SPECIAL_OUT (11) both need more room → VARCHAR(20).
-- Old 'IN' / 'OUT' rows are intentionally preserved and remain queryable.
-- NOTE: dashboard-stats query filters action_type = 'IN' — update that query
--       in Phase 2 to also include SITE_IN if you want legacy + new counts.
-- =============================================================================

ALTER TABLE attendance_logs
  ALTER COLUMN action_type TYPE VARCHAR(20);

-- =============================================================================
-- SECTION 2: NEW COLUMNS on attendance_logs
-- =============================================================================

-- sub_type: further classifies the punch action
--   Valid values (not enforced by DB constraint, enforced by API):
--   site_survey | material_purchase | others | forgot_punch | battery_dead
ALTER TABLE attendance_logs
  ADD COLUMN IF NOT EXISTS sub_type VARCHAR(50);

-- location_type: where the punch happened
--   home | registered_site | unauthorized
ALTER TABLE attendance_logs
  ADD COLUMN IF NOT EXISTS location_type VARCHAR(20);

-- approval fields — default true for all normal punches
ALTER TABLE attendance_logs
  ADD COLUMN IF NOT EXISTS is_approved BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE attendance_logs
  ADD COLUMN IF NOT EXISTS approved_by VARCHAR(50)
    REFERENCES employees(emp_id) ON DELETE SET NULL;

ALTER TABLE attendance_logs
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;

-- score_flag: set TRUE on rejected corrections to feed future evaluation module
ALTER TABLE attendance_logs
  ADD COLUMN IF NOT EXISTS score_flag BOOLEAN NOT NULL DEFAULT FALSE;

-- =============================================================================
-- SECTION 3: NEW COLUMNS on employees — home location
-- =============================================================================

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS home_latitude  DOUBLE PRECISION;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS home_longitude DOUBLE PRECISION;

-- Radius in metres within which a punch counts as "at home" (default 100 m)
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS home_radius INTEGER NOT NULL DEFAULT 100;

-- =============================================================================
-- SECTION 4: MODIFY active_sessions to support duty sessions (no site)
--
-- Problem: current schema has site_id NOT NULL and UNIQUE(employee_id, site_id).
-- A DUTY_START session has no site, and an employee can only have one duty
-- session at a time — but may have multiple site sessions in parallel.
--
-- Solution:
--   • Make site_id nullable
--   • Add session_type column
--   • Replace the old unique constraint with two partial unique indexes:
--       - Only one duty session per employee at a time
--       - Only one site session per employee+site at a time
-- =============================================================================

-- 4a. Drop the old NOT NULL constraint on site_id
ALTER TABLE active_sessions
  ALTER COLUMN site_id DROP NOT NULL;

-- 4b. Add session_type column
--   Values: duty | site | special
ALTER TABLE active_sessions
  ADD COLUMN IF NOT EXISTS session_type VARCHAR(20) NOT NULL DEFAULT 'site';

-- 4c. Drop the old single unique constraint
--     (employee_id, site_id) was the v9 constraint name — PostgreSQL auto-names
--     it based on table+columns. We drop by finding the actual constraint name.
DO $$
DECLARE
  v_constraint TEXT;
BEGIN
  SELECT conname INTO v_constraint
  FROM pg_constraint
  WHERE conrelid = 'active_sessions'::regclass
    AND contype = 'u'
    AND conname LIKE '%employee_id%site_id%';

  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE active_sessions DROP CONSTRAINT %I', v_constraint);
  END IF;
END$$;

-- 4d. Partial unique index: only one DUTY session per employee
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_sessions_duty
  ON active_sessions (employee_id)
  WHERE session_type = 'duty';

-- 4e. Partial unique index: only one SITE session per employee+site combo
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_sessions_site
  ON active_sessions (employee_id, site_id)
  WHERE session_type = 'site' AND site_id IS NOT NULL;

-- =============================================================================
-- SECTION 5: NEW TABLE — correction_requests
--
-- Created when an employee submits a missed punch-out for TL review.
-- open_session_id references the active_sessions row that is still open.
-- After submission the session is closed optimistically by the API, so we
-- store the session snapshot here for audit even after the row is deleted.
-- =============================================================================

CREATE TABLE IF NOT EXISTS correction_requests (
  id                  SERIAL PRIMARY KEY,
  employee_id         VARCHAR(50) NOT NULL REFERENCES employees(emp_id) ON DELETE CASCADE,

  -- Snapshot of the open session at submission time (session may be deleted)
  open_session_id     INTEGER,          -- no FK — session deleted on close
  session_site_id     INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  session_job_id      INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  session_punched_in_at TIMESTAMP,

  -- What the employee is claiming
  proposed_out_time   TIMESTAMP NOT NULL,
  reason              TEXT NOT NULL,

  -- sub_type mirrors attendance_logs.sub_type
  --   forgot_punch | battery_dead | others
  sub_type            VARCHAR(50),

  -- Workflow state
  status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'rejected')),

  -- TL review fields
  reviewed_by         VARCHAR(50) REFERENCES employees(emp_id) ON DELETE SET NULL,
  reviewed_at         TIMESTAMP,
  tl_comment          TEXT,

  -- Links to the attendance_log row created on approval/rejection
  resolved_log_id     INTEGER REFERENCES attendance_logs(id) ON DELETE SET NULL,

  -- Set TRUE on rejection; feeds employee evaluation later
  score_flag          BOOLEAN NOT NULL DEFAULT FALSE,

  created_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_correction_requests_employee
  ON correction_requests (employee_id);

CREATE INDEX IF NOT EXISTS idx_correction_requests_status
  ON correction_requests (status);

CREATE INDEX IF NOT EXISTS idx_correction_requests_reviewed_by
  ON correction_requests (reviewed_by);

-- =============================================================================
-- SECTION 6: NEW TABLE — approval_requests
--
-- Created for any punch that requires TL sign-off before it counts:
--   • special_punch  (unauthorized location IN/OUT)
--   • correction     (mirrors correction_requests but gives TL a unified queue)
--
-- attendance_log_id points to the log row that was inserted with is_approved=false.
-- On TL approval the log row is updated: is_approved=true, approved_by, approved_at.
-- On rejection: score_flag=true on the log, email sent to PM.
-- =============================================================================

CREATE TABLE IF NOT EXISTS approval_requests (
  id                  SERIAL PRIMARY KEY,
  employee_id         VARCHAR(50) NOT NULL REFERENCES employees(emp_id) ON DELETE CASCADE,

  -- The attendance_log row awaiting approval (nullable for correction-type)
  attendance_log_id   INTEGER REFERENCES attendance_logs(id) ON DELETE SET NULL,

  -- Link back to correction_requests when request_type = 'correction'
  correction_request_id INTEGER REFERENCES correction_requests(id) ON DELETE SET NULL,

  -- Type of approval needed
  request_type        VARCHAR(30) NOT NULL
                        CHECK (request_type IN ('correction', 'special_punch')),

  -- Snapshot fields so TL sees context without extra joins
  sub_type            VARCHAR(50),
  reason              TEXT,
  punch_time          TIMESTAMP,        -- the time being approved
  site_id             INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  job_id              INTEGER REFERENCES jobs(id) ON DELETE SET NULL,

  -- Workflow state
  status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'rejected')),

  -- TL review fields
  reviewed_by         VARCHAR(50) REFERENCES employees(emp_id) ON DELETE SET NULL,
  reviewed_at         TIMESTAMP,
  tl_comment          TEXT,

  created_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_employee
  ON approval_requests (employee_id);

CREATE INDEX IF NOT EXISTS idx_approval_requests_status
  ON approval_requests (status);

-- TL queries: "show me pending items for my team"
-- The API will join approval_requests.employee_id → employees.reports_to = :tl_emp_id
CREATE INDEX IF NOT EXISTS idx_approval_requests_pending
  ON approval_requests (status, employee_id)
  WHERE status = 'pending';

-- =============================================================================
-- SECTION 7: HELPFUL COMMENTS for Phase 2 API authors
-- =============================================================================

COMMENT ON COLUMN attendance_logs.action_type IS
  'Allowed values: IN, OUT (legacy), DUTY_START, DUTY_END, SITE_IN, SITE_OUT, SPECIAL_IN, SPECIAL_OUT';

COMMENT ON COLUMN attendance_logs.sub_type IS
  'Optional sub-classification: site_survey, material_purchase, others, forgot_punch, battery_dead';

COMMENT ON COLUMN attendance_logs.location_type IS
  'Where the punch happened: home | registered_site | unauthorized';

COMMENT ON COLUMN attendance_logs.is_approved IS
  'FALSE for special/correction punches awaiting TL approval. TRUE for all normal punches.';

COMMENT ON COLUMN attendance_logs.score_flag IS
  'TRUE when TL rejects a correction — feeds employee evaluation module (Phase N).';

COMMENT ON COLUMN active_sessions.session_type IS
  'duty = morning duty session (no site_id), site = site visit, special = unauthorized location punch';

COMMENT ON TABLE correction_requests IS
  'Submitted when an employee missed a punch-out. TL approves/rejects the proposed_out_time.';

COMMENT ON TABLE approval_requests IS
  'Unified TL approval queue for special punches and corrections. One row per item needing review.';

COMMIT;

-- =============================================================================
-- VERIFICATION QUERIES (run manually after applying migration)
-- =============================================================================
-- Check attendance_logs columns:
--   \d attendance_logs
--
-- Check active_sessions indexes:
--   SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'active_sessions';
--
-- Confirm new tables exist:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public'
--   AND table_name IN ('correction_requests', 'approval_requests');
-- =============================================================================