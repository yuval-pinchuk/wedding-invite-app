const base = String(process.env.KEEPALIVE_URL || '').replace(/\/$/, '');
if (!base) {
  console.error('KEEPALIVE_URL missing');
  process.exit(1);
}

const response = await fetch(`${base}/health`);
const body = await response.text();
console.log(response.status, body);
if (!response.ok) process.exit(1);
