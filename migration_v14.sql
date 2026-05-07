-- =============================================================================
-- MIGRATION v14 — Employee Expertise System
-- Employees self-declare which systems they are expert in.
-- TL/Supervisor endorse (Strongly Agree / Agree / Disagree) during rating polls.
-- =============================================================================

BEGIN;

-- ── 1. Employee expertise declarations ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_expertise (
  id          SERIAL PRIMARY KEY,
  employee_id VARCHAR(50) NOT NULL REFERENCES employees(emp_id) ON DELETE CASCADE,
  system_id   INTEGER     NOT NULL REFERENCES systems(id)       ON DELETE CASCADE,
  added_at    TIMESTAMP   DEFAULT NOW(),
  UNIQUE (employee_id, system_id)
);

CREATE INDEX IF NOT EXISTS idx_expertise_employee ON employee_expertise(employee_id);
CREATE INDEX IF NOT EXISTS idx_expertise_system   ON employee_expertise(system_id);

-- ── 2. Expertise endorsements by TL / Supervisor during a rating session ──────
-- One row per (session, employee, system, rater).
-- endorsement: 'strongly_agree' | 'agree' | 'disagree'
CREATE TABLE IF NOT EXISTS expertise_endorsements (
  id              SERIAL PRIMARY KEY,
  session_id      INTEGER     NOT NULL REFERENCES assessment_sessions(id) ON DELETE CASCADE,
  employee_id     VARCHAR(50) NOT NULL REFERENCES employees(emp_id)       ON DELETE CASCADE,
  system_id       INTEGER     NOT NULL REFERENCES systems(id)             ON DELETE CASCADE,
  rater_id        VARCHAR(50) NOT NULL REFERENCES employees(emp_id)       ON DELETE CASCADE,
  endorsement     VARCHAR(20) NOT NULL CHECK (endorsement IN ('strongly_agree','agree','disagree')),
  created_at      TIMESTAMP   DEFAULT NOW(),
  UNIQUE (session_id, employee_id, system_id, rater_id)
);

CREATE INDEX IF NOT EXISTS idx_endorsements_employee ON expertise_endorsements(employee_id);
CREATE INDEX IF NOT EXISTS idx_endorsements_session  ON expertise_endorsements(session_id);

COMMIT;

-- Verification:
-- \d employee_expertise
-- \d expertise_endorsements