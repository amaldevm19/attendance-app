import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

dotenv.config();

let pool = null;

if(process.env.NODE_ENV === 'development' ) {
  pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
  });
}else if(process.env.NODE_ENV === 'production' ) {
  pool = new Pool({
    connectionString: process.env.DB_URL,
    ssl: {
      rejectUnauthorized: false, // For Neon, you may need to set this to false
    },
  });
}

// Test connection on startup
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Database connection error:', err.stack);
  } else {
    console.log('✅ Database Connected:', res.rows[0].now);
  }
});

export default pool;
