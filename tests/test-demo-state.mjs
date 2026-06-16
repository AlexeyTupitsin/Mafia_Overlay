// Готовит демонстрационное состояние для визуальной проверки оверлея
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3000/ws?role=control');
const wait = () => new Promise((r) => ws.once('message', r));
const act = async (type, payload) => { ws.send(JSON.stringify({ type: 'action', action: { type, payload } })); await wait(); };

const NICKS = ['ШТОРМ', 'ЛИСА', 'ГРАФ', 'ВЕГА', 'ТУЗ', 'МАЭСТРО', 'ИСКРА', 'БАРОН', 'НОЧЬ', 'СОКОЛ'];

ws.on('open', async () => {
  await wait();
  await act('NEW_GAME', { title: 'Кубок города', gameNumber: 3, carryPlayers: false });
  for (let s = 1; s <= 10; s++) await act('SET_PLAYER', { seat: s, nickname: NICKS[s - 1] });
  for (let s = 1; s <= 6; s++) await act('SET_ROLE', { seat: s, role: 'civilian' });
  await act('SET_ROLE', { seat: 7, role: 'mafia' });
  await act('SET_ROLE', { seat: 8, role: 'mafia' });
  await act('SET_ROLE', { seat: 9, role: 'don' });
  await act('SET_ROLE', { seat: 10, role: 'sheriff' });
  await act('START_GAME');
  // день 1: голосование → №4 ушёл
  await act('NOMINATE', { seat: 4 });
  await act('NOMINATE', { seat: 7 });
  await act('VOTING_START');
  await act('SET_VOTES', { seat: 4, votes: 6 });
  await act('SET_VOTES', { seat: 7, votes: 3 });
  await act('VOTING_FINISH');
  // ночь 1: отстрел №2 (ЛХ), проверки
  await act('NEXT_PHASE');
  await act('SET_SHOT', { seat: 2 });
  await act('SET_DON_CHECK', { seat: 5, found: false });
  await act('SET_SHERIFF_CHECK', { seat: 7, found: true });
  await act('SET_BEST_MOVE', { by: 2, picks: [7, 8, 9] });
  // день 2: фолы, спикер с таймером, идёт голосование
  await act('NEXT_PHASE');
  await act('ADD_FOUL', { seat: 1 });
  await act('ADD_FOUL', { seat: 1 });
  await act('ADD_FOUL', { seat: 1 });
  await act('ADD_FOUL', { seat: 6 });
  await act('SET_SPEAKER', { seat: 5 });
  await act('TIMER_START', { durationMs: 60000 });
  await act('NOMINATE', { seat: 7 });
  await act('NOMINATE', { seat: 9 });
  await act('VOTING_START');
  await act('SET_VOTES', { seat: 7, votes: 5 });
  await act('SET_VOTES', { seat: 9, votes: 2 });
  console.log('демо-состояние готово');
  process.exit(0);
});
