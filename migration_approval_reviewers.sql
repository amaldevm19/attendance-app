-- =============================================================================
-- migration_approval_reviewers.sql
-- Adds approval_reviewers table to support multi-level approval routing.
--
-- Each approval_request can now have multiple reviewers (Supervisor, Team Lead,
-- Admin) based on the submitting employee's role in the hierarchy.
-- The pending-approvals query joins this table so each reviewer sees only
-- the requests routed to them.
--
-- Legacy approvals (before this migration) fall back to the old reports_to
-- logic via the OR clause in the pending-approvals query — no data migration
-- needed for existing rows.
-- =============================================================================

CREATE TABLE IF NOT EXISTS approval_reviewers (
  id                  SERIAL PRIMARY KEY,
  approval_request_id INTEGER      NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  reviewer_emp_id     VARCHAR(50)  NOT NULL REFERENCES employees(emp_id)     ON DELETE CASCADE,
  role_name           VARCHAR(50),          -- snapshot of reviewer's role at creation time
  -- Individual reviewer action (set when they approve/reject)
  action              VARCHAR(20)  CHECK (action IN ('approved', 'rejected')),
  action_comment      TEXT,
  acted_at            TIMESTAMP,
  created_at          TIMESTAMP    NOT NULL DEFAULT NOW(),
  UNIQUE (approval_request_id, reviewer_emp_id)
);

-- Index for the pending-approvals query: WHERE rv.reviewer_emp_id = $1
CREATE INDEX IF NOT EXISTS idx_approval_reviewers_reviewer
  ON approval_reviewers (reviewer_emp_id);

-- Index for the EXISTS subquery: WHERE rv.approval_request_id = ar.id
CREATE INDEX IF NOT EXISTS idx_approval_reviewers_request
  ON approval_reviewers (approval_request_id);