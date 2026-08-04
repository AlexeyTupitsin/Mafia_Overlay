// Отмена действий. Снапшоты undo хранят прежние объекты состояния без
// клонирования (store.js), поэтому тесты бьют именно по независимости
// снапшотов: разматывание цепочки по шагам и ветки NEW_GAME / FINISH_GAME.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';
import { connect, startGame } from './helpers/client.mjs';

let server;
let c;

before(async () => {
  server = await startServer();
  c = await connect(server);
  await startGame(c, { title: 'Отмена', gameNumber: 1, nicknames: true });
});

after(async () => {
  c.close();
  await server.stop();
  server.cleanup();
});

test('цепочка отмен разматывается по одному шагу', async () => {
  await c.act('ADD_FOUL', { seat: 1 });
  await c.act('ADD_FOUL', { seat: 1 });
  await c.act('ADD_FOUL', { seat: 1 });
  assert.equal(c.state.players[0].fouls, 3);

  // Если бы снапшоты ссылались на один объект, значения поехали бы уже здесь.
  await c.act('UNDO');
  assert.equal(c.state.players[0].fouls, 2);
  await c.act('UNDO');
  assert.equal(c.state.players[0].fouls, 1);
  await c.act('UNDO');
  assert.equal(c.state.players[0].fouls, 0);
});

test('отменённые записи протокола помечаются, а не удаляются', async () => {
  const before = c.state.log.length;
  await c.act('ADD_FOUL', { seat: 2 });
  await c.act('UNDO');

  assert.ok(c.state.log.length > before, 'записи не должны исчезать');
  assert.ok(c.state.log.some((e) => e.undone));
  assert.equal(c.state.log.at(-1).type, 'UNDO');
});

test('соседние снапшоты независимы: правка после отмены не портит историю', async () => {
  await c.act('SET_PLAYER', { seat: 3, nickname: 'ПЕРВЫЙ' });
  await c.act('SET_PLAYER', { seat: 3, nickname: 'ВТОРОЙ' });
  await c.act('UNDO');
  assert.equal(c.state.players[2].nickname, 'ПЕРВЫЙ');

  // новая ветка поверх отменённой — прежний снапшот обязан уцелеть
  await c.act('SET_PLAYER', { seat: 3, nickname: 'ТРЕТИЙ' });
  await c.act('UNDO');
  assert.equal(c.state.players[2].nickname, 'ПЕРВЫЙ');
});

test('UNDO после FINISH_GAME возвращает игру в ход', async () => {
  await c.act('FINISH_GAME', { result: 'city_win' });
  assert.equal(c.state.meta.status, 'finished');
  assert.equal(c.state.meta.result, 'city_win');

  await c.act('UNDO');
  assert.equal(c.state.meta.status, 'in_progress');
  assert.equal(c.state.meta.result, null);
});

test('UNDO после NEW_GAME восстанавливает предыдущую игру', async () => {
  const prevGameId = c.state.gameId;
  await c.act('SET_PLAYER', { seat: 5, nickname: 'МЕТКА' });

  await c.act('NEW_GAME', { title: 'Следующая', gameNumber: 2, carryPlayers: false });
  assert.notEqual(c.state.gameId, prevGameId);
  assert.equal(c.state.meta.status, 'setup');

  await c.act('UNDO');
  assert.equal(c.state.gameId, prevGameId, 'вернулись не в ту игру');
  assert.equal(c.state.meta.status, 'in_progress');
  assert.equal(c.state.players[4].nickname, 'МЕТКА');
});

test('отменять нечего — приходит ошибка, состояние не меняется', async () => {
  // разматываем стек до конца
  for (let i = 0; i < 60; i++) {
    await c.act('UNDO');
    if (c.lastError) break;
  }
  assert.match(c.lastError || '', /Нечего отменять/);
});
