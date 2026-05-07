-- =============================================================================
-- MIGRATION v12 — Primary Device Flag
-- Adds is_primary BOOLEAN to employee_devices.
-- Rules:
--   • Each employee can have at most ONE primary device (their own phone).
--   • Each device can be primary for at most ONE employee (the device owner).
--   • A shared phone can only be owned by one employee. Other employees
--     who use it for tasks will have a different device as their primary,
--     or no primary device (admin sets theirs manually).
--   • is_primary is cleared automatically when the assignment is removed.
-- =============================================================================

BEGIN;

-- ── 1. Add column ─────────────────────────────────────────────────────────────
ALTER TABLE employee_devices
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;

-- ── 2. Partial unique indexes — enforce both constraints ─────────────────────
-- One primary device per employee (each employee has one home device)
DROP INDEX IF EXISTS uq_employee_primary_device;
CREATE UNIQUE INDEX uq_employee_primary_device
  ON employee_devices (employee_id)
  WHERE is_primary = TRUE;

-- One primary employee per device (each device has one owner)
-- Before creating the index, resolve any duplicate primaries left from
-- the previous back-fill by keeping only the earliest (lowest employee_id) row.
DROP INDEX IF EXISTS uq_device_primary_employee;

-- Deduplicate: for any device with multiple is_primary=TRUE rows,
-- keep the first employee (alphabetically by emp_id), clear the rest.
UPDATE employee_devices ed
SET is_primary = FALSE
WHERE is_primary = TRUE
  AND (employee_id, device_id) NOT IN (
    SELECT MIN(employee_id), device_id
    FROM employee_devices
    WHERE is_primary = TRUE
    GROUP BY device_id
    HAVING COUNT(*) > 1
  )
  AND device_id IN (
    SELECT device_id FROM employee_devices
    WHERE is_primary = TRUE
    GROUP BY device_id
    HAVING COUNT(*) > 1
  );

CREATE UNIQUE INDEX uq_device_primary_employee
  ON employee_devices (device_id)
  WHERE is_primary = TRUE;

-- ── 3. Helper function — sets a device as primary for an employee,
--       atomically clearing any existing primary for that employee first.
-- Usage: SELECT set_primary_device('EMP001', 42);
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_primary_device(p_employee_id VARCHAR, p_device_id INTEGER)
RETURNS VOID AS $$
BEGIN
  -- Clear existing primary for this employee (one primary device per employee)
  UPDATE employee_devices
  SET is_primary = FALSE
  WHERE employee_id = p_employee_id AND is_primary = TRUE;

  -- Clear existing primary for this device (one primary employee per device)
  UPDATE employee_devices
  SET is_primary = FALSE
  WHERE device_id = p_device_id AND is_primary = TRUE;

  -- Set new primary (row must already exist in employee_devices)
  UPDATE employee_devices
  SET is_primary = TRUE
  WHERE employee_id = p_employee_id AND device_id = p_device_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Device % is not assigned to employee %', p_device_id, p_employee_id;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ── 4. Clear any incorrectly set primaries from previous migration attempts ──
-- Primary is set ONLY when an employee enters their ID in the mobile app (ActivationPage).
-- Do NOT auto-assign primary based on device count — a shared phone is not
-- automatically "owned" by any employee.
UPDATE employee_devices SET is_primary = FALSE WHERE is_primary = TRUE;
-- Primaries will be correctly set when employees next open and use the mobile app.

COMMIT;

-- =============================================================================
-- VERIFICATION
-- =============================================================================
-- SELECT employee_id, device_id, is_primary FROM employee_devices ORDER BY employee_id;
-- -- Each employee should have at most one row with is_primary = TRUE.
-- SELECT employee_id, COUNT(*) FROM employee_devices WHERE is_primary = TRUE
--   GROUP BY employee_id HAVING COUNT(*) > 1;
-- -- Should return zero rows.
-- =============================================================================