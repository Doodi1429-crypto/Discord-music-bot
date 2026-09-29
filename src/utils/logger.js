const levels = { error: 0, warn: 1, info: 2, debug: 3 };
const configured = levels[process.env.LOG_LEVEL] ?? levels.info;

function write(level, message, meta) {
  if (levels[level] > configured) return;
  const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
  console[level === 'error' ? 'error' : 'log'](`[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}${suffix}`);
}

export const logger = {
  error: (message, meta) => write('error', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  info: (message, meta) => write('info', message, meta),
  debug: (message, meta) => write('debug', message, meta)
};
