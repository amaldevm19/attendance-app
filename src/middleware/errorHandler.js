// src/middleware/errorHandler.js
// Global Express error handler — catches any error thrown in route handlers
// Must be registered LAST in server.js (after all routes)

import logger from '../logger.js';

const errorHandler = (err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  logger.error(`${req.method} ${req.path} — ${message}`, {
    category:    'crash',
    ip_address:  req.ip,
    status_code: status,
    meta: {
      method:  req.method,
      path:    req.path,
      stack:   err.stack,
      body:    req.body,
    },
  });

  // Never expose stack traces to clients in production
  res.status(status).json({
    error:   message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

export default errorHandler;