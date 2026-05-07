-- 1. Roles table (Admin, Team Lead, Supervisor, Technician)
CREATE TABLE roles (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  description TEXT,
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 2. Permissions table (e.g., 'employees:read', 'sites:write')
CREATE TABLE permissions (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 3. Role-Permission mapping (many-to-many)
CREATE TABLE role_permissions (
  role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- 4. Add role_id and password to employees table
ALTER TABLE employees
ADD COLUMN role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL,
ADD COLUMN password VARCHAR(255); -- Will store bcrypt-hashed passwords

-- 5. Insert default roles (Admin, Team Lead, Supervisor, Technician)
INSERT INTO roles (name, description, is_default) VALUES
  ('Admin', 'Superuser with full access', true),
  ('Team Lead', 'Manages teams and portfolios', false),
  ('Supervisor', 'Supervises technicians and jobs', false),
  ('Technician', 'Ground-level employee', false)
ON CONFLICT (name) DO NOTHING;

-- 6. Insert default permissions (for all modules in Sidebar)
INSERT INTO permissions (name, description) VALUES
  -- Dashboard
  ('dashboard:read', 'View dashboard'),

  -- Employees
  ('employees:read', 'View employees list'),
  ('employees:write', 'Add/edit/delete employees'),
  ('employees:attendance:read', 'View employee attendance logs'),
  ('employees:designations:read', 'View designations'),
  ('employees:designations:write', 'Manage designations'),

  -- Sites
  ('sites:read', 'View sites list'),
  ('sites:write', 'Add/edit/delete sites'),
  ('sites:locations:read', 'View locations'),
  ('sites:locations:write', 'Manage locations'),

  -- Jobs
  ('jobs:read', 'View jobs list'),
  ('jobs:write', 'Add/edit/delete jobs'),
  ('jobs:categories:read', 'View job categories'),
  ('jobs:categories:write', 'Manage job categories'),

  -- Clients
  ('clients:read', 'View clients list'),
  ('clients:write', 'Add/edit/delete clients'),
  ('clients:categories:read', 'View client categories'),
  ('clients:categories:write', 'Manage client categories'),

  -- Systems & Portfolios
  ('systems:portfolios:read', 'View portfolios and systems'),
  ('systems:portfolios:write', 'Manage portfolios and systems'),
  ('systems:products:read', 'View products'),
  ('systems:products:write', 'Manage products'),

  -- Devices
  ('devices:read', 'View devices list'),
  ('devices:write', 'Manage devices'),

  -- System Logs
  ('logs:read', 'View system logs')
ON CONFLICT (name) DO NOTHING;

-- 7. Assign all permissions to Admin role (full access)
INSERT INTO role_permissions (role_id, permission_id)
SELECT
  (SELECT id FROM roles WHERE name = 'Admin'),
  id
FROM permissions
ON CONFLICT DO NOTHING;