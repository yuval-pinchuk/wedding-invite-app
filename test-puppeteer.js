// Quick test to verify Puppeteer/Chromium is working
import { Client } from 'whatsapp-web.js';

console.log('Testing Puppeteer/Chromium installation...');

const testClient = new Client({
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

testClient.on('qr', (qr) => {
  console.log('✅ QR code generated successfully!');
  console.log('Puppeteer/Chromium is working correctly.');
  process.exit(0);
});

testClient.on('ready', () => {
  console.log('✅ Client ready!');
  process.exit(0);
});

testClient.on('auth_failure', (msg) => {
  console.error('❌ Auth failure:', msg);
  process.exit(1);
});

console.log('Initializing test client...');
testClient.initialize().catch((err) => {
  console.error('❌ Failed to initialize:', err.message);
  console.error('Full error:', err);
  process.exit(1);
});

// Timeout after 30 seconds
setTimeout(() => {
  console.error('❌ Timeout: No QR code generated after 30 seconds');
  console.error('This usually means Puppeteer/Chromium is not installed or not working.');
  process.exit(1);
}, 30000);

