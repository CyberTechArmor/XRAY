import rateLimit from 'express-rate-limit';

const ipKey = (req: any) => req.ip || req.socket.remoteAddress || 'no-ip';

// Passkey auth: 60 requests per 15 minutes per IP
export const passkeyRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: ipKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: { code: 'RATE_LIMITED', message: 'Too many passkey requests, please try again later' } },
});

// General auth (login, signup, verify, etc.): 2000 requests per 15 minutes per IP
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  keyGenerator: ipKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' } },
});

// API endpoints: 200 requests per 15 minutes per IP
export const apiRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  keyGenerator: ipKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' } },
});

// Magic link / code requests: 30 per hour per email
export const magicLinkRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.body?.email || req.ip || req.socket.remoteAddress || 'no-ip',
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: { code: 'RATE_LIMITED', message: 'Too many code requests. Please try again later.' } },
});
