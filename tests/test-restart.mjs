// Восстановление состояния после перезапуска сервера, отдача страниц и
// загрузка фото с ресайзом. Тест сам гасит и поднимает сервер на той же
// песочнице данных.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startServer } from './helpers/server.mjs';
import { connect, startGame } from './helpers/client.mjs';

let server;
let gameId;

before(async () => {
  server = await startServer();
  const c = await connect(server);
  await startGame(c, { title: 'Рестарт', gameNumber: 1, nicknames: true });
  await c.act('SET_SPEAKER', { seat: 1 });
  await c.act('ADD_FOUL', { seat: 2 });
  await c.act('NEXT_PHASE');
  await c.act('SET_SHOT', { seat: 4 });
  await c.act('FINISH_GAME', { result: 'city_win' });
  gameId = c.state.gameId;
  c.close();

  // Гасим и поднимаем заново на том же каталоге данных.
  await server.stop();
  server = await startServer({ dataDir: server.dataDir });
});

after(async () => {
  await server.stop();
  server.cleanup();
});

test('состояние восстановлено из autosave', async () => {
  const c = await connect(server);
  assert.equal(c.state.gameId, gameId);
  assert.equal(c.state.meta.status, 'finished');
  assert.ok(c.state.log.length > 10, `в логе ${c.state.log.length} записей`);
  c.close();
});

test('страницы панели и оверлея отдаются', async () => {
  const control = await fetch(`${server.baseUrl}/control/`);
  assert.ok(control.ok);

  const overlay = await fetch(`${server.baseUrl}/overlay/`);
  assert.ok(overlay.ok);
});

test('у оверлея прозрачный фон — иначе перекроет видео в OBS', async () => {
  const css = await (await fetch(`${server.baseUrl}/overlay/overlay.css`)).text();
  assert.match(css, /body\s*{[^}]*background:\s*transparent/s);
});

test('загруженное фото ужимается до 600 px по большей стороне', async () => {
  const png = await sharp({
    create: { width: 1200, height: 800, channels: 4, background: { r: 200, g: 60, b: 60, alpha: 1 } }
  }).png().toBuffer();

  const fd = new FormData();
  fd.append('photo', new Blob([png], { type: 'image/png' }), 'test.png');
  const up = await fetch(`${server.baseUrl}/api/upload`, { method: 'POST', body: fd });
  const { url } = await up.json();
  assert.ok(up.ok);
  assert.ok(url.startsWith('/uploads/'), `неожиданный путь: ${url}`);

  const img = await fetch(`${server.baseUrl}${url}`);
  assert.ok(img.ok);
  const meta = await sharp(Buffer.from(await img.arrayBuffer())).metadata();
  assert.equal(meta.width, 600);
  assert.equal(meta.height, 400);
});
