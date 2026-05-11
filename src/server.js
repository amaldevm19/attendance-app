import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pool from './config/db.js';
import { Server } from 'socket.io';
import http from 'http';

// Import logger first — all other modules can use it
import logger, { setSocketEmitter } from './logger.js';
import httpLogger from './middleware/httpLogger.js';
import errorHandler from './middleware/errorHandler.js';
import { startCorrectionCron } from './utils/correctionCron.js';


// Import Routes
import employeeRoutes    from './routes/employeeRoutes.js';
import siteRoutes        from './routes/siteRoutes.js';
import attendanceRoutes  from './routes/attendanceRoutes.js';
import deviceRoutes      from './routes/deviceRoutes.js';
import locationRoutes    from './routes/locationRoutes.js';
import referenceRoutes   from './routes/referenceRoutes.js';
import jobRoutes         from './routes/jobRoutes.js';
import clientRoutes      from './routes/clientRoutes.js';
import designationRoutes from './routes/designationRoutes.js';
import logRoutes         from './routes/logRoutes.js';
import authRoutes            from './routes/authRoutes.js';
import authMiddleware        from './middleware/authMiddleware.js';
import permissionMiddleware  from './middleware/permissionMiddleware.js';
import roleRoutes from './routes/roleRoutes.js';
import clearanceRoutes from './routes/clearanceRoutes.js';
import seedRoutes      from './routes/seedRoutes.js';
import assessmentRoutes  from './routes/assessmentRoutes.js';
import qaRoutes          from './routes/qaRoutes.js';
import { startAssessmentCron } from './utils/assessmentCron.js';
import systemSettingsRoutes from './routes/systemSettingsRoutes.js';

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket'],
});

// ── Middleware ────────────────────────────────────────────────────────────────

const allowedOrigins = [
  'https://btdapp.technodevenv.dpdns.org',
  'https://btdadmin.technodevenv.dpdns.org',
  'https://attendance-admin-tan.vercel.app', // Add your final Vercel domain
  'https://attendance-admin-j0e0s816l-amaldev-mahadevans-projects.vercel.app',
  
];

app.use(cors({
  origin: function (origin, callback) {
    // 1. MOBILE APPS & SERVER-TO-SERVER:
    // Mobile apps usually have an undefined origin. 
    // This line allows them to bypass the check.
    if (!origin) return callback(null, true);

    // 2. WEB BROWSERS:
    // Check if the website URL is in our trusted list.
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static('uploads'));
app.use(httpLogger); // Auto-log all HTTP requests



// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/employees',    employeeRoutes);
app.use('/api/sites',        siteRoutes);
app.use('/api/attendance',   attendanceRoutes);
app.use('/api/devices',      deviceRoutes);
app.use('/api/locations',    locationRoutes);
app.use('/api/ref',          referenceRoutes);
app.use('/api/jobs',         jobRoutes);
app.use('/api/clients',      clientRoutes);
app.use('/api/designations', designationRoutes);
app.use('/api/logs',         logRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/clearance', clearanceRoutes);
app.use('/api/seed',      seedRoutes);
app.use('/api/assessment', assessmentRoutes);
app.use('/api/qa',         qaRoutes);
app.use('/api/system/settings', systemSettingsRoutes);

// ── Global error handler (must be LAST) ──────────────────────────────────────
app.use(errorHandler);

// ── Socket.io ─────────────────────────────────────────────────────────────────
const connectedDevices = new Map(); // device_unique_id → socket.id

// Give logger access to socket so it can stream to admin log room
setSocketEmitter((event, data) => io.to('log-room').emit(event, data));

io.on('connection', (socket) => {

  // ── Device registration ──────────────────────────────────────────────────
  socket.on('register-device', async (deviceUID) => {
    connectedDevices.set(deviceUID, socket.id);
    socket.join(`emp-${deviceUID}`);
    try {
      await pool.query(
        'UPDATE devices SET is_online = TRUE, last_seen_at = NOW() WHERE device_unique_id = $1',
        [deviceUID]
      );
      logger.info(`Device connected: ${deviceUID}`, {
        category: 'socket',
        device_id: deviceUID,
        meta: { socket_id: socket.id, ip: socket.handshake.address },
      });
    } catch (err) {
      logger.error(`Failed to mark device online: ${err.message}`, { category: 'database', device_id: deviceUID });
    }
    io.emit('dashboard-update');
  });

  // ── Device disconnect ────────────────────────────────────────────────────
  socket.on('disconnect', async () => {
    for (const [uid, id] of connectedDevices.entries()) {
      if (id === socket.id) {
        connectedDevices.delete(uid);
        try {
          await pool.query(
            'UPDATE devices SET is_online = FALSE WHERE device_unique_id = $1',
            [uid]
          );
          logger.info(`Device disconnected: ${uid}`, {
            category: 'socket',
            device_id: uid,
            meta: { socket_id: socket.id },
          });
        } catch (err) {
          logger.error(`Failed to mark device offline: ${err.message}`, { category: 'database', device_id: uid });
        }
        io.emit('dashboard-update');
        break;
      }
    }
  });

  // ── Admin log room — live tail ────────────────────────────────────────────
  socket.on('join-log-room', () => {
    socket.join('log-room');
    logger.info('Admin joined log room (live tail active)', {
      category: 'system',
      meta: { socket_id: socket.id, ip: socket.handshake.address },
    });
  });

  socket.on('leave-log-room', () => {
    socket.leave('log-room');
    logger.info('Admin left log room', {
      category: 'system',
      meta: { socket_id: socket.id },
    });
  });

});

// ── Startup log ───────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  logger.info(`BTD API server started on port ${PORT}`, {
    category: 'system',
    meta: {
      port: PORT,
      env:  process.env.NODE_ENV || 'development',
      node: process.version,
    },
  });
});

// ── Scheduled cleanup — run once on startup + every 24h ─────────────────────
const runLogCleanup = async () => {
  try {
    const result = await pool.query('SELECT cleanup_old_logs()');
    const deleted = result.rows[0]?.cleanup_old_logs;
    if (deleted > 0) {
      logger.info(`Log cleanup: removed ${deleted} old entries`, { category: 'system' });
    }
  } catch (err) {
    logger.warn(`Log cleanup failed: ${err.message}`, { category: 'system' });
  }
};
runLogCleanup();
startCorrectionCron();
startAssessmentCron();
setInterval(runLogCleanup, 24 * 60 * 60 * 1000);

export { io, connectedDevices };