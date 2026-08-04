// Правки по замечаниям заказчика (docs/Замечания.txt): лимит суммы голосов,
// логика попила и ночные проверки.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';
import { connect, startGame } from './helpers/client.mjs';

let server;
let c;

// Кандидатуру выставляет тот, у кого слово, и только одну — отсюда передача
// слова перед каждой номинацией (actions.js: NOMINATE).
async function nominate(seats, speakers) {
  for (let i = 0; i < seats.length; i++) {
    await c.act('SET_SPEAKER', { seat: speakers[i] });
    await c.act('NOMINATE', { seat: seats[i] });
  }
}

before(async () => {
  server = await startServer();
  c = await connect(server);
  await startGame(c, { title: 'Тест замечаний', gameNumber: 1, nicknames: true });
});

after(async () => {
  c.close();
  await server.stop();
  server.cleanup();
});

test('4.1: сумма голосов больше числа живых отклоняется', async () => {
  await nominate([1, 2], [3, 4]);
  await c.act('VOTING_START');

  await c.act('SET_VOTES', { seat: 1, votes: 6 });
  await c.act('SET_VOTES', { seat: 2, votes: 5 });
  assert.ok(c.lastError, '6+5 > 10 должно быть отклонено');
  assert.equal(c.state.voting.nominations[1].votes, 0);

  await c.act('SET_VOTES', { seat: 2, votes: 4 });
  assert.equal(c.lastError, null);
  assert.equal(c.state.voting.nominations[1].votes, 4);
});

test('снятие кандидатуры при идущем голосовании отклоняется', async () => {
  await c.act('UNNOMINATE', { seat: 1 });
  assert.ok(c.lastError);
});

test('4.2: равенство → перестрелка → повторное равенство → подъём', async () => {
  await c.act('SET_VOTES', { seat: 1, votes: 4 });
  await c.act('VOTING_FINISH');
  assert.equal(c.state.voting.stage, 'revote');

  await c.act('SET_VOTES', { seat: 1, votes: 5 });
  await c.act('SET_VOTES', { seat: 2, votes: 5 });
  await c.act('VOTING_FINISH');
  assert.equal(c.state.voting.stage, 'lift_all');

  await c.act('LIFT_ALL', { votes: 4, passed: false });
  assert.equal(c.state.players[0].status, 'alive');
  assert.equal(c.state.voting.stage, 'done');
});

test('4.2: частичная ничья даёт ещё одну перестрелку, а не подъём', async () => {
  await c.act('NEXT_PHASE');            // ночь 1
  await c.act('SET_SHOT', { seat: null }); // промах
  await c.act('NEXT_PHASE');            // день 2

  await nominate([1, 2, 3, 4], [5, 6, 7, 8]);
  await c.act('VOTING_START');
  await c.act('SET_VOTES', { seat: 1, votes: 3 });
  await c.act('SET_VOTES', { seat: 2, votes: 3 });
  await c.act('SET_VOTES', { seat: 3, votes: 3 });
  await c.act('SET_VOTES', { seat: 4, votes: 1 });
  await c.act('VOTING_FINISH');
  assert.equal(c.state.voting.stage, 'revote');
  assert.equal(c.state.voting.nominations.length, 3, '3-3-3-1 → перестрелка троих');

  // лидеров меньше, чем кандидатур → снова перестрелка, подъёма быть не должно
  await c.act('SET_VOTES', { seat: 1, votes: 5 });
  await c.act('SET_VOTES', { seat: 2, votes: 5 });
  await c.act('VOTING_FINISH');
  assert.equal(c.state.voting.stage, 'revote');
  assert.equal(c.state.voting.nominations.length, 2);

  // те же двое и снова поровну → подъём
  await c.act('SET_VOTES', { seat: 1, votes: 5 });
  await c.act('SET_VOTES', { seat: 2, votes: 5 });
  await c.act('VOTING_FINISH');
  assert.equal(c.state.voting.stage, 'lift_all');

  await c.act('LIFT_ALL', { votes: 4, passed: false });
});

test('5.3: проверка выбывшего разрешена, результат считается автоматически', async () => {
  await c.act('NEXT_PHASE'); // ночь 2
  await c.act('SET_SHOT', { seat: 5 });
  assert.equal(c.state.players[4].status, 'killed');

  await c.act('SET_DON_CHECK', { seat: 5 });
  assert.equal(c.lastError, null);
  assert.equal(c.state.nights[1].donCheck.seat, 5);
  assert.equal(c.state.nights[1].donCheck.found, false, 'мирный — не шериф');

  await c.act('SET_DON_CHECK', { seat: 10 });
  assert.equal(c.state.nights[1].donCheck.found, true, 'дон нашёл шерифа');

  await c.act('SET_SHERIFF_CHECK', { seat: 7 });
  assert.equal(c.state.nights[1].sheriffCheck.found, true, 'шериф нашёл мафию');
});

test('5.2: шериф может никого не проверять', async () => {
  await c.act('SET_SHERIFF_CHECK', { seat: null });
  assert.equal(c.lastError, null);
  assert.equal(c.state.nights[1].sheriffCheck, null);
});

test('5.4: выбывший дон не проверяет, отстрелянный этой ночью шериф — ещё да', async () => {
  await c.act('SET_STATUS', { seat: 9, status: 'removed' });
  await c.act('SET_DON_CHECK', { seat: 1 });
  assert.ok(c.lastError, 'проверка удалённого дона должна быть отклонена');

  await c.act('SET_STATUS', { seat: 9, status: 'alive' });
  await c.act('SET_SHOT', { seat: 10 }); // шериф отстрелян этой же ночью
  await c.act('SET_SHERIFF_CHECK', { seat: 7 });
  assert.equal(c.lastError, null);
  assert.equal(c.state.nights[1].sheriffCheck.seat, 7);
});
