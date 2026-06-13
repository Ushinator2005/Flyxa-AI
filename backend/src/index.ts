import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

import { errorHandler } from './middleware/errorHandler';
import tradesRouter from './routes/trades';
import aiRouter from './routes/ai';
import analyticsRouter from './routes/analytics';
import riskRouter from './routes/risk';
import psychologyRouter from './routes/psychology';
import playbookRouter from './routes/playbook';
import journalRouter from './routes/journal';
import marketDataRouter from './routes/marketData';
import billingRouter from './routes/billing';
import rivalsRouter from './routes/rivals';
import accountRouter from './routes/account';

dotenv.config({ override: true });

const app = express();
const PORT = process.env.PORT || 3001;
const isLocalDev = process.env.NODE_ENV !== 'production';

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isAllowedDevOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
    return isPrivateIpv4(hostname);
  } catch {
    return false;
  }
}

// Security middleware
app.use(helmet());

// CORS
const defaultAllowedOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const configuredAllowedOrigins = (process.env.FRONTEND_URL ?? '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const allowedOrigins = new Set([...defaultAllowedOrigins, ...configuredAllowedOrigins]);

app.use(cors({
  origin: (origin, callback) => {
    // No Origin header: allow in dev (curl/tooling), block in production.
    // Browser requests always include Origin, so this only affects non-browser callers.
    if (!origin) {
      if (isLocalDev) {
        callback(null, true);
      } else {
        callback(new Error('CORS: Origin header required'));
      }
      return;
    }

    if (allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }

    if (isLocalDev && isAllowedDevOrigin(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
}));

// Rate limiting
const localhostHosts = new Set(['localhost', '127.0.0.1', '::1']);
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isLocalDev ? 5000 : 200,
  message: { error: 'Too many requests, please try again later.' },
  skip: (req) => {
    if (!isLocalDev) return false;
    const rawHost = (req.hostname || '').toLowerCase();
    const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
    if (localhostHosts.has(host)) return true;
    const ip = (req.ip || '').replace('::ffff:', '').toLowerCase();
    return localhostHosts.has(ip);
  },
});
app.use(limiter);

// Body parser — 2mb for JSON. Image uploads use multipart/form-data (handled by
// multer in the AI route) so they are not affected by this limit.
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/trades', tradesRouter);
app.use('/api/ai', aiRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/risk', riskRouter);
app.use('/api/psychology', psychologyRouter);
app.use('/api/playbook', playbookRouter);
app.use('/api/journal', journalRouter);
app.use('/api/market-data', marketDataRouter);
app.use('/api/billing', billingRouter);
app.use('/api/rivals', rivalsRouter);
app.use('/api/account', accountRouter);

// Error handler
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Flyxa AI backend running on port ${PORT}`);
});

export default app;
