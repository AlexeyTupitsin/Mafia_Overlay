// Баллы игроков, заметки ведущего и печатный протокол.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';
import { connect, startGame } from './helpers/client.mjs';

let server;
let c;

before(async () => {
  server = await startServer();
  c = await connect(server);
  await startGame(c, { title: 'Баллы', gameNumber: 7 });
});

after(async () => {
  c.close();
  await server.stop();
  server.cleanup();
});

test('баллы до завершения игры отклоняются', async () => {
  await c.act('SET_SCORE', { seat: 1, bonus: 0.5 });
  assert.ok(c.lastError, 'ожидалась ошибка — игра ещё идёт');
});

test('заметка по ходу игры сохраняется и переживает завершение', async () => {
  await c.act('SET_COMMENT', { seat: 1, comment: 'тихий в первом круге' });
  assert.equal(c.lastError, null);
  assert.equal(c.state.players[0].comment, 'тихий в первом круге');

  await c.act('FINISH_GAME', { result: 'mafia_win' });
  assert.equal(c.state.meta.status, 'finished');
  assert.equal(c.state.meta.result, 'mafia_win');
  assert.equal(c.state.players[0].comment, 'тихий в первом круге');
});

test('дробный бонус, комментарий и ручной базовый балл', async () => {
  await c.act('SET_SCORE', { seat: 7, bonus: 0.3 });
  await c.act('SET_SCORE', { seat: 1, comment: 'хорошая логика' });
  await c.act('SET_SCORE', { seat: 1, base: 1, bonus: -0.2 });

  assert.equal(c.state.players[6].scoreBonus, 0.3);
  assert.equal(c.state.players[0].comment, 'хорошая логика');
  assert.equal(c.state.players[0].scoreBase, 1);
  assert.equal(c.state.players[0].scoreBonus, -0.2);
});

test('базовый балл сбрасывается к автоматическому', async () => {
  await c.act('SET_SCORE', { seat: 1, base: null });
  assert.equal(c.state.players[0].scoreBase, null);
});

test('протокол содержит баллы и комментарии, но не полный лог', async () => {
  const res = await fetch(`${server.baseUrl}/api/games/${c.state.gameId}/protocol`);
  assert.ok(res.ok);

  const html = await res.text();
  assert.match(html, /Итоговые баллы/);
  assert.match(html, /хорошая логика/);
  assert.doesNotMatch(html, /Полный лог/);
});
