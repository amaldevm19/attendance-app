-- =============================================================================
-- MIGRATION v13 — Portfolio-Aware Q&A System
-- Adds system_id to qa_questions so questions are tagged to a specific system.
-- new_systems      = questions about systems NOT in the employee's portfolio
-- portfolio_systems = questions about systems IN the employee's portfolio
-- =============================================================================

BEGIN;

-- ── 1. Add system_id to qa_questions ─────────────────────────────────────────
ALTER TABLE qa_questions
  ADD COLUMN IF NOT EXISTS system_id INTEGER REFERENCES systems(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_qa_questions_system ON qa_questions(system_id)
  WHERE system_id IS NOT NULL;

COMMENT ON COLUMN qa_questions.system_id IS
  'The specific system this question is about. Used for portfolio-aware assignment:
   portfolio_systems questions → matched to employee''s own portfolio systems.
   new_systems questions → matched to systems NOT in employee''s portfolio.
   NULL = general question, not system-specific.';

-- ── 2. Widen question_category check to keep both categories ─────────────────
-- No change needed — existing CHECK constraint already includes both.
-- Just documenting the new semantics:
--   general_technical  → no system_id needed (general knowledge)
--   ppm_fitout         → no system_id needed (general skill)
--   new_systems        → system_id REQUIRED (specific system outside portfolio)
--   portfolio_systems  → system_id REQUIRED (specific system inside portfolio)

COMMIT;

-- =============================================================================
-- VERIFICATION
-- =============================================================================
-- \d qa_questions  -- should show system_id column
-- SELECT id, question_text, question_category, system_id FROM qa_questions LIMIT 5;
-- =============================================================================