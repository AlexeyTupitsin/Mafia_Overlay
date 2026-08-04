// Сквозной сценарий полной игры: подготовка, день, голосование, undo, ночь,
// попил, ЛХ-автотриггер, завершение и архив.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';
import { connect } from './helpers/client.mjs';

let server;
let c;

before(async () => {
  server = await startServer();
  c = await connect(server);
});

after(async () => {
  c.close();
  await server.stop();
  server.cleanup();
});

test('новая игра создаётся в статусе setup', async () => {
  await c.act('NEW_GAME', { title: 'Тестовый турнир', gameNumber: 1, carryPlayers: false });
  assert.equal(c.state.meta.status, 'setup');
  assert.equal(c.state.meta.title, 'Тестовый турнир');
});

test('ники проставляются всем десяти', async () => {
  for (let s = 1; s <= 10; s++) await c.act('SET_PLAYER', { seat: s, nickname: `Игрок${s}` });
  assert.ok(c.state.players.every((p) => p.nickname));
});

test('пересадка меняет игроков местами', async () => {
  await c.act('SWAP_SEATS', { a: 1, b: 2 });
  assert.equal(c.state.players[0].nickname, 'Игрок2');
  assert.equal(c.state.players[1].nickname, 'Игрок1');
  await c.act('SWAP_SEATS', { a: 1, b: 2 });
});

test('старт без ролей отклоняется', async () => {
  await c.act('START_GAME');
  assert.ok(c.lastError, 'ожидалась ошибка валидации');
  assert.equal(c.state.meta.status, 'setup');
});

test('игра стартует с полным раскладом ролей', async () => {
  for (let s = 1; s <= 6; s++) await c.act('SET_ROLE', { seat: s, role: 'civilian' });
  await c.act('SET_ROLE', { seat: 7, role: 'mafia' });
  await c.act('SET_ROLE', { seat: 8, role: 'mafia' });
  await c.act('SET_ROLE', { seat: 9, role: 'don' });
  await c.act('SET_ROLE', { seat: 10, role: 'sheriff' });
  await c.act('START_GAME');
  assert.equal(c.state.meta.status, 'in_progress');
  assert.equal(c.state.phase.kind, 'day');
});

test('спикер и таймер', async () => {
  await c.act('SET_SPEAKER', { seat: 1 });
  assert.equal(c.state.speaker.seat, 1);

  await c.act('TIMER_START', { durationMs: 60000 });
  assert.ok(c.state.speaker.timer.running);
  assert.ok(c.state.speaker.timer.endsAt > Date.now());

  await c.act('TIMER_PAUSE');
  assert.ok(!c.state.speaker.timer.running);
});

test('фолы прибавляются и снимаются', async () => {
  await c.act('ADD_FOUL', { seat: 5 });
  await c.act('ADD_FOUL', { seat: 5 });
  assert.equal(c.state.players[4].fouls, 2);

  await c.act('REMOVE_FOUL', { seat: 5 });
  assert.equal(c.state.players[4].fouls, 1);
});

// Кандидатуру выставляет тот, у кого слово, и только одну — поэтому перед
// каждой номинацией слово передаётся следующему игроку (actions.js: NOMINATE).
test('кандидатуры выставляются и снимаются', async () => {
  await c.act('NOMINATE', { seat: 3 }); // слово у №1
  await c.act('SET_SPEAKER', { seat: 2 });
  await c.act('NOMINATE', { seat: 7 });
  assert.equal(c.state.voting.nominations.length, 2);
  assert.equal(c.state.voting.nominations[1].order, 2);

  await c.act('UNNOMINATE', { seat: 3 });
  assert.equal(c.state.voting.nominations.length, 1);
  assert.equal(c.state.voting.nominations[0].order, 1);

  await c.act('SET_SPEAKER', { seat: 3 });
  await c.act('NOMINATE', { seat: 4 });
  assert.equal(c.state.voting.nominations.length, 2);
});

test('один игрок не может выставить две кандидатуры', async () => {
  await c.act('NOMINATE', { seat: 5 });
  assert.match(c.lastError || '', /уже выставил/);
});

test('голосование выводит игрока из-за стола', async () => {
  await c.act('VOTING_START');
  await c.act('SET_VOTES', { seat: 7, votes: 6 });
  await c.act('SET_VOTES', { seat: 4, votes: 4 });
  await c.act('VOTING_FINISH');

  assert.equal(c.state.players[6].status, 'voted_out');
  assert.equal(c.state.votedOut[0].day, 1);
  assert.ok(c.state.votedOut[0].seats.includes(7));
  assert.equal(c.state.voting.stage, 'done');
  assert.ok(!c.state.voting.active);
});

test('undo возвращает голосование, помечая протокол', async () => {
  await c.act('UNDO');
  assert.equal(c.state.players[6].status, 'alive');
  assert.ok(c.state.voting.active);
  assert.ok(c.state.log.some((e) => e.undone), 'записи не помечены как отменённые');
  assert.equal(c.state.log.at(-1).type, 'UNDO');

  await c.act('VOTING_FINISH');
  assert.equal(c.state.players[6].status, 'voted_out');
});

test('ночь: отстрел и проверки', async () => {
  await c.act('NEXT_PHASE');
  assert.equal(c.state.phase.kind, 'night');
  assert.equal(c.state.phase.round, 1);

  await c.act('SET_SHOT', { seat: 10 });
  assert.equal(c.state.players[9].status, 'killed');
  assert.equal(c.state.nights[0].shot, 10);
  assert.equal(c.state.bestMove.by, null, 'ЛХ не предлагается — днём уже была смерть');

  await c.act('SET_DON_CHECK', { seat: 10, found: true });
  await c.act('SET_SHERIFF_CHECK', { seat: 8, found: true });
  assert.equal(c.state.nights[0].donCheck.seat, 10);
  assert.equal(c.state.nights[0].sheriffCheck.found, true);

  await c.act('SET_BEST_MOVE', { by: 10, picks: [7, 8, 9] });
  assert.equal(c.state.bestMove.picks.length, 3);
});

test('попил: равенство → перестрелка → поднять всех', async () => {
  await c.act('NEXT_PHASE');
  assert.equal(c.state.phase.round, 2);
  assert.equal(c.state.voting.nominations.length, 0);

  await c.act('SET_SPEAKER', { seat: 1 });
  await c.act('NOMINATE', { seat: 8 });
  await c.act('SET_SPEAKER', { seat: 2 });
  await c.act('NOMINATE', { seat: 9 });
  await c.act('VOTING_START');
  await c.act('SET_VOTES', { seat: 8, votes: 4 });
  await c.act('SET_VOTES', { seat: 9, votes: 4 });
  await c.act('VOTING_FINISH');
  assert.equal(c.state.voting.stage, 'revote');
  assert.ok(c.state.voting.nominations.every((n) => n.votes === 0));

  await c.act('SET_VOTES', { seat: 8, votes: 4 });
  await c.act('SET_VOTES', { seat: 9, votes: 4 });
  await c.act('VOTING_FINISH');
  assert.equal(c.state.voting.stage, 'lift_all');

  await c.act('LIFT_ALL', { votes: 6, passed: true });
  assert.equal(c.state.players[7].status, 'voted_out');
  assert.equal(c.state.players[8].status, 'voted_out');
  assert.equal(c.state.votedOut.find((v) => v.day === 2).seats.length, 2);
});

test('ЛХ предлагается при первой смерти в первую ночь', async () => {
  await c.act('NEW_GAME', { title: 'Игра 2', gameNumber: 2, carryPlayers: true });
  assert.equal(c.state.players[0].nickname, 'Игрок1', 'состав не перенесён');
  assert.equal(c.state.meta.status, 'setup');

  for (let s = 1; s <= 6; s++) await c.act('SET_ROLE', { seat: s, role: 'civilian' });
  await c.act('SET_ROLE', { seat: 7, role: 'mafia' });
  await c.act('SET_ROLE', { seat: 8, role: 'mafia' });
  await c.act('SET_ROLE', { seat: 9, role: 'don' });
  await c.act('SET_ROLE', { seat: 10, role: 'sheriff' });
  await c.act('START_GAME');
  await c.act('NEXT_PHASE');

  await c.act('SET_SHOT', { seat: 3 });
  assert.equal(c.state.bestMove.by, 3);

  await c.act('SET_SHOT', { seat: null });
  assert.equal(c.state.players[2].status, 'alive');
  assert.equal(c.state.nights[0].shot, null);
  assert.equal(c.state.bestMove.by, null);

  await c.act('SET_SHOT', { seat: 3 });
});

test('завершение игры пишет архив, протокол и JSON', async () => {
  await c.act('FINISH_GAME', { result: 'mafia_win' });
  assert.equal(c.state.meta.status, 'finished');
  assert.equal(c.state.meta.result, 'mafia_win');

  const games = await (await fetch(`${server.baseUrl}/api/games`)).json();
  assert.ok(games.length >= 2, `в архиве ${games.length} игр, ожидалось ≥ 2`);

  const proto = await fetch(`${server.baseUrl}/api/games/${c.state.gameId}/protocol`);
  assert.ok(proto.ok);
  assert.match(await proto.text(), /Победа мафии/);

  const json = await (await fetch(`${server.baseUrl}/api/games/${c.state.gameId}`)).json();
  assert.equal(json.gameId, c.state.gameId);
  assert.ok(Array.isArray(json.log));
});

test('справочник игроков пополняется через REST', async () => {
  await fetch(`${server.baseUrl}/api/roster`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: 'ШТОРМ', photo: null })
  });
  const roster = await (await fetch(`${server.baseUrl}/api/roster`)).json();
  assert.ok(roster.some((r) => r.nickname === 'ШТОРМ'));
});
