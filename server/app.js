import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import rsvpRouter from './routes/rsvp.js';
import adminRouter from './routes/admin.js';
import { configureSheets } from './services/googleSheets.js';
import { cleanupOldQRCodes, cleanupInactiveClients } from './services/whatsapp.js';

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
app.use('/api/admin', adminRouter);

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

async function start() {
  try {
    await configureSheets();
    app.listen(port, () => {
      console.log(`Wedding invite server running on http://localhost:${port}`);
    });
    
    // Periodic memory cleanup: clean up old QR codes every 5 minutes
    setInterval(() => {
      cleanupOldQRCodes(10); // Clean QR codes older than 10 minutes
    }, 5 * 60 * 1000); // Every 5 minutes
    
    // Periodic cleanup of inactive clients (every 15 minutes)
    setInterval(async () => {
      await cleanupInactiveClients();
    }, 15 * 60 * 1000); // Every 15 minutes
    
    // Periodic garbage collection hint (if available)
    if (global.gc) {
      setInterval(() => {
        global.gc();
        console.log('[Memory] Manual garbage collection triggered');
      }, 10 * 60 * 1000); // Every 10 minutes
    }
    
    // Log memory usage periodically (helpful for debugging)
    setInterval(() => {
      const used = process.memoryUsage();
      console.log('[Memory] RSS:', Math.round(used.rss / 1024 / 1024), 'MB',
                  '| Heap Used:', Math.round(used.heapUsed / 1024 / 1024), 'MB',
                  '| Heap Total:', Math.round(used.heapTotal / 1024 / 1024), 'MB');
    }, 5 * 60 * 1000); // Every 5 minutes
    
    console.log('Memory cleanup task started (runs every 5 minutes)');
  } catch (error) {
    console.error('Failed to initialize Google Sheets integration:', error);
    process.exit(1);
  }
}

start();
