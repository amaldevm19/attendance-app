-- ============================================================
-- BTD Attendance App — Consolidated Schema
-- ============================================================

-- 1. Infrastructure & Supporting Tables
CREATE TABLE IF NOT EXISTS roles (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  description TEXT,
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS permissions (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS system_config (
  key         VARCHAR(100) PRIMARY KEY,
  value       TEXT         NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ  DEFAULT NOW(),
  updated_by  VARCHAR(100) DEFAULT 'system'
);

-- 2. Device Management
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

-- 3. Employee Management
CREATE TABLE IF NOT EXISTS designations (
  id    SERIAL PRIMARY KEY,
  name  VARCHAR(100) NOT NULL UNIQUE,
  level INTEGER NOT NULL DEFAULT 3,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS employees (
    id SERIAL PRIMARY KEY,
    emp_id VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    designation VARCHAR(50), -- Legacy text field
    designation_id INTEGER REFERENCES designations(id) ON DELETE SET NULL,
    role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL,
    password VARCHAR(255),
    face_descriptor JSONB,
    enrollment_status VARCHAR(20) DEFAULT 'none',
    target_enrollment_device_id INTEGER REFERENCES devices(id),
    profile_image VARCHAR(255),
    phone VARCHAR(30),
    email VARCHAR(150),
    reports_to VARCHAR(50) REFERENCES employees(emp_id) ON DELETE SET NULL,
    -- Expanded location/comm fields from Migration V10
    home_latitude DOUBLE PRECISION,
    home_longitude DOUBLE PRECISION,
    home_radius INTEGER DEFAULT 100,
    whatsapp_number VARCHAR(20),
    whatsapp_api_key VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS employee_devices (
    employee_id VARCHAR(50) REFERENCES employees(emp_id),
    device_id INTEGER REFERENCES devices(id),
    PRIMARY KEY (employee_id, device_id)
);

-- 4. Location & Client Hierarchy
CREATE TABLE IF NOT EXISTS emirates (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS locations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  emirate_id INTEGER REFERENCES emirates(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

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

-- 5. Clients & Portfolios
CREATE TABLE IF NOT EXISTS client_categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  client_category_id INTEGER REFERENCES client_categories(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS client_representatives (
  id SERIAL PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  designation VARCHAR(100),
  email VARCHAR(150),
  phone VARCHAR(30),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS portfolios (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS employee_portfolios (
  emp_id       VARCHAR(50) REFERENCES employees(emp_id) ON DELETE CASCADE,
  portfolio_id INTEGER     REFERENCES portfolios(id)    ON DELETE CASCADE,
  PRIMARY KEY (emp_id, portfolio_id)
);

CREATE TABLE IF NOT EXISTS systems (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  portfolio_id INTEGER REFERENCES portfolios(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  system_id INTEGER REFERENCES systems(id) ON DELETE SET NULL,
  manufacturer VARCHAR(100) NOT NULL,
  brand VARCHAR(100),
  model VARCHAR(100) NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 6. Jobs
CREATE TABLE IF NOT EXISTS job_categories (
  id SERIAL PRIMARY KEY,
  code VARCHAR(20) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

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

-- 7. Attendance & Sessions
CREATE TABLE IF NOT EXISTS attendance_logs (
    id SERIAL PRIMARY KEY,
    employee_id VARCHAR(50) REFERENCES employees(emp_id),
    job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
    site_id INTEGER REFERENCES sites(id),
    action_type VARCHAR(20), -- 'SITE_IN', 'SITE_OUT', etc.
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

-- 8. Requests & Approvals
CREATE TABLE IF NOT EXISTS correction_requests (
  id SERIAL PRIMARY KEY,
  employee_id VARCHAR(50) NOT NULL REFERENCES employees(emp_id) ON DELETE CASCADE,
  site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  punched_in_at TIMESTAMP,
  proposed_out_time TIMESTAMP NOT NULL,
  reason TEXT NOT NULL,
  sub_type VARCHAR(50),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  reviewed_by VARCHAR(50) REFERENCES employees(emp_id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP,
  tl_comment TEXT,
  score_flag BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id SERIAL PRIMARY KEY,
  employee_id VARCHAR(50) NOT NULL REFERENCES employees(emp_id) ON DELETE CASCADE,
  attendance_log_id INTEGER REFERENCES attendance_logs(id) ON DELETE SET NULL,
  correction_id INTEGER REFERENCES correction_requests(id) ON DELETE SET NULL,
  request_type VARCHAR(30) NOT NULL,
  sub_type VARCHAR(50),
  reason TEXT,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  reviewed_by VARCHAR(50) REFERENCES employees(emp_id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP,
  tl_comment TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 9. Junction Tables
CREATE TABLE IF NOT EXISTS job_portfolios (
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  portfolio_id INTEGER REFERENCES portfolios(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, portfolio_id)
);

CREATE TABLE IF NOT EXISTS job_systems (
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  system_id INTEGER REFERENCES systems(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, system_id)
);

CREATE TABLE IF NOT EXISTS job_products (
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, product_id)
);

CREATE TABLE IF NOT EXISTS site_jobs (
  id SERIAL PRIMARY KEY,
  site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  is_primary BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(site_id, job_id)
);

CREATE TABLE IF NOT EXISTS pending_enrollments (
  id SERIAL PRIMARY KEY,
  employee_id VARCHAR(50) REFERENCES employees(emp_id) ON DELETE CASCADE,
  device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(employee_id, device_id)
);

CREATE TABLE IF NOT EXISTS pending_site_enrollments (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (site_id, device_id)
);

-- 10. Partitioned Logging
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

-- 11. Indexes
CREATE INDEX IF NOT EXISTS idx_correction_requests_emp ON correction_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_emp ON approval_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_attendance_logs_job ON attendance_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_active_sessions_emp ON active_sessions(employee_id);

-- 12. Seed Static Data
INSERT INTO emirates (name) VALUES 
('Abu Dhabi'), ('Dubai'), ('Sharjah'), ('Ajman'), ('Umm Al Quwain'), ('Ras Al Khaimah'), ('Fujairah')
ON CONFLICT (name) DO NOTHING;

INSERT INTO roles (name, description, is_default) VALUES
('Admin', 'Superuser', true), ('Team Lead', 'Manager', false), ('Supervisor', 'Foreman', false), ('Technician', 'Ground Staff', false)
ON CONFLICT (name) DO NOTHING;