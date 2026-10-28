// Gera os PNGs do PWA a partir de public/favicon.svg (roda uma vez: node scripts/icons.mjs)
import { chromium } from '@playwright/test';
import { readFileSync } from 'fs';
const svg = readFileSync('public/favicon.svg', 'utf8');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined }); const p = await b.newPage();
for (const [f, n, pad] of [['pwa-192.png', 192, 0], ['pwa-512.png', 512, 0], ['apple-touch-icon.png', 180, 0], ['pwa-maskable-512.png', 512, 0.12]]) {
  await p.setViewportSize({ width: n, height: n });
  await p.setContent(`<body style="margin:0;background:#1a1640;display:grid;place-items:center;width:${n}px;height:${n}px">${svg.replace('<svg ', `<svg width="${n * (1 - 2 * pad)}" height="${n * (1 - 2 * pad)}" `)}</body>`);
  await p.screenshot({ path: 'public/' + f });
}
await b.close();
