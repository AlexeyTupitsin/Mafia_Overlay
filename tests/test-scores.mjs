// Проверка баллов и протокола. Запуск при работающем сервере: node test-scores.mjs
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

  await act('NEW_GAME', { title: 'Баллы', gameNumber: 7, carryPlayers: false });
  for (let s = 1; s <= 6; s++) await act('SET_ROLE', { seat: s, role: 'civilian' });
  await act('SET_ROLE', { seat: 7, role: 'mafia' });
  await act('SET_ROLE', { seat: 8, role: 'mafia' });
  await act('SET_ROLE', { seat: 9, role: 'don' });
  await act('SET_ROLE', { seat: 10, role: 'sheriff' });
  await act('START_GAME');

  await act('SET_SCORE', { seat: 1, bonus: 0.5 });
  check('баллы до finish отклонены', lastError !== null);

  // заметка по ходу игры пишет то же поле comment и доступна до завершения
  await act('SET_COMMENT', { seat: 1, comment: 'тихий в первом круге' });
  check('заметка по ходу игры сохранена', lastError === null && state.players[0].comment === 'тихий в первом круге');

  await act('FINISH_GAME', { result: 'mafia_win' });
  check('заметка видна в сетке подсчёта после finish', state.players[0].comment === 'тихий в первом круге');

  check('игра завершена', state.meta.status === 'finished' && state.meta.result === 'mafia_win');

  await act('SET_SCORE', { seat: 7, bonus: 0.3 });
  await act('SET_SCORE', { seat: 1, comment: 'хорошая логика' });
  await act('SET_SCORE', { seat: 1, base: 1, bonus: -0.2 });
  check('бонус дробный сохранён', state.players[6].scoreBonus === 0.3);
  check('комментарий сохранён', state.players[0].comment === 'хорошая логика');
  check('ручной базовый сохранён', state.players[0].scoreBase === 1 && state.players[0].scoreBonus === -0.2);

  await act('SET_SCORE', { seat: 1, base: null });
  check('сброс базового к авто', state.players[0].scoreBase === null);

  const proto = await fetch(`http://localhost:3000/api/games/${state.gameId}/protocol`);
  const html = await proto.text();
  check('протокол отдаётся', proto.ok);
  check('есть секция «Итоговые баллы»', html.includes('Итоговые баллы'));
  check('нет секции «Полный лог»', !html.includes('Полный лог'));
  check('комментарий в протоколе', html.includes('хорошая логика'));

  console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
});

setTimeout(() => { console.log('Таймаут теста'); process.exit(2); }, 30000);
