export function fixedWindowLimiter({ limit, windowMs, maxEntries = 10000, now = Date.now }) {
  const entries = new Map();
  return (request, response, next) => {
    const time = now();
    if (entries.size >= maxEntries) for (const [key, entry] of entries) if (entry.reset <= time) entries.delete(key);
    const key = request.ip;
    let entry = entries.get(key);
    if (!entry || entry.reset <= time) {
      if (!entry && entries.size >= maxEntries) return response.status(429).json({ error: '服务繁忙，请稍后重试' });
      entry = { count: 0, reset: time + windowMs }; entries.set(key, entry);
    }
    entry.count++;
    if (entry.count > limit) {
      response.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.reset - time) / 1000))));
      return response.status(429).json({ error: '请求过于频繁，请稍后重试' });
    }
    next();
  };
}

export function configureHttpSecurity(app) {
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    next();
  });
  app.use('/api/admin/login', fixedWindowLimiter({ limit: 12, windowMs: 15 * 60000 }));
  app.use('/api/client/login', fixedWindowLimiter({ limit: 60, windowMs: 60000 }));
  app.use('/api', fixedWindowLimiter({ limit: 1200, windowMs: 60000 }));
}
