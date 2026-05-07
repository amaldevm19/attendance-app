// src/middleware/httpLogger.js
// Logs every HTTP request automatically — method, path, status, duration, IP
// Uses morgan under the hood, feeds into our winston logger

import morgan from 'morgan';
import logger from '../logger.js';

// Skip these paths to prevent feedback loops and reduce noise:
// - /api/logs POST: frontend logger sends batches here — logging this creates infinite loop
//   (log the log sender → frontend receives it → queues it → sends again → repeat)
// - /api/logs GET: high-frequency polling from admin log viewer
// - /favicon.ico: browser noise
const SKIP_PATHS = ['/favicon.ico'];
// Skip any request to /api/logs/* to fully break the feedback loop
const SKIP_LOG_ROUTES = true;

const httpLogger = morgan(
  (tokens, req, res) => {
    // Return null to skip — morgan will not call our stream
    if (SKIP_PATHS.some(p => req.path.startsWith(p))) return null;
    if (SKIP_LOG_ROUTES && req.path.startsWith('/api/logs')) return null;
    return JSON.stringify({
      method:      tokens.method(req, res),
      path:        tokens.url(req, res),
      status:      parseInt(tokens.status(req, res)) || 0,
      duration_ms: Math.round(parseFloat(tokens['response-time'](req, res)) || 0),
      ip:          tokens['remote-addr'](req, res),
      user_agent:  tokens['user-agent'](req, res),
    });
  },
  {
    stream: {
      write: (message) => {
        if (!message?.trim()) return;
        try {
          const data = JSON.parse(message.trim());
          const level = data.status >= 500 ? 'error' : data.status >= 400 ? 'warn' : 'info';
          logger[level](
            `${data.method} ${data.path} → ${data.status}`,
            {
              category:    'http',
              ip_address:  data.ip,
              duration_ms: data.duration_ms,
              status_code: data.status,
              meta: {
                method:     data.method,
                path:       data.path,
                user_agent: data.user_agent,
              },
            }
          );
        } catch {
          // Malformed morgan output — ignore
        }
      },
    },
  }
);

export default httpLogger;