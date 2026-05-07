-- sudo -u postgres psql -d attendance_db
-- Employees Table
CREATE TABLE employees (
    id SERIAL PRIMARY KEY,
    emp_id VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    designation VARCHAR(50),
    face_descriptor JSONB, -- Storing the face mathematical vector
    enrollment_status VARCHAR(20) DEFAULT 'none',
    target_enrollment_device_id INTEGER REFERENCES devices(id),
    profile_image VARCHAR(255),
    phone           VARCHAR(30),
    email           VARCHAR(150),
    reports_to      VARCHAR(50) REFERENCES employees(emp_id) ON DELETE SET NULL,
    designation_id  INTEGER REFERENCES designations(id) ON DELETE SET NULL
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS designations (
  id    SERIAL PRIMARY KEY,
  name  VARCHAR(100) NOT NULL UNIQUE,
  level INTEGER NOT NULL DEFAULT 3,
  -- 1 = Top (Team Lead), 2 = Mid (Supervisor/Engineer), 3 = Ground (Technician)
  created_at TIMESTAMP DEFAULT NOW()
);

-- 3. Employee ↔ Portfolios (for Team Leads)
CREATE TABLE IF NOT EXISTS employee_portfolios (
  emp_id       VARCHAR(50) REFERENCES employees(emp_id) ON DELETE CASCADE,
  portfolio_id INTEGER     REFERENCES portfolios(id)    ON DELETE CASCADE,
  PRIMARY KEY (emp_id, portfolio_id)
);

-- Sites Table
CREATE TABLE sites (
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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- migration_v5.sql
-- Adds gps_captured_by_device_id to sites table
-- Tracks which device physically captured the GPS coordinates

-- Backfill: for already-completed sites, point to target_device_id if available
-- (best-effort — target_device_id is cleared on completion so this may be NULL for old records)
-- No data loss — just informational

-- Attendance Logs Table
CREATE TABLE attendance_logs (
    id SERIAL PRIMARY KEY,
    employee_id VARCHAR(50) REFERENCES employees(emp_id),
    action_type VARCHAR(10), -- 'IN' or 'OUT'
    log_time TIMESTAMP NOT NULL,
    latitude DECIMAL(10, 8),
    longitude DECIMAL(11, 8),
    site_id INTEGER REFERENCES sites(id),
    is_synced BOOLEAN DEFAULT TRUE
);

-- Track registered mobile devices
CREATE TABLE devices (
    id SERIAL PRIMARY KEY,
    device_unique_id VARCHAR(255) UNIQUE NOT NULL,
    device_name VARCHAR(100),
    is_active BOOLEAN DEFAULT TRUE,
    friendly_name VARCHAR(100),
    is_online BOOLEAN DEFAULT FALSE,
    last_seen_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Link Many Employees to Many Devices
CREATE TABLE employee_devices (
    employee_id VARCHAR(50) REFERENCES employees(emp_id),
    device_id INTEGER REFERENCES devices(id),
    PRIMARY KEY (employee_id, device_id)
);

-- 4. Migrate existing designation text → designation_id
UPDATE employees e
SET designation_id = d.id
FROM designations d
WHERE LOWER(TRIM(e.designation)) = LOWER(TRIM(d.name))
AND e.designation_id IS NULL;
 

-- 5. Add supervisor/team_lead columns to jobs if not already done
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS supervisor_id VARCHAR(50) REFERENCES employees(emp_id) ON DELETE SET NULL;