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
import { ensureLegacyAccount } from './services/accounts.js';
import { accountFromRequest } from './services/sessions.js';

const app = express();
const port = process.env.PORT || 8080;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../public');

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '4mb' }));

app.get('/login', (_req, res) => {
  res.sendFile(path.join(publicDir, 'login.html'));
});

app.get('/manage', (req, res) => {
  if (!accountFromRequest(req)) return res.redirect('/login');
  return res.sendFile(path.join(publicDir, 'dashboard.html'));
});

app.get('/manage/invites', (req, res) => {
  if (!accountFromRequest(req)) return res.redirect('/login');
  return res.sendFile(path.join(publicDir, 'admin.html'));
});

app.get('/manage/pay', (req, res) => {
  if (!accountFromRequest(req)) return res.redirect('/login');
  return res.sendFile(path.join(publicDir, 'admin-pay.html'));
});

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
    await configureSheets();
    await ensureLegacyAccount();
    app.listen(port, () => {
      console.log(`easyWed running on http://localhost:${port}`);
      startSessionMaintenance();
    });
  } catch (error) {
    console.error('Failed to initialize Google Sheets integration:', error);
    process.exit(1);
  }
}

start();
