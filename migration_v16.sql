-- =============================================================================
-- BTD Attendance App — Migration V16
-- =============================================================================
-- Created  : 2026-05-15
-- Depends  : migration_v15.sql (employee_score_components must exist)
--
-- Purpose  : AI Assistant infrastructure
--
-- Changes  :
--   ALTER   products          — adds image_url, specs JSONB, source_url
--   CREATE  product_prices    — append-only price history (analytics-ready)
--   CREATE  ai_providers      — one row per LLM provider, API key encrypted at rest
--   CREATE  ai_chat_sessions  — one row per conversation, locked to provider + model
--   CREATE  ai_chat_messages  — full message + tool call log per session
--   CREATE  VIEW product_price_current
--   CREATE  FUNCTION touch_ai_chat_session (trigger function)
--   CREATE  FUNCTION touch_ai_provider     (trigger function)
--   CREATE  TRIGGER trg_touch_ai_session
--   CREATE  TRIGGER trg_touch_ai_provider
--   SEED    permissions: ai:chat:read, ai:chat:write, ai:settings:read, ai:settings:write
--   SEED    role_permissions: all four granted to Admin role
--   SEED    ai_providers: five provider rows (keys empty, enabled via AISettings page)
--
-- Encryption :
--   ai_providers.api_key_encrypted stores AES-256-GCM ciphertext.
--   Format: <hex_iv>:<hex_authTag>:<hex_ciphertext>
--   Secret: AI_ENCRYPTION_KEY env var (32-byte hex) on the Node.js server.
--   The DB never holds the plaintext key. See utils/encryption.js.
--
-- Ollama note :
--   Ollama by default binds to 127.0.0.1. To accept connections from the
--   BTD API server, set OLLAMA_HOST=0.0.0.0 on the Ollama machine before
--   starting it. The reachable URL is stored per session (ai_chat_sessions.ollama_url)
--   because Ollama may run on different machines on different days.
--
-- Safe to re-run: all DDL uses IF NOT EXISTS / OR REPLACE / ON CONFLICT DO NOTHING.
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1: Extend products table
-- Non-destructive — existing rows get NULLs for the new columns.
-- =============================================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS image_url   TEXT,
  ADD COLUMN IF NOT EXISTS specs       JSONB,
  -- specs is intentionally schema-free: Hikvision camera specs (resolution, lens,
  -- IR range) are completely different from a Siemens fire panel spec.
  -- Store as { "key": "value" } pairs, AI agent decides what to populate.
  ADD COLUMN IF NOT EXISTS source_url  TEXT;
  -- source_url: canonical product page the AI agent used as its price reference.

-- =============================================================================
-- SECTION 2: Product price history (append-only log)
-- =============================================================================
-- NEVER UPDATE or DELETE rows — only INSERT new ones.
-- Latest row per product_id = current price.
-- Query via product_price_current VIEW, not this table directly.
-- Same philosophy as employee_score_components.
-- =============================================================================

CREATE TABLE IF NOT EXISTS product_prices (
  id             BIGSERIAL     PRIMARY KEY,
  product_id     INTEGER       NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  lowest_price   NUMERIC(10,2),                 -- lowest found across sources (AED)
  average_price  NUMERIC(10,2),                 -- mean across sources (AED)
  currency       VARCHAR(5)    NOT NULL DEFAULT 'AED',
  source         VARCHAR(20)   NOT NULL DEFAULT 'ai_search'
    CHECK (source IN (
      'ai_search',   -- AI assistant fetched via web search
      'manual',      -- admin entered directly in the UI
      'import'       -- future: bulk CSV import
    )),
  source_notes   TEXT,
  -- e.g. "noon.com · tradeling.com · hikvision-uae.com"
  fetched_by     VARCHAR(50)   REFERENCES employees(emp_id) ON DELETE SET NULL,
  -- emp_id of the admin who triggered the fetch; NULL = system / scheduled job
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- SECTION 3: AI providers
-- =============================================================================
-- One row per provider. The admin fills in keys and enables each one
-- via AISettings.jsx. Disabled by default until a key is set.
--
-- api_key_encrypted: AES-256-GCM ciphertext, format iv:authTag:ciphertext (hex).
--   Decrypted in utils/encryption.js using AI_ENCRYPTION_KEY env var.
--   NULL for Ollama (no API key required).
--
-- base_url: overridable API endpoint.
--   NULL  = use provider's default public endpoint.
--   Set   = for Ollama (machine IP), Azure OpenAI, or any reverse proxy.
--
-- is_enabled: admin toggles this after adding a valid key.
--   Disabled provider rows cannot be selected in the new-session modal.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ai_providers (
  id                  SERIAL        PRIMARY KEY,
  provider_key        VARCHAR(30)   NOT NULL UNIQUE,
  -- internal identifier used in code: 'anthropic' | 'openai' | 'google' | 'groq' | 'ollama'
  display_name        VARCHAR(50)   NOT NULL,
  -- shown in the UI picker
  api_key_encrypted   TEXT,
  -- NULL for Ollama. Format: <hex_iv>:<hex_authTag>:<hex_ciphertext>
  base_url            TEXT,
  -- NULL = provider default. Ollama: e.g. 'http://192.168.1.50:11434'
  is_enabled          BOOLEAN       NOT NULL DEFAULT FALSE,
  key_updated_at      TIMESTAMPTZ,
  -- timestamp of last key save — shown in UI as "Key last updated X days ago"
  key_updated_by      VARCHAR(50)   REFERENCES employees(emp_id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- SECTION 4: AI chat sessions
-- =============================================================================
-- One row per conversation thread.
-- provider_id + model are locked at session creation (per-session model selection).
-- ollama_url stored per session because the Ollama machine IP can differ
-- between sessions (office machine vs. home machine vs. future GPU server).
-- title is NULL at creation; backend sets it from the first 120 chars of the
-- admin's opening message after the first ai_chat_messages row is inserted.
-- updated_at is maintained automatically by trg_touch_ai_session.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ai_chat_sessions (
  id             SERIAL        PRIMARY KEY,
  admin_emp_id   VARCHAR(50)   NOT NULL REFERENCES employees(emp_id) ON DELETE CASCADE,
  title          VARCHAR(200),
  -- NULL on creation; set by backend after first message insert
  provider_id    INTEGER       NOT NULL REFERENCES ai_providers(id) ON DELETE RESTRICT,
  -- RESTRICT: cannot delete a provider that has sessions — preserves history
  model          VARCHAR(100)  NOT NULL,
  -- exact model string: 'claude-sonnet-4-20250514', 'gpt-4o', 'llama3.2', etc.
  ollama_url     TEXT,
  -- only populated when provider_key = 'ollama'
  -- e.g. 'http://192.168.1.50:11434' — whatever the admin entered at session start
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- SECTION 5: AI chat messages
-- =============================================================================
-- One row per message turn in a session.
-- Covers all turn types needed to replay full context to any LLM API:
--
--   user        — admin typed this
--   assistant   — LLM replied with this text
--   tool_use    — LLM called a tool (tool_name + tool_input populated)
--   tool_result — result returned to LLM (content = result payload as JSON string)
--
-- tool_use_id: the ID that links a tool_use call to its tool_result response.
--   Anthropic calls this 'tool_use_id'. OpenAI calls it 'tool_call_id'.
--   The AI router normalises it into this single column on context replay.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ai_chat_messages (
  id           BIGSERIAL     PRIMARY KEY,
  session_id   INTEGER       NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
  role         VARCHAR(15)   NOT NULL
    CHECK (role IN ('user', 'assistant', 'tool_use', 'tool_result')),
  content      TEXT,
  -- user/assistant: message text
  -- tool_result:    JSON string of result payload
  -- tool_use:       NULL (detail is in tool_name + tool_input)
  tool_name    VARCHAR(100),
  -- populated for role = 'tool_use': 'insert_product', 'web_search', etc.
  tool_input   JSONB,
  -- populated for role = 'tool_use': exact arguments the LLM passed
  tool_use_id  VARCHAR(100),
  -- Anthropic: tool_use_id | OpenAI: tool_call_id. Links tool_use → tool_result.
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- SECTION 6: View — current price per product
-- =============================================================================
-- Returns the single most-recent product_prices row per product_id.
-- Mirrors employee_score_current pattern exactly.
-- Always use this view; never query product_prices directly for "current" price.
-- =============================================================================

CREATE OR REPLACE VIEW product_price_current AS
SELECT DISTINCT ON (product_id)
  id,
  product_id,
  lowest_price,
  average_price,
  currency,
  source,
  source_notes,
  fetched_by,
  created_at
FROM product_prices
ORDER BY product_id, id DESC;

-- =============================================================================
-- SECTION 7: Indexes
-- =============================================================================

-- product_prices: analytics queries by product over time
CREATE INDEX IF NOT EXISTS idx_product_prices_product
  ON product_prices (product_id);

CREATE INDEX IF NOT EXISTS idx_product_prices_product_time
  ON product_prices (product_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_product_prices_created
  ON product_prices (created_at DESC);

-- ai_providers: fast lookup by provider_key string (used by the router)
CREATE INDEX IF NOT EXISTS idx_ai_providers_key
  ON ai_providers (provider_key);

-- ai_chat_sessions: sidebar history sorted by most-recently-active per admin
CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_admin
  ON ai_chat_sessions (admin_emp_id, updated_at DESC);

-- ai_chat_sessions: filter sessions by provider (analytics, settings page)
CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_provider
  ON ai_chat_sessions (provider_id);

-- ai_chat_messages: replay full conversation in insertion order
CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_session
  ON ai_chat_messages (session_id, id ASC);

-- ai_chat_messages: fast tool_result lookup by tool_use_id during context rebuild
CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_tool_use_id
  ON ai_chat_messages (tool_use_id)
  WHERE tool_use_id IS NOT NULL;

-- =============================================================================
-- SECTION 8: Trigger — keep ai_chat_sessions.updated_at current
-- =============================================================================
-- Fires AFTER every INSERT into ai_chat_messages.
-- Updates the parent session's updated_at automatically so the sidebar sorts
-- by most-recently-active without the backend issuing a separate UPDATE.
-- =============================================================================

CREATE OR REPLACE FUNCTION touch_ai_chat_session()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE ai_chat_sessions
  SET updated_at = NOW()
  WHERE id = NEW.session_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_ai_session ON ai_chat_messages;
CREATE TRIGGER trg_touch_ai_session
  AFTER INSERT ON ai_chat_messages
  FOR EACH ROW EXECUTE FUNCTION touch_ai_chat_session();

-- =============================================================================
-- SECTION 9: Trigger — keep ai_providers.updated_at current
-- =============================================================================

CREATE OR REPLACE FUNCTION touch_ai_provider()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_ai_provider ON ai_providers;
CREATE TRIGGER trg_touch_ai_provider
  BEFORE UPDATE ON ai_providers
  FOR EACH ROW EXECUTE FUNCTION touch_ai_provider();

-- =============================================================================
-- SECTION 10: Seed — AI providers
-- =============================================================================
-- Five rows seeded, all disabled. Admin enables each one after pasting a key
-- in AISettings.jsx. ON CONFLICT DO NOTHING = safe to re-run.
-- Ollama base_url seeded as localhost placeholder — admin sets real machine IP.
-- =============================================================================

INSERT INTO ai_providers (provider_key, display_name, api_key_encrypted, base_url, is_enabled) VALUES
  ('anthropic', 'Anthropic', NULL, NULL,                         FALSE),
  ('openai',    'OpenAI',    NULL, NULL,                         FALSE),
  ('google',    'Google',    NULL, NULL,                         FALSE),
  ('groq',      'Groq',      NULL, NULL,                         FALSE),
  ('ollama',    'Ollama',    NULL, 'http://localhost:11434',      FALSE)
ON CONFLICT (provider_key) DO NOTHING;

-- =============================================================================
-- SECTION 11: Seed — permissions
-- =============================================================================

INSERT INTO permissions (name, description) VALUES
  ('ai:chat:read',      'View AI assistant chat history'),
  ('ai:chat:write',     'Send messages to the AI assistant and trigger agent actions'),
  ('ai:settings:read',  'View AI provider configuration and key status'),
  ('ai:settings:write', 'Add or update AI provider API keys and enable/disable providers')
ON CONFLICT (name) DO NOTHING;

-- Grant all four AI permissions to Admin role.
-- role_permissions PRIMARY KEY (role_id, permission_id) — ON CONFLICT DO NOTHING is correct.
INSERT INTO role_permissions (role_id, permission_id)
SELECT
  (SELECT id FROM roles WHERE name = 'Admin'),
  p.id
FROM permissions p
WHERE p.name IN (
  'ai:chat:read',
  'ai:chat:write',
  'ai:settings:read',
  'ai:settings:write'
)
ON CONFLICT DO NOTHING;

-- =============================================================================
-- SECTION 12: Comments
-- =============================================================================

COMMENT ON TABLE product_prices IS
  'Append-only price history per product. Never UPDATE — only INSERT. '
  'Latest price = highest id per product_id. Use product_price_current view.';

COMMENT ON TABLE ai_providers IS
  'One row per LLM provider. api_key_encrypted: AES-256-GCM ciphertext, '
  'format hex_iv:hex_authTag:hex_ciphertext. Decrypted in utils/encryption.js '
  'using AI_ENCRYPTION_KEY env var. Never store or log the plaintext key.';

COMMENT ON COLUMN ai_providers.api_key_encrypted IS
  'AES-256-GCM encrypted API key. Format: hex_iv:hex_authTag:hex_ciphertext. '
  'NULL for Ollama. Encrypt/decrypt via utils/encryption.js + AI_ENCRYPTION_KEY env var.';

COMMENT ON COLUMN ai_providers.base_url IS
  'NULL = provider default endpoint. Set for Ollama (reachable machine IP), '
  'Azure OpenAI, or any proxy. e.g. http://192.168.1.50:11434';

COMMENT ON TABLE ai_chat_sessions IS
  'One conversation thread per row. provider_id + model locked at creation. '
  'updated_at maintained by trg_touch_ai_session trigger on message insert.';

COMMENT ON COLUMN ai_chat_sessions.ollama_url IS
  'Only populated for Ollama sessions. Stored per-session because the '
  'Ollama machine IP can differ between sessions.';

COMMENT ON COLUMN ai_chat_sessions.title IS
  'NULL at creation. Backend sets this from first 120 chars of the opening '
  'user message after the first ai_chat_messages row is inserted.';

COMMENT ON TABLE ai_chat_messages IS
  'Full message log per session. Includes user, assistant, tool_use, and '
  'tool_result rows — everything needed to replay context to the LLM API.';

COMMENT ON COLUMN ai_chat_messages.tool_use_id IS
  'Anthropic: tool_use_id | OpenAI: tool_call_id. Links tool_use → tool_result. '
  'AI router normalises this field when rebuilding multi-turn context.';

COMMENT ON VIEW product_price_current IS
  'Latest product_prices row per product_id. Mirrors employee_score_current. '
  'Always use this view for current price — never query product_prices directly.';

COMMIT;

-- =============================================================================
-- DEPLOYMENT CHECKLIST
-- =============================================================================
--
-- PRE-FLIGHT
-- [ ] Confirm migration_v15.sql is deployed:
--       SELECT COUNT(*) FROM employee_score_components;  -- must not error
--
-- [ ] Generate AI_ENCRYPTION_KEY and add to server environment:
--       node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
--     Add to .env / pm2 ecosystem.config.js as:
--       AI_ENCRYPTION_KEY=<64-char hex string>
--     !! CRITICAL: Back this up. Losing it = all stored API keys become unrecoverable.
--
-- RUN
--   psql $DATABASE_URL -f migration_v16.sql
--
-- VERIFY
--   \d products                   -- image_url, specs, source_url columns present
--   \d product_prices             -- new table
--   \d ai_providers               -- new table, 5 rows
--   \d ai_chat_sessions           -- new table
--   \d ai_chat_messages           -- new table
--   \dv product_price_current     -- new view
--   SELECT provider_key, display_name, is_enabled FROM ai_providers;
--   -- Expected: 5 rows, all is_enabled = false
--
-- POST-DEPLOY (next steps)
--   [ ] Create attendance-api/utils/encryption.js  (encrypt / decrypt helpers)
--   [ ] Create aiRoutes.js                          (chat + provider + Ollama routes)
--   [ ] Create attendance-admin/src/pages/AIAssistant.jsx
--   [ ] Create attendance-admin/src/pages/AISettings.jsx
--   [ ] Add 'AI Assistant' nav group to Sidebar.jsx (Chat + Settings links)
--   [ ] No pm2 restart needed yet — schema-only change
--
-- OLLAMA SETUP (when ready to use)
--   On the Ollama machine:
--     export OLLAMA_HOST=0.0.0.0   -- allow external connections
--     ollama serve
--   Pull models first:
--     ollama pull llama3.2
--     ollama pull mistral
--   Test reachability from BTD server:
--     curl http://<ollama-machine-ip>:11434/api/tags
--   Enter that URL in AISettings.jsx when creating an Ollama session.
--
-- =============================================================================