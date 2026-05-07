-- Logging infrastructure + system config
-- Run after migration_v6.sql
 
-- ── 1. System Config ─────────────────────────────────────────────────────────
-- Central config table — editable from admin UI or psql
-- No hardcoded values in code for operational settings
CREATE TABLE IF NOT EXISTS system_config (
  key         VARCHAR(100) PRIMARY KEY,
  value       TEXT         NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ  DEFAULT NOW(),
  updated_by  VARCHAR(100) DEFAULT 'system'
);
 
-- Seed default config values
INSERT INTO system_config (key, value, description) VALUES
  ('log_level',              'info',   'Minimum log level: debug | info | warn | error | fatal'),
  ('log_retention_days',     '14',     'How many days to keep logs in DB'),
  ('log_file_retention_days','14',     'How many days to keep log files on disk'),
  ('log_db_enabled',         'true',   'Write logs to PostgreSQL'),
  ('log_file_enabled',       'true',   'Write logs to disk files'),
  ('log_socket_enabled',     'true',   'Stream logs to admin dashboard via socket'),
  ('log_slow_query_ms',      '500',    'Log DB queries slower than this many milliseconds'),
  ('mobile_batch_interval_s','30',     'How often mobile sends batched logs (seconds)'),
  ('api_url',                'http://btdapp.technodevenv.dpdns.org:3000/api', 'Backend API URL'),
  ('admin_url',              'http://btdadmin.technodevenv.dpdns.org',        'Admin dashboard URL')
ON CONFLICT (key) DO NOTHING;
 
-- ── 2. Logs table (partitioned by month) ─────────────────────────────────────
-- Partitioning keeps queries fast as logs grow — each month is its own table
-- Old partitions can be dropped instantly (ALTER TABLE ... DETACH PARTITION)
CREATE TABLE IF NOT EXISTS logs (
  id          BIGSERIAL,
  ts          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  level       VARCHAR(10)  NOT NULL CHECK (level IN ('debug','info','warn','error','fatal')),
  service     VARCHAR(50)  NOT NULL CHECK (service IN ('api','mobile','admin','database','system')),
  category    VARCHAR(50)  NOT NULL DEFAULT 'general',
  -- Categories: http, auth, attendance, enrollment, gps, socket, crash, 
  --             navigation, performance, database, security, system
  message     TEXT         NOT NULL,
  meta        JSONB,       -- structured extra data (request body, stack trace, etc.)
  user_id     VARCHAR(50), -- emp_id if event is tied to an employee
  device_id   VARCHAR(100),-- device_unique_id for mobile events
  session_id  VARCHAR(100),-- browser session for admin frontend events
  ip_address  VARCHAR(45), -- IPv4 or IPv6
  duration_ms INTEGER,     -- for HTTP requests and DB queries
  status_code INTEGER,     -- for HTTP requests
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);
 
-- Create partitions for current and next 3 months
-- (add more months as needed — or automate with pg_cron later)
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
 
-- Indexes for common query patterns (per partition, auto-inherited)
CREATE INDEX IF NOT EXISTS logs_ts_idx       ON logs (ts DESC);
CREATE INDEX IF NOT EXISTS logs_level_idx    ON logs (level, ts DESC);
CREATE INDEX IF NOT EXISTS logs_service_idx  ON logs (service, ts DESC);
CREATE INDEX IF NOT EXISTS logs_category_idx ON logs (category, ts DESC);
CREATE INDEX IF NOT EXISTS logs_user_idx     ON logs (user_id, ts DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS logs_device_idx   ON logs (device_id, ts DESC) WHERE device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS logs_message_idx  ON logs USING GIN (to_tsvector('english', message));
 
-- ── 3. Log sessions (track who viewed logs + audit trail) ────────────────────
CREATE TABLE IF NOT EXISTS log_sessions (
  id         SERIAL PRIMARY KEY,
  opened_at  TIMESTAMPTZ DEFAULT NOW(),
  closed_at  TIMESTAMPTZ,
  opened_by  VARCHAR(100), -- admin user identifier
  ip_address VARCHAR(45),
  filters    JSONB         -- what filters were applied during this session
);
 
-- ── 4. Auto-cleanup function (call via cron or on API startup) ───────────────
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
 
-- ── 5. Helpful views for common queries ──────────────────────────────────────
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
 
COMMENT ON TABLE logs IS 'Central log store for all BTD app services. Partitioned by month. Use cleanup_old_logs() to purge old data.';
COMMENT ON TABLE system_config IS 'Runtime configuration editable from admin UI or psql. App reads this every 60s — no restart needed.';