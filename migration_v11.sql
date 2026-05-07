-- =============================================================================
-- MIGRATION v11 — Employee Assessment System
-- Builds on migration_v10.sql
-- Run once. Safe to re-run: uses IF NOT EXISTS / DO $$ guards throughout.
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1: ADD SCORE & BADGE TO EMPLOYEES
-- Default score = 300 (Blue badge — new joiner status).
-- badge is a computed label but stored for fast reads / display.
-- =============================================================================

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS score       INTEGER     NOT NULL DEFAULT 300;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS badge       VARCHAR(10) NOT NULL DEFAULT 'blue'
    CHECK (badge IN ('red','blue','yellow','green'));

-- Score tiers:
--   0–299   → red    (low performer / urgent intervention)
--   300     → blue   (new joiner default)
--   301–700 → yellow (developing)
--   701–1000→ green  (high performer)

-- Trigger to keep badge in sync whenever score changes
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

DROP TRIGGER IF EXISTS trg_sync_badge ON employees;
CREATE TRIGGER trg_sync_badge
  BEFORE INSERT OR UPDATE OF score ON employees
  FOR EACH ROW EXECUTE FUNCTION sync_employee_badge();

-- Back-fill badge for existing employees
UPDATE employees SET score = score; -- triggers the trigger

COMMENT ON COLUMN employees.score IS
  '1000-point scale. 0-299=red, 300=blue(new), 301-700=yellow, 701-1000=green';

-- =============================================================================
-- SECTION 2: ASSESSMENT CRITERIA (the KPI table — seeded statically)
-- Each row = one score slot.
-- source: 'poll_avg' | 'qa' | 'auto_punch' | 'auto_assessment' | 'auto_qa' | 'client_poll'
-- max_score: the ceiling for this criterion
-- applies_to_levels: integer[] — 1=TL, 2=Supervisor, 3=Technician
-- =============================================================================

CREATE TABLE IF NOT EXISTS assessment_criteria (
  id               SERIAL PRIMARY KEY,
  category         VARCHAR(100)   NOT NULL,  -- e.g. 'Technical Knowledge'
  sub_item         VARCHAR(150)   NOT NULL,  -- e.g. 'General Technical Knowledge'
  source           VARCHAR(30)    NOT NULL   -- where the score comes from
                     CHECK (source IN (
                       'poll_avg',        -- (supervisor_score + tl_score) / 2
                       'qa',              -- Q&A quiz result
                       'auto_punch',      -- automatic from punch rejection events
                       'auto_assessment', -- automatic from assessment timeliness
                       'auto_qa',         -- automatic from Q&A timeliness
                       'client_poll'      -- client email form
                     )),
  max_score        INTEGER        NOT NULL,
  applies_to_levels INTEGER[]     NOT NULL DEFAULT ARRAY[1,2,3],
  sort_order       INTEGER        NOT NULL DEFAULT 0,
  is_active        BOOLEAN        NOT NULL DEFAULT TRUE,
  is_automated     BOOLEAN        NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMP      NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_criteria_category ON assessment_criteria(category);
CREATE INDEX IF NOT EXISTS idx_criteria_source    ON assessment_criteria(source);

-- =============================================================================
-- SECTION 2a: SEED CRITERIA (idempotent — skips if already present)
-- Total = 1000 points
-- =============================================================================

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

-- =============================================================================
-- SECTION 3: ASSESSMENT_SESSIONS
-- One session = one push from Admin for a specific (employee, session_type).
-- session_type mirrors the Decision 3 table.
-- =============================================================================

CREATE TABLE IF NOT EXISTS assessment_sessions (
  id               SERIAL PRIMARY KEY,
  employee_id      VARCHAR(50)    NOT NULL REFERENCES employees(emp_id) ON DELETE CASCADE,

  -- Who is the respondent?
  -- self, by_supervisor, by_tl, rate_supervisor, rate_tl, client
  session_type     VARCHAR(20)    NOT NULL
                     CHECK (session_type IN (
                       'self',
                       'by_supervisor',
                       'by_tl',
                       'rate_supervisor', -- employee rates their supervisor
                       'rate_tl',         -- employee rates their TL
                       'client'
                     )),

  -- The respondent (who fills this in).
  -- NULL for 'client' type (email link, no account).
  respondent_id    VARCHAR(50)    REFERENCES employees(emp_id) ON DELETE SET NULL,

  -- Deadline: respondent must submit by this time
  deadline         TIMESTAMP      NOT NULL DEFAULT (NOW() + INTERVAL '1 day'),

  -- Workflow state
  status           VARCHAR(20)    NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','submitted','expired','auto_applied')),

  -- Score calculation state
  -- 'waiting'     = submitted but partner (sup/tl) hasn't submitted yet
  -- 'partial'     = deadline passed, only one side submitted, score applied at 50%
  -- 'complete'    = both sides submitted, full score applied
  -- 'not_scored'  = self/rate types — collected for analytics only
  calc_status      VARCHAR(20)    NOT NULL DEFAULT 'waiting'
                     CHECK (calc_status IN ('waiting','partial','complete','not_scored')),

  -- Score applied to employee.score (delta, positive or negative)
  score_delta      INTEGER,

  -- Automation metadata
  is_automated     BOOLEAN        NOT NULL DEFAULT FALSE,
  automation_period VARCHAR(10)   -- 'daily'|'weekly'|'monthly'
                     CHECK (automation_period IN ('daily','weekly','monthly',NULL)),

  -- Client email form token (UUID link in email)
  client_token     UUID           UNIQUE,
  client_email     VARCHAR(150),

  submitted_at     TIMESTAMP,
  created_at       TIMESTAMP      NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_employee  ON assessment_sessions(employee_id);
CREATE INDEX IF NOT EXISTS idx_sessions_respondent ON assessment_sessions(respondent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status    ON assessment_sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_deadline  ON assessment_sessions(deadline)
  WHERE status = 'pending';

COMMENT ON TABLE assessment_sessions IS
  'One row per (employee, session_type, push event). Multiple sessions per employee over time.';

-- =============================================================================
-- SECTION 4: ASSESSMENT_RESPONSES
-- One row per criterion per session.
-- Stores the score given by the respondent for each criterion.
-- =============================================================================

CREATE TABLE IF NOT EXISTS assessment_responses (
  id               SERIAL PRIMARY KEY,
  session_id       INTEGER        NOT NULL REFERENCES assessment_sessions(id) ON DELETE CASCADE,
  criterion_id     INTEGER        NOT NULL REFERENCES assessment_criteria(id) ON DELETE CASCADE,
  score_given      INTEGER        NOT NULL
                     CHECK (score_given >= 0),
  submitted_at     TIMESTAMP      NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, criterion_id)
);

CREATE INDEX IF NOT EXISTS idx_responses_session   ON assessment_responses(session_id);
CREATE INDEX IF NOT EXISTS idx_responses_criterion ON assessment_responses(criterion_id);

-- =============================================================================
-- SECTION 5: SCORE_HISTORY
-- Audit trail of every change to employees.score.
-- Enables charts, trends, rollback, discrepancy analysis.
-- =============================================================================

CREATE TABLE IF NOT EXISTS score_history (
  id               BIGSERIAL PRIMARY KEY,
  employee_id      VARCHAR(50)    NOT NULL REFERENCES employees(emp_id) ON DELETE CASCADE,
  score_before     INTEGER        NOT NULL,
  score_after      INTEGER        NOT NULL,
  delta            INTEGER        NOT NULL,  -- score_after - score_before
  reason           VARCHAR(100)   NOT NULL,
    -- 'poll_applied', 'qa_result', 'punch_rejection', 'assessment_late',
    -- 'qa_late', 'client_poll', 'manual_admin'
  session_id       INTEGER        REFERENCES assessment_sessions(id) ON DELETE SET NULL,
  qa_assignment_id INTEGER,       -- FK added in Section 7 after qa_assignments created
  triggered_by     VARCHAR(50)    REFERENCES employees(emp_id) ON DELETE SET NULL,
  created_at       TIMESTAMP      NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_score_history_employee ON score_history(employee_id);
CREATE INDEX IF NOT EXISTS idx_score_history_created  ON score_history(created_at DESC);

-- =============================================================================
-- SECTION 6: QA_QUESTIONS (question bank)
-- =============================================================================

CREATE TABLE IF NOT EXISTS qa_questions (
  id               SERIAL PRIMARY KEY,

  question_text    TEXT           NOT NULL,
  options          JSONB          NOT NULL,
    -- Array of { key: 'A'|'B'|'C'|'D', text: '...' }
  correct_answer   VARCHAR(1)     NOT NULL CHECK (correct_answer IN ('A','B','C','D')),
  marks            INTEGER        NOT NULL DEFAULT 5,

  -- Difficulty
  difficulty       VARCHAR(10)    NOT NULL DEFAULT 'basic'
                     CHECK (difficulty IN ('basic','medium','advanced')),

  -- Employee level this question targets
  -- 1=TL, 2=Supervisor, 3=Technician (matches designations.level)
  target_level     INTEGER        NOT NULL DEFAULT 3
                     CHECK (target_level IN (1,2,3)),

  -- Q&A category — maps to KPI criteria
  question_category VARCHAR(50)   NOT NULL
                     CHECK (question_category IN (
                       'general_technical',   -- Technical Knowledge QA (50 marks total)
                       'ppm_fitout',          -- Operational Skill QA  (25 marks total)
                       'new_systems',         -- Learning Mentality - New Systems (25 marks)
                       'portfolio_systems'    -- Learning Mentality - Portfolio Systems (25 marks)
                     )),

  is_active        BOOLEAN        NOT NULL DEFAULT TRUE,
  created_by       VARCHAR(50)    REFERENCES employees(emp_id) ON DELETE SET NULL,
  created_at       TIMESTAMP      NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qa_questions_category  ON qa_questions(question_category);
CREATE INDEX IF NOT EXISTS idx_qa_questions_level     ON qa_questions(target_level);
CREATE INDEX IF NOT EXISTS idx_qa_questions_active    ON qa_questions(is_active) WHERE is_active = TRUE;

COMMENT ON COLUMN qa_questions.options IS
  'JSONB array: [{"key":"A","text":"..."},{"key":"B","text":"..."},...]';

-- =============================================================================
-- SECTION 7: QA_ASSIGNMENTS
-- Admin assigns a random question set to an employee.
-- Questions picked: 5×general_technical, 5×ppm_fitout, 5×new_systems, 5×portfolio_systems
-- Marks:           5×10=50,              5×5=25,        5×5=25,        5×5=25  → 125 total
-- =============================================================================

CREATE TABLE IF NOT EXISTS qa_assignments (
  id               SERIAL PRIMARY KEY,
  employee_id      VARCHAR(50)    NOT NULL REFERENCES employees(emp_id) ON DELETE CASCADE,

  -- Snapshot of selected questions (array of qa_question ids)
  question_ids     INTEGER[]      NOT NULL,

  -- Total marks possible for this assignment
  total_marks      INTEGER        NOT NULL DEFAULT 125,

  -- Deadline (admin-set, default 1 day)
  deadline         TIMESTAMP      NOT NULL DEFAULT (NOW() + INTERVAL '1 day'),
  deadline_days    INTEGER        NOT NULL DEFAULT 1,  -- stored for display

  -- Workflow
  status           VARCHAR(20)    NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','submitted','expired')),

  score_achieved   INTEGER,   -- total marks earned, set on submission
  score_delta      INTEGER,   -- delta applied to employee.score

  -- Email option: employee can request answers emailed
  email_sent       BOOLEAN        NOT NULL DEFAULT FALSE,

  assigned_by      VARCHAR(50)    REFERENCES employees(emp_id) ON DELETE SET NULL,
  submitted_at     TIMESTAMP,
  created_at       TIMESTAMP      NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qa_assignments_employee ON qa_assignments(employee_id);
CREATE INDEX IF NOT EXISTS idx_qa_assignments_status   ON qa_assignments(status);
CREATE INDEX IF NOT EXISTS idx_qa_assignments_deadline ON qa_assignments(deadline)
  WHERE status = 'pending';

-- Now add the FK from score_history to qa_assignments
ALTER TABLE score_history
  ADD CONSTRAINT fk_score_history_qa
  FOREIGN KEY (qa_assignment_id) REFERENCES qa_assignments(id) ON DELETE SET NULL;

-- =============================================================================
-- SECTION 8: QA_ANSWERS
-- Employee's chosen answers, one row per question per assignment.
-- =============================================================================

CREATE TABLE IF NOT EXISTS qa_answers (
  id               SERIAL PRIMARY KEY,
  assignment_id    INTEGER        NOT NULL REFERENCES qa_assignments(id) ON DELETE CASCADE,
  question_id      INTEGER        NOT NULL REFERENCES qa_questions(id) ON DELETE CASCADE,
  selected_answer  VARCHAR(1)     NOT NULL CHECK (selected_answer IN ('A','B','C','D')),
  is_correct       BOOLEAN        NOT NULL,
  marks_earned     INTEGER        NOT NULL DEFAULT 0,
  answered_at      TIMESTAMP      NOT NULL DEFAULT NOW(),
  UNIQUE (assignment_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_qa_answers_assignment ON qa_answers(assignment_id);

-- =============================================================================
-- SECTION 9: ASSESSMENT_AUTOMATION_SETTINGS
-- One row per active automation rule (admin can create multiple).
-- =============================================================================

CREATE TABLE IF NOT EXISTS assessment_automation_settings (
  id               SERIAL PRIMARY KEY,
  is_enabled       BOOLEAN        NOT NULL DEFAULT FALSE,

  -- What to push
  push_type        VARCHAR(20)    NOT NULL
                     CHECK (push_type IN ('assessment','qa','both')),

  -- Frequency
  frequency        VARCHAR(10)    NOT NULL DEFAULT 'weekly'
                     CHECK (frequency IN ('daily','weekly','monthly')),

  -- Which employee levels (1=TL, 2=Sup, 3=Tech)
  target_levels    INTEGER[]      NOT NULL DEFAULT ARRAY[1,2,3],

  -- Which session types to push for assessments
  session_types    VARCHAR(20)[]  NOT NULL DEFAULT ARRAY['by_supervisor','by_tl'],

  -- Q&A deadline (days)
  qa_deadline_days INTEGER        NOT NULL DEFAULT 1,

  -- Next scheduled run
  next_run_at      TIMESTAMP,

  -- Last run metadata
  last_run_at      TIMESTAMP,
  last_run_count   INTEGER,

  created_by       VARCHAR(50)    REFERENCES employees(emp_id) ON DELETE SET NULL,
  created_at       TIMESTAMP      NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP      NOT NULL DEFAULT NOW()
);

-- Default disabled row
INSERT INTO assessment_automation_settings
  (is_enabled, push_type, frequency, target_levels, session_types, qa_deadline_days)
VALUES
  (FALSE, 'both', 'weekly', ARRAY[1,2,3], ARRAY['by_supervisor','by_tl'], 1)
ON CONFLICT DO NOTHING;

-- =============================================================================
-- SECTION 10: PENDING_ASSESSMENT_TASKS (device-level push queue)
-- When admin pushes sessions, rows appear here so mobile can fetch via
-- GET /devices/:deviceId/pending-assessment-tasks
-- =============================================================================

CREATE TABLE IF NOT EXISTS pending_assessment_tasks (
  id               SERIAL PRIMARY KEY,
  device_id        INTEGER        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  session_id       INTEGER        NOT NULL REFERENCES assessment_sessions(id) ON DELETE CASCADE,
  created_at       TIMESTAMP      NOT NULL DEFAULT NOW(),
  UNIQUE(device_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_pending_assess_device ON pending_assessment_tasks(device_id);

-- =============================================================================
-- SECTION 11: PENDING_QA_TASKS (device-level push queue for Q&A)
-- =============================================================================

CREATE TABLE IF NOT EXISTS pending_qa_tasks (
  id               SERIAL PRIMARY KEY,
  device_id        INTEGER        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  assignment_id    INTEGER        NOT NULL REFERENCES qa_assignments(id) ON DELETE CASCADE,
  created_at       TIMESTAMP      NOT NULL DEFAULT NOW(),
  UNIQUE(device_id, assignment_id)
);

CREATE INDEX IF NOT EXISTS idx_pending_qa_device ON pending_qa_tasks(device_id);

-- =============================================================================
-- SECTION 12: HELPFUL COMMENTS
-- =============================================================================

COMMENT ON TABLE assessment_sessions     IS 'One push = one session. Respondent fills criteria scores.';
COMMENT ON TABLE assessment_responses    IS 'Criterion-level score given per session.';
COMMENT ON TABLE score_history           IS 'Full audit trail of every employee score change.';
COMMENT ON TABLE qa_questions            IS 'Question bank. Admin/TL adds questions manually.';
COMMENT ON TABLE qa_assignments          IS 'Admin assigns random question sets to employees.';
COMMENT ON TABLE qa_answers              IS 'Employee answers per assignment question.';
COMMENT ON TABLE assessment_automation_settings IS 'Controls automated push of assessments and Q&A.';
COMMENT ON TABLE pending_assessment_tasks IS 'Device push queue for assessment tile.';
COMMENT ON TABLE pending_qa_tasks        IS 'Device push queue for Q&A tile.';

COMMIT;

-- =============================================================================
-- VERIFICATION
-- =============================================================================
-- SELECT COUNT(*) FROM assessment_criteria;              -- should be 22
-- SELECT SUM(max_score) FROM assessment_criteria;        -- should be 1000
-- \d employees                                           -- should show score, badge
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema='public'
--   AND table_name IN ('assessment_sessions','assessment_responses','score_history',
--                      'qa_questions','qa_assignments','qa_answers',
--                      'assessment_automation_settings',
--                      'pending_assessment_tasks','pending_qa_tasks');
-- =============================================================================