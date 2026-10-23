import express from 'express';
import fs from 'fs';
import { findByPublicToken, inviteImagePath, publicAccount } from '../services/accounts.js';
import { buildExampleResponsesWorkbook, buildExampleWorkbook } from '../services/exampleSheet.js';

const router = express.Router();

async function accountFromToken(token) {
  if (!token) return null;
  return await findByPublicToken(token);
}

router.get('/wedding', async (req, res) => {
  const account = await accountFromToken(String(req.query.token || '').trim());
  if (!account) return res.status(404).json({ success: false, error: 'החתונה לא נמצאה' });
  const view = publicAccount(account);
  const imageFile = inviteImagePath(account);
  res.json({
    success: true,
    brideName: view.brideName,
    groomName: view.groomName,
    weddingDate: view.weddingDate,
    wazeUrl: view.wazeUrl,
    mapsUrl: view.mapsUrl,
    babyMaxAge: view.babyMaxAge,
    imageUrl: imageFile && fs.existsSync(imageFile) ? `/api/public/invite-image/${account.publicToken}` : '/WEDDING.png',
    token: account.publicToken,
  });
});

router.get('/invite-image/:token', async (req, res) => {
  const account = await findByPublicToken(req.params.token);
  const file = inviteImagePath(account);
  if (!file || !fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

router.get('/example.xlsx', (_req, res) => {
  const body = buildExampleWorkbook();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="guest-sheet-example.xlsx"');
  res.send(body);
});

router.get('/example-responses.xlsx', (_req, res) => {
  const body = buildExampleResponsesWorkbook();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="response-sheet-example.xlsx"');
  res.send(body);
});

export default router;
