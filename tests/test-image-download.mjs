// Локальное сохранение и скачивание аватаров. Сеть мокается; sharp работает
// по-настоящему на крошечном сгенерированном PNG.
// Каталоги подменяются ДО импорта persistence — иначе тест писал бы в боевой uploads/.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mafia-img-'));
process.env.MAFIA_DATA_DIR = path.join(sandbox, 'data');
process.env.MAFIA_UPLOADS_DIR = path.join(sandbox, 'uploads');

const persistence = await import('../server/persistence.js');
const { saveImageBuffer, downloadAndSaveAvatar } = await import('../server/images.js');

persistence.ensureDirs();

const pngBuf = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } })
  .png().toBuffer();

const onDisk = (url) => path.join(persistence.UPLOADS_DIR, path.basename(url));

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('saveImageBuffer сохраняет PNG как PNG и отдаёт путь /uploads/', async () => {
  const url = await saveImageBuffer(pngBuf);
  assert.match(url, /^\/uploads\/[\w-]+\.png$/);
  assert.ok(fs.existsSync(onDisk(url)), 'файл не создан на диске');
});

test('downloadAndSaveAvatar кладёт скачанный аватар локально', async (t) => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: true, arrayBuffer: async () => pngBuf });
  t.after(() => { global.fetch = orig; });

  const url = await downloadAndSaveAvatar('https://x.supabase.co/avatars/a.png');
  assert.ok(url.startsWith('/uploads/'));
  assert.ok(fs.existsSync(onDisk(url)));
});

test('не-2xx пробрасывается наружу — роут решит, пропускать ли фото', async (t) => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => Buffer.alloc(0) });
  t.after(() => { global.fetch = orig; });

  await assert.rejects(
    () => downloadAndSaveAvatar('https://x.supabase.co/avatars/missing.png'),
    /404/
  );
});
