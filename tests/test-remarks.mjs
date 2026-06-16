// Тест правок по замечаниям заказчика (docs/Замечания.txt). Запуск: node test-remarks.mjs
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
  await waitMsg();

  console.log('— Подготовка');
  await act('NEW_GAME', { title: 'Тест замечаний', gameNumber: 1, carryPlayers: false });
  for (let s = 1; s <= 10; s++) await act('SET_PLAYER', { seat: s, nickname: `Игрок${s}` });
  for (let s = 1; s <= 6; s++) await act('SET_ROLE', { seat: s, role: 'civilian' });
  await act('SET_ROLE', { seat: 7, role: 'mafia' });
  await act('SET_ROLE', { seat: 8, role: 'mafia' });
  await act('SET_ROLE', { seat: 9, role: 'don' });
  await act('SET_ROLE', { seat: 10, role: 'sheriff' });
  await act('START_GAME');
  check('игра началась', state.meta.status === 'in_progress');

  console.log('— 4.1: лимит суммы голосов');
  await act('NOMINATE', { seat: 1 });
  await act('NOMINATE', { seat: 2 });
  await act('VOTING_START');
  await act('SET_VOTES', { seat: 1, votes: 6 });
  await act('SET_VOTES', { seat: 2, votes: 5 });
  check('6+5 > 10 отклонено', lastError !== null && state.voting.nominations[1].votes === 0);
  await act('SET_VOTES', { seat: 2, votes: 4 });
  check('6+4 = 10 принято', lastError === null && state.voting.nominations[1].votes === 4);

  console.log('— 4.2: попил 3-3-3-1 → 5-5 → повторное → 5-5 → подъём');
  await act('UNNOMINATE', { seat: 1 }); // вернуться нельзя — голосование идёт; проверим отказ
  check('снятие при активном голосовании отклонено', lastError !== null);
  await act('SET_VOTES', { seat: 1, votes: 4 });
  await act('VOTING_FINISH'); // 4-4 → перестрелка (день 1, 2 кандидатуры)
  check('первая ничья → перестрелка', state.voting.stage === 'revote');
  // имитация 3-3-3-1 невозможна с 2 кандидатурами — проверяем частичную ничью на 4 кандидатурах ниже
  await act('SET_VOTES', { seat: 1, votes: 5 });
  await act('SET_VOTES', { seat: 2, votes: 5 });
  await act('VOTING_FINISH'); // 5-5 при тех же кандидатурах → подъём
  check('повторное равенство тех же → поднять всех', state.voting.stage === 'lift_all');
  await act('LIFT_ALL', { votes: 4, passed: false });
  check('остались за столом', state.players[0].status === 'alive' && state.voting.stage === 'done');

  console.log('— 4.2: частичная ничья → ещё одна перестрелка (не подъём)');
  await act('NEXT_PHASE'); // ночь 1
  await act('SET_SHOT', { seat: null }); // промах
  await act('NEXT_PHASE'); // день 2
  await act('NOMINATE', { seat: 1 });
  await act('NOMINATE', { seat: 2 });
  await act('NOMINATE', { seat: 3 });
  await act('NOMINATE', { seat: 4 });
  await act('VOTING_START');
  await act('SET_VOTES', { seat: 1, votes: 3 });
  await act('SET_VOTES', { seat: 2, votes: 3 });
  await act('SET_VOTES', { seat: 3, votes: 3 });
  await act('SET_VOTES', { seat: 4, votes: 1 });
  await act('VOTING_FINISH'); // 3-3-3-1 → перестрелка трёх
  check('3-3-3-1 → перестрелка трёх', state.voting.stage === 'revote' && state.voting.nominations.length === 3);
  await act('SET_VOTES', { seat: 1, votes: 5 });
  await act('SET_VOTES', { seat: 2, votes: 5 });
  await act('VOTING_FINISH'); // 5-5-0 — лидеров меньше, чем кандидатур → снова перестрелка
  check('5-5-0 → повторная перестрелка, не подъём', state.voting.stage === 'revote' && state.voting.nominations.length === 2);
  await act('SET_VOTES', { seat: 1, votes: 5 });
  await act('SET_VOTES', { seat: 2, votes: 5 });
  await act('VOTING_FINISH'); // 5-5 при тех же → подъём
  check('5-5 при тех же → поднять всех', state.voting.stage === 'lift_all');
  await act('LIFT_ALL', { votes: 4, passed: false });

  console.log('— 5: ночные проверки');
  await act('NEXT_PHASE'); // ночь 2
  await act('SET_SHOT', { seat: 5 });
  check('№5 убит', state.players[4].status === 'killed');
  await act('SET_DON_CHECK', { seat: 5 });
  check('5.3: проверка выбывшего разрешена', lastError === null && state.nights[1].donCheck.seat === 5);
  check('результат вычислен автоматически (мирный — не шериф)', state.nights[1].donCheck.found === false);
  await act('SET_DON_CHECK', { seat: 10 });
  check('дон нашёл шерифа (авто)', state.nights[1].donCheck.found === true);
  await act('SET_SHERIFF_CHECK', { seat: 7 });
  check('шериф нашёл мафию (авто)', state.nights[1].sheriffCheck.found === true);
  await act('SET_SHERIFF_CHECK', { seat: null });
  check('5.2: шериф может никого не проверять', lastError === null && state.nights[1].sheriffCheck === null);

  console.log('— 5.4: выбывший дон/шериф не проверяет');
  await act('SET_STATUS', { seat: 9, status: 'removed' }); // дон удалён
  await act('SET_DON_CHECK', { seat: 1 });
  check('проверка выбывшего дона отклонена', lastError !== null);
  await act('SET_STATUS', { seat: 9, status: 'alive' });
  await act('SET_SHOT', { seat: 10 }); // шериф отстрелян этой ночью
  await act('SET_SHERIFF_CHECK', { seat: 7 });
  check('отстрелянный этой ночью шериф ещё проверяет', lastError === null && state.nights[1].sheriffCheck.seat === 7);

  console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
});

setTimeout(() => { console.log('Таймаут теста'); process.exit(2); }, 30000);
