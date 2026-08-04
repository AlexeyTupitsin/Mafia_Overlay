// Защита панели токеном. Ключевое свойство: без auth.token в config.json
// сервер ведёт себя ровно как раньше — защита включается только явно.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';
import { connect, startGame } from './helpers/client.mjs';

const TOKEN = 'секретный-токен-клуба';
const BASE_CONFIG = { port: 0, defaults: {}, tracker: { enabled: false } };

describe('без токена в конфиге', () => {
  let server;

  before(async () => {
    server = await startServer({ config: BASE_CONFIG });
  });

  after(async () => {
    await server.stop({ waitForSave: false });
    server.cleanup();
  });

  test('панель и API открыты', async () => {
    assert.ok((await fetch(`${server.baseUrl}/control/`)).ok);
    assert.ok((await fetch(`${server.baseUrl}/api/roster`)).ok);
  });

  test('панель подключается по WebSocket', async () => {
    const c = await connect(server, 'control');
    assert.ok(c.state, 'состояние не пришло');
    c.close();
  });
});

describe('с токеном в конфиге', () => {
  let server;

  before(async () => {
    server = await startServer({ config: { ...BASE_CONFIG, auth: { token: TOKEN } } });
  });

  after(async () => {
    await server.stop({ waitForSave: false });
    server.cleanup();
  });

  test('панель без токена отдаёт 401', async () => {
    const res = await fetch(`${server.baseUrl}/control/`);
    assert.equal(res.status, 401);
  });

  test('неверный токен отдаёт 401', async () => {
    const res = await fetch(`${server.baseUrl}/control/?token=не-тот`);
    assert.equal(res.status, 401);
  });

  test('API без токена отдаёт 401', async () => {
    const res = await fetch(`${server.baseUrl}/api/roster`);
    assert.equal(res.status, 401);
  });

  test('оверлей и статика остаются открытыми — OBS не логинится', async () => {
    assert.ok((await fetch(`${server.baseUrl}/overlay/`)).ok);
    assert.ok((await fetch(`${server.baseUrl}/shared/constants.js`)).ok);
  });

  test('верный токен ставит куку и уводит с токеном из адреса', async () => {
    const res = await fetch(`${server.baseUrl}/control/?token=${encodeURIComponent(TOKEN)}`, {
      redirect: 'manual'
    });
    assert.equal(res.status, 302);

    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /mafia_auth=/);
    assert.match(cookie, /HttpOnly/i, 'кука должна быть недоступна из JS страницы');
    assert.doesNotMatch(res.headers.get('location') || '', /token=/, 'токен остался в адресе');
  });

  test('с кукой панель и API открываются', async () => {
    const headers = { Cookie: `mafia_auth=${encodeURIComponent(TOKEN)}` };
    assert.ok((await fetch(`${server.baseUrl}/control/`, { headers })).ok);
    assert.ok((await fetch(`${server.baseUrl}/api/roster`, { headers })).ok);
  });

  test('WebSocket панели без токена не поднимается', async () => {
    await assert.rejects(() => connect(server, 'control'), /401|Unexpected server response/);
  });

  test('WebSocket панели с токеном работает', async () => {
    const c = await connect(server, 'control', TOKEN);
    assert.ok(c.state);
    c.close();
  });

  test('WebSocket оверлея пускается без токена', async () => {
    const c = await connect(server, 'overlay');
    assert.ok(c.state);
    c.close();
  });
});

describe('оверлей не может играть', () => {
  let server;
  let control;

  before(async () => {
    server = await startServer({ config: BASE_CONFIG });
    control = await connect(server, 'control');
    await startGame(control, { title: 'Read-only', gameNumber: 1 });
  });

  after(async () => {
    control.close();
    await server.stop({ waitForSave: false });
    server.cleanup();
  });

  test('действия от соединения с role=overlay игнорируются', async () => {
    const overlay = await connect(server, 'overlay');
    const revBefore = control.rev;

    overlay.fire('ADD_FOUL', { seat: 1 });
    overlay.fire('FINISH_GAME', { result: 'mafia_win' });
    await new Promise((r) => setTimeout(r, 300));

    // Ни одно действие не применилось: rev не вырос, состояние прежнее.
    assert.equal(control.rev, revBefore, 'сервер применил действие от оверлея');
    assert.equal(control.state.players[0].fouls, 0);
    assert.equal(control.state.meta.status, 'in_progress');

    overlay.close();
  });
});
