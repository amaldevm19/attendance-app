-- ============================================================
-- BTD Attendance App — Full Schema Migration
-- Run this after the initial schema.sql
-- ============================================================

-- EMIRATES (seeded, static 7)
CREATE TABLE emirates (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO emirates (name) VALUES
  ('Abu Dhabi'),
  ('Dubai'),
  ('Sharjah'),
  ('Ajman'),
  ('Umm Al Quwain'),
  ('Ras Al Khaimah'),
  ('Fujairah');

-- LOCATIONS
CREATE TABLE locations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  emirate_id INTEGER REFERENCES emirates(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- JOB CATEGORIES
CREATE TABLE job_categories (
  id SERIAL PRIMARY KEY,
  code VARCHAR(20) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- CLIENT CATEGORIES
CREATE TABLE client_categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- CLIENTS
CREATE TABLE clients (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  client_category_id INTEGER REFERENCES client_categories(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- CLIENT REPRESENTATIVES
CREATE TABLE client_representatives (
  id SERIAL PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  designation VARCHAR(100),
  email VARCHAR(150),
  phone VARCHAR(30),
  created_at TIMESTAMP DEFAULT NOW()
);

-- PORTFOLIOS
CREATE TABLE portfolios (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- SYSTEMS (each belongs to ONE portfolio)
CREATE TABLE systems (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  portfolio_id INTEGER REFERENCES portfolios(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- PRODUCTS (manufacturer + brand + model, under a system)
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  system_id INTEGER REFERENCES systems(id) ON DELETE SET NULL,
  manufacturer VARCHAR(100) NOT NULL,
  brand VARCHAR(100),
  model VARCHAR(100) NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- JOBS
CREATE TABLE jobs (
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

-- JOB ↔ PORTFOLIOS (many-to-many)
CREATE TABLE job_portfolios (
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  portfolio_id INTEGER REFERENCES portfolios(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, portfolio_id)
);

-- JOB ↔ SYSTEMS (admin picks specific systems from job's portfolios)
CREATE TABLE job_systems (
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  system_id INTEGER REFERENCES systems(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, system_id)
);

-- SITES — add new columns
ALTER TABLE sites ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS supervisor_id VARCHAR(50) REFERENCES employees(emp_id) ON DELETE SET NULL;

-- SITE ↔ JOBS (one site can have multiple jobs)
CREATE TABLE site_jobs (
  id SERIAL PRIMARY KEY,
  site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  is_primary BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(site_id, job_id)
);

-- SITE ASSETS (future use — products installed at site)
CREATE TABLE site_assets (
  id SERIAL PRIMARY KEY,
  site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  quantity INTEGER DEFAULT 1,
  serial_number VARCHAR(100),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Job ↔ Products (many-to-many)
CREATE TABLE IF NOT EXISTS job_products (
  job_id     INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, product_id)
);


-- BTD App Migration v4 — Pending Enrollments table
 
CREATE TABLE IF NOT EXISTS pending_enrollments (
  id          SERIAL PRIMARY KEY,
  employee_id VARCHAR(50) REFERENCES employees(emp_id) ON DELETE CASCADE,
  device_id   INTEGER     REFERENCES devices(id)       ON DELETE CASCADE,
  created_at  TIMESTAMP DEFAULT NOW(),
  UNIQUE(employee_id, device_id)
);

-- migration_v6.sql
-- Replaces single target_device_id GPS assignment with multi-device junction table
-- Run AFTER migration_v5.sql
 
-- 1. New junction table — same pattern as pending_enrollments
CREATE TABLE IF NOT EXISTS pending_site_enrollments (
  site_id   INTEGER NOT NULL REFERENCES sites(id)   ON DELETE CASCADE,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (site_id, device_id)
);
