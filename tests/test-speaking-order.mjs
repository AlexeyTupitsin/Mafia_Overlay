// Контроль порядка речей: сервер ведёт ленту круга (кто уже говорил, кто открыл
// день), отмечает молчанку на 3-м фоле; панель по этим данным блокирует кнопки
// и подсказывает, кому слово. Спека: docs/superpowers/specs/2026-06-19-speaking-order-control-design.md

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';
import { connect, startGame } from './helpers/client.mjs';
import { recommendedStarter, nextSpeakerHint, isSilenced, isGuessing, speechMode } from '../public/shared/constants.js';

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

// ---------------------------------------------------------------- сервер

test('новая игра: круг пуст, никто не открывал день', async () => {
  await startGame(c);
  assert.deepEqual(c.state.speaking, {
    round: 1, spoken: [], circleStarter: null, prevStarter: null, silenced: {}
  });
});

test('слово в обсуждении попадает в ленту, первый — открывает круг', async () => {
  await startGame(c);
  await c.act('SET_SPEAKER', { seat: 3 });
  await c.act('SET_SPEAKER', { seat: 4 });
  await c.act('SET_SPEAKER', { seat: 3 }); // повтор не дублирует запись
  await c.act('SET_SPEAKER', { seat: null }); // снять слово — лента не меняется
  assert.equal(c.lastError, null);
  assert.deepEqual(c.state.speaking.spoken, [3, 4]);
  assert.equal(c.state.speaking.circleStarter, 3);
});

test('речи во время голосования в круг не идут', async () => {
  await startGame(c);
  await c.act('SET_SPEAKER', { seat: 1 });
  await c.act('NOMINATE', { seat: 5 });
  await c.act('VOTING_START');
  await c.act('SET_SPEAKER', { seat: 5 });
  assert.deepEqual(c.state.speaking.spoken, [1]);
});

test('новый день: круг сброшен, открывший прошлый день запомнен', async () => {
  await startGame(c);
  await c.act('SET_SPEAKER', { seat: 2 });
  await c.act('SET_SPEAKER', { seat: 3 });
  await c.act('NEXT_PHASE'); // ночь 1
  assert.deepEqual(c.state.speaking.spoken, [2, 3], 'ночью круг дня ещё не сброшен');
  await c.act('NEXT_PHASE'); // день 2
  assert.deepEqual(c.state.speaking, {
    round: 2, spoken: [], circleStarter: null, prevStarter: 2, silenced: {}
  });
});

test('день без речей не затирает прошлого открывающего', async () => {
  await startGame(c);
  await c.act('SET_SPEAKER', { seat: 6 });
  await c.act('NEXT_PHASE');
  await c.act('NEXT_PHASE'); // день 2 — никто не говорил
  await c.act('NEXT_PHASE');
  await c.act('NEXT_PHASE'); // день 3
  assert.equal(c.state.speaking.prevStarter, 6);
});

test('3-й фол до речи — молчанка в этом же круге', async () => {
  await startGame(c);
  for (let i = 0; i < 3; i++) await c.act('ADD_FOUL', { seat: 5 });
  assert.equal(c.state.speaking.silenced[5], 1);
});

test('3-й фол после речи — молчанка переходит на следующий день', async () => {
  await startGame(c);
  await c.act('SET_SPEAKER', { seat: 5 });
  for (let i = 0; i < 3; i++) await c.act('ADD_FOUL', { seat: 5 });
  assert.equal(c.state.speaking.silenced[5], 2);
});

test('3-й фол ночью — молчанка на следующий день', async () => {
  await startGame(c);
  await c.act('NEXT_PHASE'); // ночь 1
  for (let i = 0; i < 3; i++) await c.act('ADD_FOUL', { seat: 8 });
  assert.equal(c.state.speaking.silenced[8], 2);
});

test('снятый 3-й фол отменяет молчанку', async () => {
  await startGame(c);
  for (let i = 0; i < 3; i++) await c.act('ADD_FOUL', { seat: 1 });
  await c.act('REMOVE_FOUL', { seat: 1 });
  assert.equal(c.state.speaking.silenced[1], undefined);
});

test('сервер не отклоняет повтор и молчащего — защита только в панели', async () => {
  await startGame(c);
  for (let i = 0; i < 3; i++) await c.act('ADD_FOUL', { seat: 2 });
  await c.act('SET_SPEAKER', { seat: 2 });
  assert.equal(c.lastError, null);
  assert.equal(c.state.speaker.seat, 2);
});

test('старый автосейв без поля speaking поднимается с дефолтом', async () => {
  const sandbox = await startServer();
  const cc = await connect(sandbox);
  await startGame(cc);
  await cc.act('NEXT_PHASE');
  await cc.act('NEXT_PHASE'); // день 2
  cc.close();
  await sandbox.stop();

  // имитируем автосейв версии до контроля порядка речей
  const file = path.join(sandbox.dataDir, 'autosave.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete saved.speaking;
  fs.writeFileSync(file, JSON.stringify(saved));

  const restarted = await startServer({ dataDir: sandbox.dataDir });
  try {
    const c2 = await connect(restarted);
    assert.deepEqual(c2.state.speaking, {
      round: 2, spoken: [], circleStarter: null, prevStarter: null, silenced: {}
    });
    c2.close();
  } finally {
    await restarted.stop();
    restarted.cleanup();
  }
});

// ---------------------------------------------------------------- подсказки панели

const players = (dead = []) => Array.from({ length: 10 }, (_, i) => ({
  seat: i + 1, status: dead.includes(i + 1) ? 'killed' : 'alive'
}));

test('старт первого дня — первое живое место', () => {
  assert.equal(recommendedStarter(players(), null), 1);
  assert.equal(recommendedStarter(players([1, 2]), null), 3);
});

test('старт следующего дня — следующий живой после открывавшего', () => {
  assert.equal(recommendedStarter(players(), 3), 4);
  assert.equal(recommendedStarter(players([4, 5]), 3), 6);
  assert.equal(recommendedStarter(players(), 10), 1, 'по кругу через 10 → 1');
});

test('следующий по кругу — после последнего, мимо выбывших и уже ходивших', () => {
  const speaking = { round: 2, spoken: [4, 6], circleStarter: 4, prevStarter: 3, silenced: {} };
  assert.equal(nextSpeakerHint(players([5]), { ...speaking, spoken: [4] }), 6);
  assert.equal(nextSpeakerHint(players([7]), speaking), 8);
});

test('молчащий не пропускается: ход у него есть — без речи, но с правом выставить', () => {
  const speaking = { round: 2, spoken: [4], circleStarter: 4, prevStarter: 3, silenced: { 5: 2 } };
  assert.equal(nextSpeakerHint(players(), speaking), 5);
});

test('пустой круг — подсказка совпадает со стартом', () => {
  const speaking = { round: 2, spoken: [], circleStarter: null, prevStarter: 3, silenced: {} };
  assert.equal(nextSpeakerHint(players(), speaking), 4);
});

test('все высказались — подсказки нет', () => {
  const speaking = { round: 1, spoken: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], circleStarter: 1, prevStarter: null, silenced: {} };
  assert.equal(nextSpeakerHint(players(), speaking), null);
});

test('молчанка действует только в свой день', () => {
  const speaking = { silenced: { 6: 2 } };
  assert.equal(isSilenced(speaking, 6, 2), true);
  assert.equal(isSilenced(speaking, 6, 3), false);
  assert.equal(isSilenced(speaking, 7, 2), false);
});

test('угадайка — за столом 3 или 4 игрока', () => {
  assert.equal(isGuessing(players([1, 2, 3, 4, 5, 6])), true, '4 живых');
  assert.equal(isGuessing(players([1, 2, 3, 4, 5, 6, 7])), true, '3 живых');
  assert.equal(isGuessing(players([1, 2, 3, 4, 5])), false, '5 живых');
});

test('режим хода: обычная речь, молчанка без речи, в угадайке молчащему — короткая', () => {
  const speaking = { silenced: { 8: 3 } };
  assert.equal(speechMode(players(), speaking, 9, 3), 'full');
  assert.equal(speechMode(players(), speaking, 8, 3), 'silent');
  assert.equal(speechMode(players(), speaking, 8, 4), 'full', 'молчанка отыграна');
  assert.equal(speechMode(players([1, 2, 3, 4, 5, 6]), speaking, 8, 3), 'short');
});
