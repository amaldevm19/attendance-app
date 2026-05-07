-- migration_v8_fix.sql
-- Run this AFTER migration_v8.sql
-- Adds role_id + password columns safety check and seeds Admin employee

-- Safety: only add columns if not already present
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='employees' AND column_name='role_id') THEN
    ALTER TABLE employees ADD COLUMN role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='employees' AND column_name='password') THEN
    ALTER TABLE employees ADD COLUMN password VARCHAR(255);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='employees' AND column_name='email') THEN
    ALTER TABLE employees ADD COLUMN email VARCHAR(255);
  END IF;
END $$;

-- Assign Admin role to any existing employee with 'Admin' designation (if any)
UPDATE employees
SET role_id = (SELECT id FROM roles WHERE name = 'Admin')
WHERE LOWER(designation) = 'admin' AND role_id IS NULL;

-- Assign matching roles to existing employees by designation name
UPDATE employees e
SET role_id = r.id
FROM roles r
WHERE LOWER(e.designation) = LOWER(r.name)
  AND e.role_id IS NULL;

/*

-- Insert Admin employee
INSERT INTO employees (emp_id, name, email, role_id)
VALUES (
  'EMP001',
  'Amaldev',
  'amaldev.m@scientechnic.ae',
  (SELECT id FROM roles WHERE name = 'Admin')
)
ON CONFLICT (emp_id) DO UPDATE
  SET name    = 'Amaldev',
      email   = 'amaldev.m@scientechnic.ae',
      role_id = (SELECT id FROM roles WHERE name = 'Admin');
 
-- Verify
SELECT emp_id, name, email,
       (SELECT name FROM roles WHERE id = employees.role_id) AS role
FROM employees WHERE emp_id = 'EMP001';

*/