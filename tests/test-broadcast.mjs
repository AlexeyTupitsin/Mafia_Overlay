// Состав WS-рассылки: оверлею уходит урезанное состояние, панели — полное,
// а подключение/отключение источника OBS шлёт только счётчики клиентов.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';
import { connect, startGame } from './helpers/client.mjs';

let server;
let control;

before(async () => {
  server = await startServer();
  control = await connect(server, 'control');
  await startGame(control, { title: 'Рассылка', gameNumber: 1, nicknames: true });
  await control.act('ADD_FOUL', { seat: 1 });
  await control.act('ADD_FOUL', { seat: 2 });
});

after(async () => {
  control.close();
  await server.stop();
  server.cleanup();
});

test('панель получает протокол и глубину отмены', () => {
  assert.ok(control.state.log.length > 0, 'протокол пуст');
  assert.equal(typeof control.lastMessage.undoDepth, 'number');
});

test('оверлей получает состояние без протокола и без undoDepth', async () => {
  const overlay = await connect(server, 'overlay');
  try {
    assert.deepEqual(overlay.state.log, [], 'протокол оверлею не нужен');
    assert.equal(overlay.lastMessage.undoDepth, undefined);

    // игровые данные при этом на месте
    assert.equal(overlay.state.players.length, 10);
    assert.equal(overlay.state.meta.status, 'in_progress');
    assert.equal(overlay.state.players[0].fouls, 1);
  } finally {
    overlay.close();
  }
});

test('оверлей продолжает получать обновления после действия', async () => {
  const overlay = await connect(server, 'overlay');
  try {
    await control.act('ADD_FOUL', { seat: 3 });
    await overlay.nextState();
    assert.equal(overlay.state.players[2].fouls, 1);
    assert.deepEqual(overlay.state.log, [], 'протокол не должен просачиваться');
  } finally {
    overlay.close();
  }
});

// Heartbeat отстреливает клиентов, не ответивших на ping. Обрыв без TCP FIN
// (потеря Wi-Fi у планшета) в тесте не воспроизвести, поэтому проверяем
// обратное и куда более частое: живого клиента ping-цикл не трогает.
test('живой клиент переживает несколько циклов heartbeat', async () => {
  const fast = await startServer({ heartbeatMs: 150 });
  try {
    const c = await connect(fast, 'overlay');
    const panel = await connect(fast, 'control');
    await new Promise((r) => setTimeout(r, 700)); // ~4 цикла

    // если бы сокет отстрелили, состояние до оверлея не дошло бы
    await panel.act('NEW_GAME', { title: 'Живой', gameNumber: 1, carryPlayers: false });
    await c.nextState();
    assert.equal(c.state.meta.title, 'Живой', 'оверлей отвалился за время ping-цикла');
    assert.equal(c.lastMessage.clients.overlay, 1, 'оверлей пропал из счётчика');

    c.close();
    panel.close();
  } finally {
    await fast.stop({ waitForSave: false });
    fast.cleanup();
  }
});

test('подключение и отключение оверлея меняют счётчик у панели', async () => {
  const overlay = await connect(server, 'overlay');
  const onConnect = await control.clientsUntil((c) => c.overlay === 1);
  assert.equal(onConnect.control, 1, 'панель должна считаться одна');

  overlay.close();
  await control.clientsUntil((c) => c.overlay === 0);
});
