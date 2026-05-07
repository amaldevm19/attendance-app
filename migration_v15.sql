-- =============================================================================
-- MIGRATION v15 — Employee Score Components (append-only log)
--
-- Formula:
--   Total = ROUND((tl_rating + sup_rating) / 2)
--           + qa + client_poll
--           + auto_punch + auto_timeline + auto_qa_late
--
-- auto_* start at max (full marks), decrease on violations (floor 0).
-- poll/qa/client start at defaults, each new rating inserts a new row.
-- Latest row per (employee_id, component) = current value.
-- All rows kept forever for history.
--
-- Default values summing to exactly 300:
--   tl_rating=150, sup_rating=150 → (150+150)/2 = 150
--   qa=21, client_poll=54         → 75 (proportional to max_score split)
--   auto_punch=25, auto_timeline=25, auto_qa_late=25 → 75
--   TOTAL = 150 + 21 + 54 + 75 = 300 ✓
-- =============================================================================

BEGIN;

DROP TABLE    IF EXISTS employee_score_components CASCADE;
DROP VIEW     IF EXISTS employee_score_current    CASCADE;
DROP FUNCTION IF EXISTS recalculate_employee_score(VARCHAR) CASCADE;

-- ── Table ─────────────────────────────────────────────────────────────────────
CREATE TABLE employee_score_components (
  id           SERIAL       PRIMARY KEY,
  employee_id  VARCHAR(50)  NOT NULL REFERENCES employees(emp_id) ON DELETE CASCADE,
  component    VARCHAR(20)  NOT NULL CHECK (component IN (
                 'tl_rating','sup_rating','qa','client_poll',
                 'auto_punch','auto_timeline','auto_qa_late'
               )),
  value        NUMERIC(8,2) NOT NULL,
  max_value    NUMERIC(8,2) NOT NULL,
  session_id   INTEGER      REFERENCES assessment_sessions(id) ON DELETE SET NULL,
  qa_id        INTEGER      REFERENCES qa_assignments(id)      ON DELETE SET NULL,
  note         TEXT,
  created_at   TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_esc_employee  ON employee_score_components(employee_id);
CREATE INDEX idx_esc_component ON employee_score_components(employee_id, component);
CREATE INDEX idx_esc_created   ON employee_score_components(employee_id, component, id DESC);

-- ── View: latest value per employee per component ─────────────────────────────
CREATE VIEW employee_score_current AS
SELECT DISTINCT ON (employee_id, component)
  id, employee_id, component, value, max_value, session_id, note, created_at
FROM employee_score_components
ORDER BY employee_id, component, id DESC;

-- ── Recalculation function ────────────────────────────────────────────────────
CREATE FUNCTION recalculate_employee_score(p_emp_id VARCHAR)
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

-- ── Seed defaults for all existing employees ──────────────────────────────────
DO $$
DECLARE
  emp       RECORD;
  v_tl_max  NUMERIC;
  v_qa_max  NUMERIC;
  v_cli_max NUMERIC;
  v_qa_def  NUMERIC;
  v_cli_def NUMERIC;
BEGIN
  SELECT COALESCE(SUM(max_score), 450) INTO v_tl_max
    FROM assessment_criteria WHERE source = 'poll_avg'    AND is_active = TRUE;
  SELECT COALESCE(SUM(max_score), 125) INTO v_qa_max
    FROM assessment_criteria WHERE source = 'qa'          AND is_active = TRUE;
  SELECT COALESCE(SUM(max_score), 325) INTO v_cli_max
    FROM assessment_criteria WHERE source = 'client_poll' AND is_active = TRUE;

  -- Proportional split of 75 between qa and client
  v_qa_def  := FLOOR(75.0 * v_qa_max  / NULLIF(v_qa_max + v_cli_max, 0));
  v_cli_def := 75 - v_qa_def; -- ensure exact 75 sum

  FOR emp IN SELECT emp_id FROM employees LOOP
    IF EXISTS (SELECT 1 FROM employee_score_components WHERE employee_id = emp.emp_id)
    THEN CONTINUE; END IF;

    INSERT INTO employee_score_components
      (employee_id, component, value, max_value, note)
    VALUES
      (emp.emp_id, 'tl_rating',    150,      v_tl_max,  'default'),
      (emp.emp_id, 'sup_rating',   150,      v_tl_max,  'default'),
      (emp.emp_id, 'qa',           v_qa_def, v_qa_max,  'default'),
      (emp.emp_id, 'client_poll',  v_cli_def,v_cli_max, 'default'),
      (emp.emp_id, 'auto_punch',   25,       25,        'default'),
      (emp.emp_id, 'auto_timeline',25,       25,        'default'),
      (emp.emp_id, 'auto_qa_late', 25,       25,        'default');
  END LOOP;
END $$;

-- ── Recalculate all scores ────────────────────────────────────────────────────
DO $$
DECLARE emp RECORD;
BEGIN
  FOR emp IN SELECT emp_id FROM employees LOOP
    PERFORM recalculate_employee_score(emp.emp_id);
  END LOOP;
END $$;

COMMIT;