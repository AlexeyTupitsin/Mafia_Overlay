// Юнит-тест локального сохранения и скачивания аватаров.
// Сеть мокается; sharp работает по-настоящему на крошечном сгенерированном PNG.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import * as persistence from '../server/persistence.js';
import { saveImageBuffer, downloadAndSaveAvatar } from '../server/images.js';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass += 1; console.log('  ok:', name); }
  else { fail += 1; console.log('  FAIL:', name); }
}

persistence.ensureDirs();
const created = [];
function abs(url) { return path.join(persistence.UPLOADS_DIR, path.basename(url)); }

// крошечный реальный PNG-буфер
const pngBuf = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } })
  .png().toBuffer();

// saveImageBuffer: png остаётся png, путь /uploads/, файл существует
{
  const url = await saveImageBuffer(pngBuf);
  created.push(url);
  check('saveImageBuffer возвращает /uploads/*.png', /^\/uploads\/[\w-]+\.png$/.test(url));
  check('saveImageBuffer создаёт файл на диске', fs.existsSync(abs(url)));
}

const origFetch = global.fetch;

// downloadAndSaveAvatar: успешная загрузка → локальный путь + файл
global.fetch = async () => ({ ok: true, arrayBuffer: async () => pngBuf });
try {
  const url = await downloadAndSaveAvatar('https://x.supabase.co/avatars/a.png');
  created.push(url);
  check('downloadAndSaveAvatar возвращает локальный путь', url.startsWith('/uploads/'));
  check('downloadAndSaveAvatar создаёт файл', fs.existsSync(abs(url)));
} finally {
  global.fetch = origFetch;
}

// downloadAndSaveAvatar: не-2xx → исключение (роут поймает и пропустит фото)
global.fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => Buffer.alloc(0) });
try {
  await downloadAndSaveAvatar('https://x.supabase.co/avatars/missing.png');
  check('ошибка скачивания пробрасывается', false);
} catch {
  check('ошибка скачивания пробрасывается', true);
} finally {
  global.fetch = origFetch;
}

// уборка за собой
for (const url of created) { try { fs.unlinkSync(abs(url)); } catch { /* ignore */ } }

console.log(`\nПРОВАЛОВ: ${fail} из ${pass + fail}`);
process.exit(fail ? 1 : 0);
