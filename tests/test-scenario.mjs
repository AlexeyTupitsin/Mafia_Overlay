// Сквозной тест полного сценария игры (самопроверка из ТЗ). Запуск: node test-scenario.mjs
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3000/ws?role=control');
let state = null;
let lastError = null;
let failures = 0;

const waitMsg = () => new Promise((resolve) => ws.once('message', (d) => {
  const msg = JSON.parse(d.toString());
  if (msg.type === 'state') state = msg.state;
  if (msg.type === 'error') lastError = msg.message;
  resolve(msg);
}));

async function act(type, payload) {
  lastError = null;
  ws.send(JSON.stringify({ type: 'action', action: { type, payload } }));
  let msg;
  do { msg = await waitMsg(); } while (msg.type !== 'state' && msg.type !== 'error');
  return msg;
}

function check(name, cond) {
  if (cond) console.log(`  ok: ${name}`);
  else { failures++; console.log(`  FAIL: ${name}${lastError ? ` (server: ${lastError})` : ''}`); }
}

ws.on('open', async () => {
  await waitMsg(); // начальное состояние

  console.log('— Подготовка');
  await act('NEW_GAME', { title: 'Тестовый турнир', gameNumber: 1, carryPlayers: false });
  check('новая игра в setup', state.meta.status === 'setup' && state.meta.title === 'Тестовый турнир');

  for (let s = 1; s <= 10; s++) await act('SET_PLAYER', { seat: s, nickname: `Игрок${s}` });
  check('10 ников', state.players.every((p) => p.nickname));

  await act('SWAP_SEATS', { a: 1, b: 2 });
  check('пересадка 1⇄2', state.players[0].nickname === 'Игрок2' && state.players[1].nickname === 'Игрок1');
  await act('SWAP_SEATS', { a: 1, b: 2 });

  // роли: 1-6 мирные, 7-8 мафия, 9 дон, 10 шериф
  await act('START_GAME');
  check('старт без ролей отклонён', lastError !== null && state.meta.status === 'setup');

  for (let s = 1; s <= 6; s++) await act('SET_ROLE', { seat: s, role: 'civilian' });
  await act('SET_ROLE', { seat: 7, role: 'mafia' });
  await act('SET_ROLE', { seat: 8, role: 'mafia' });
  await act('SET_ROLE', { seat: 9, role: 'don' });
  await act('SET_ROLE', { seat: 10, role: 'sheriff' });
  await act('START_GAME');
  check('игра началась', state.meta.status === 'in_progress' && state.phase.kind === 'day');

  console.log('— День 1');
  await act('SET_SPEAKER', { seat: 1 });
  check('спикер №1', state.speaker.seat === 1);
  await act('TIMER_START', { durationMs: 60000 });
  check('таймер идёт', state.speaker.timer.running && state.speaker.timer.endsAt > Date.now());
  await act('TIMER_PAUSE');
  check('таймер на паузе', !state.speaker.timer.running);

  await act('ADD_FOUL', { seat: 5 });
  await act('ADD_FOUL', { seat: 5 });
  check('2 фола у №5', state.players[4].fouls === 2);
  await act('REMOVE_FOUL', { seat: 5 });
  check('фол снят', state.players[4].fouls === 1);

  await act('NOMINATE', { seat: 3 });
  await act('NOMINATE', { seat: 7 });
  check('2 кандидатуры', state.voting.nominations.length === 2 && state.voting.nominations[1].order === 2);
  await act('UNNOMINATE', { seat: 3 });
  check('снятие кандидатуры', state.voting.nominations.length === 1 && state.voting.nominations[0].order === 1);
  await act('NOMINATE', { seat: 4 });

  await act('VOTING_START');
  await act('SET_VOTES', { seat: 7, votes: 6 });
  await act('SET_VOTES', { seat: 4, votes: 4 });
  await act('VOTING_FINISH');
  check('№7 заголосован', state.players[6].status === 'voted_out'
    && state.votedOut[0].day === 1 && state.votedOut[0].seats.includes(7));
  check('стадия done', state.voting.stage === 'done' && !state.voting.active);

  console.log('— Undo');
  await act('UNDO');
  check('undo вернул голосование', state.players[6].status === 'alive' && state.voting.active);
  check('лог помечен, не удалён', state.log.some((e) => e.undone) && state.log.at(-1).type === 'UNDO');
  await act('VOTING_FINISH');
  check('повторный итог: №7 ушёл', state.players[6].status === 'voted_out');

  console.log('— Ночь 1');
  await act('NEXT_PHASE');
  check('фаза ночь 1', state.phase.kind === 'night' && state.phase.round === 1);
  await act('SET_SHOT', { seat: 10 });
  check('№10 убит', state.players[9].status === 'killed' && state.nights[0].shot === 10);
  check('ЛХ не предложен (была смерть днём)', state.bestMove.by === null);
  await act('SET_DON_CHECK', { seat: 10, found: true });
  await act('SET_SHERIFF_CHECK', { seat: 8, found: true });
  check('проверки записаны', state.nights[0].donCheck.seat === 10 && state.nights[0].sheriffCheck.found === true);

  await act('SET_BEST_MOVE', { by: 10, picks: [7, 8, 9] });
  check('ЛХ записан', state.bestMove.picks.length === 3);

  console.log('— День 2: попил');
  await act('NEXT_PHASE');
  check('день 2, голосование сброшено', state.phase.round === 2 && state.voting.nominations.length === 0);
  await act('NOMINATE', { seat: 8 });
  await act('NOMINATE', { seat: 9 });
  await act('VOTING_START');
  await act('SET_VOTES', { seat: 8, votes: 4 });
  await act('SET_VOTES', { seat: 9, votes: 4 });
  await act('VOTING_FINISH');
  check('равенство → перестрелка', state.voting.stage === 'revote'
    && state.voting.nominations.every((n) => n.votes === 0));
  await act('SET_VOTES', { seat: 8, votes: 4 });
  await act('SET_VOTES', { seat: 9, votes: 4 });
  await act('VOTING_FINISH');
  check('снова равенство → поднять всех', state.voting.stage === 'lift_all');
  await act('LIFT_ALL', { votes: 6, passed: true });
  check('подняли обоих', state.players[7].status === 'voted_out' && state.players[8].status === 'voted_out'
    && state.votedOut.find((v) => v.day === 2).seats.length === 2);

  console.log('— ЛХ-автотриггер (чистая игра)');
  await act('NEW_GAME', { title: 'Игра 2', gameNumber: 2, carryPlayers: true });
  check('перенос состава', state.players[0].nickname === 'Игрок1' && state.meta.status === 'setup');
  for (let s = 1; s <= 6; s++) await act('SET_ROLE', { seat: s, role: 'civilian' });
  await act('SET_ROLE', { seat: 7, role: 'mafia' });
  await act('SET_ROLE', { seat: 8, role: 'mafia' });
  await act('SET_ROLE', { seat: 9, role: 'don' });
  await act('SET_ROLE', { seat: 10, role: 'sheriff' });
  await act('START_GAME');
  await act('NEXT_PHASE'); // ночь 1
  await act('SET_SHOT', { seat: 3 });
  check('ЛХ предложен игроку №3', state.bestMove.by === 3);
  await act('SET_SHOT', { seat: null });
  check('промах: №3 жив, ЛХ снят', state.players[2].status === 'alive'
    && state.nights[0].shot === null && state.bestMove.by === null);
  await act('SET_SHOT', { seat: 3 });

  console.log('— Завершение и архив');
  await act('FINISH_GAME', { result: 'mafia_win' });
  check('игра завершена', state.meta.status === 'finished' && state.meta.result === 'mafia_win');

  const games = await (await fetch('http://localhost:3000/api/games')).json();
  check('в архиве ≥ 2 игр', games.length >= 2);
  const proto = await fetch(`http://localhost:3000/api/games/${state.gameId}/protocol`);
  const protoHtml = await proto.text();
  check('протокол отдаётся', proto.ok && protoHtml.includes('Победа мафии'));
  const json = await (await fetch(`http://localhost:3000/api/games/${state.gameId}`)).json();
  check('JSON-экспорт', json.gameId === state.gameId && Array.isArray(json.log));

  // справочник
  await fetch('http://localhost:3000/api/roster', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: 'ШТОРМ', photo: null })
  });
  const roster = await (await fetch('http://localhost:3000/api/roster')).json();
  check('справочник игроков', roster.some((r) => r.nickname === 'ШТОРМ'));

  console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
});

setTimeout(() => { console.log('Таймаут теста'); process.exit(2); }, 30000);
