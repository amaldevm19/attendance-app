/**
 * setAdminPassword.js
 * Usage: node setAdminPassword.js <emp_id> <password>
 * Example: node setAdminPassword.js EMP001 amal@1234
 */

import bcrypt from 'bcryptjs';
import pool from './src/config/db.js';  // reuse the same db config as the API

const [,, empId, password] = process.argv;

if (!empId || !password) {
  console.error('Usage: node setAdminPassword.js <emp_id> <password>');
  process.exit(1);
}
if (password.length < 6) {
  console.error('Password must be at least 6 characters.');
  process.exit(1);
}

const hashed = await bcrypt.hash(password, 10);
const result = await pool.query(
  'UPDATE employees SET password = $1 WHERE emp_id = $2 RETURNING emp_id, name, email',
  [hashed, empId]
);

if (result.rows.length === 0) {
  console.error(`No employee found with emp_id: ${empId}`);
  process.exit(1);
}

console.log(`✅ Password set for: ${result.rows[0].name} (${result.rows[0].emp_id})`);
console.log(`   Email: ${result.rows[0].email}`);
await pool.end();