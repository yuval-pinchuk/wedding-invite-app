import './config/loadEnv.js';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

import rsvpRouter from './routes/rsvp.js';
import adminRouter from './routes/admin.js';
import adminPayRouter from './routes/adminPay.js';
import payRouter from './routes/pay.js';
import authRouter from './routes/auth.js';
import publicWeddingRouter from './routes/publicWedding.js';
import { configureSheets } from './services/googleSheets.js';
import { startSessionMaintenance } from './services/whatsapp.js';
import { accountFromRequest } from './services/sessions.js';
import { migrate } from './db/migrate.js';
import { allowedOrigins, securityHeaders } from './middleware/security.js';

const app = express();
app.disable('x-powered-by');
const port = process.env.PORT || 8080;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../public');

app.set('trust proxy', 1);
app.use(securityHeaders);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins().has(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true,
}));
// Signup sends the invite image as a base64 data URL (~4/3 of file size).
app.use(express.json({ limit: '8mb' }));

async function requireLoginPage(req, res, nextFile) {
  const account = await accountFromRequest(req);
  if (!account) return res.redirect('/login');
  return res.sendFile(path.join(publicDir, nextFile));
}

app.get('/login', (_req, res) => {
  res.sendFile(path.join(publicDir, 'login.html'));
});

app.get('/manage', (req, res) => requireLoginPage(req, res, 'dashboard.html'));
app.get('/manage/invites', (req, res) => requireLoginPage(req, res, 'admin.html'));
app.get('/manage/pay', (req, res) => requireLoginPage(req, res, 'admin-pay.html'));
app.get('/manage/settings', (req, res) => requireLoginPage(req, res, 'settings.html'));

app.get(['/admin.html', '/admin'], (_req, res) => {
  res.redirect('/manage/invites');
});

app.get(['/admin-pay.html', '/admin-pay'], (_req, res) => {
  res.redirect('/manage/pay');
});

app.get('/i/:token', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use('/api/auth', authRouter);
app.use('/api/public', publicWeddingRouter);

app.use(express.static(publicDir));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/rsvp', rsvpRouter);
app.use('/api/pay', payRouter);
app.use('/api/admin/pay', adminPayRouter);
app.use('/api/admin', adminRouter);

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

async function start() {
  try {
    await migrate();
    await configureSheets();
    app.listen(port, () => {
      console.log(`easyWed running on http://localhost:${port}`);
      startSessionMaintenance();
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
