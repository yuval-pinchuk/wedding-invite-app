import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import rsvpRouter from './routes/rsvp.js';
import { configureSheets } from './services/googleSheets.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());

// Static landing page assets
const publicDir = path.resolve(__dirname, '../public');
app.use(express.static(publicDir));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/rsvp', rsvpRouter);

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

async function start() {
  try {
    await configureSheets();
    app.listen(port, () => {
      console.log(`Wedding invite server running on http://localhost:${port}`);
    });
  } catch (error) {
    console.error('Failed to initialize Google Sheets integration:', error);
    process.exit(1);
  }
}

start();
