import express from 'express';
import pool from '../config/db.js';

const router = express.Router();

// POST: Sync multiple logs from mobile
router.post('/sync', async (req, res) => {
    const logs = req.body; // Expecting an array [{}, {}]
    
    if (!Array.isArray(logs)) {
        return res.status(400).json({ error: "Input must be an array of logs" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN'); // Start Transaction
        
        for (const log of logs) {
            const query = `
                INSERT INTO attendance_logs (employee_id, action_type, log_time, latitude, longitude)
                VALUES ($1, $2, $3, $4, $5)
            `;
            const values = [log.emp_id, log.action_type, log.log_time, log.latitude, log.longitude];
            await client.query(query, values);
        }

        await client.query('COMMIT');
        res.status(201).json({ success: true, message: `${logs.length} logs synced successfully` });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: "Sync failed", details: err.message });
    } finally {
        client.release();
    }
});

export default router;