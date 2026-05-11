-- =============================================================================
-- Migration V16: Add client_category column to clients table
-- =============================================================================
-- Created: 2026-05-10
-- Purpose: Add a static client_category field to clients table.
--          Values: 'direct_client' (end user) or 'indirect_client' (contractor/FM company)
-- =============================================================================

BEGIN;

-- Add client_category column to clients table
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS client_category VARCHAR(20)
    CHECK (client_category IN ('direct_client', 'indirect_client'));

-- Add a comment explaining the field
COMMENT ON COLUMN clients.client_category IS
  'Static category: direct_client = end user, indirect_client = contractor or FM company';

COMMIT;

-- =============================================================================
-- END OF MIGRATION V16
-- =============================================================================