// Импорт игроков из трекера и чистые функции маппинга отправки игры.
// Сеть не нужна — global.fetch мокается.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getPlayers, isEnabled, mapRole, mapWinner, playerResult, buildGamePayload, normalizeAvatar,
  buildEqFilter
} from '../server/tracker.js';

// isEnabled() зависит от локального config.json — проверяем только тип, чтобы
// тест не зависел от того, настроен ли трекер на машине.
test('isEnabled() возвращает boolean', () => {
  assert.equal(typeof isEnabled(), 'boolean');
});

test('getPlayers маппит строки трекера в записи ростера', async (t) => {
  const orig = global.fetch;
  global.fetch = async () => ({
    ok: true,
    text: async () => JSON.stringify([
      { id: 'uuid-1', nickname: 'Анна', avatar_url: 'https://x.supabase.co/storage/v1/object/public/avatars/a.jpg' },
      { id: 'uuid-2', nickname: 'Борис', avatar_url: null }
    ])
  });
  t.after(() => { global.fetch = orig; });

  const players = await getPlayers();
  assert.equal(players.length, 2);
  assert.equal(players[0].id, 'uuid-1');
  assert.equal(players[0].nickname, 'Анна');
  assert.match(players[0].avatarUrl, /a\.jpg$/);
  assert.equal(players[1].avatarUrl, null, 'нет аватара → null');
});

test('ошибка PostgREST пробрасывается с текстом из тела', async (t) => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ message: 'boom' }) });
  t.after(() => { global.fetch = orig; });

  await assert.rejects(() => getPlayers(), /^Error: boom$/);
});

test('normalizeAvatar достраивает относительный путь трекера', () => {
  const SB = 'https://proj.supabase.co';
  assert.equal(normalizeAvatar('', SB), null);
  assert.equal(normalizeAvatar(null, SB), null);
  assert.equal(normalizeAvatar('https://x.supabase.co/storage/a.jpg', SB), 'https://x.supabase.co/storage/a.jpg');
  assert.equal(
    normalizeAvatar('/supabase-proxy/storage/v1/object/public/avatars/u/1.png', SB),
    'https://proj.supabase.co/storage/v1/object/public/avatars/u/1.png'
  );
  assert.equal(normalizeAvatar('/uploads/abc.jpg', SB), '/uploads/abc.jpg', '/uploads не трогаем');
  assert.equal(
    normalizeAvatar('/supabase-proxy/storage/x.png', ''),
    '/supabase-proxy/storage/x.png',
    'без supabaseUrl достраивать нечем'
  );
});

test('buildEqFilter экранирует значения со спецсимволами PostgREST', () => {
  // Без кавычек запятая разбирается PostgREST как разделитель фильтров:
  // турнир «Кубок клуба, этап 2» либо не находился, либо давал 400.
  assert.equal(buildEqFilter('Кубок'), `eq.${encodeURIComponent('"Кубок"')}`);
  assert.equal(buildEqFilter('Кубок клуба, этап 2'), `eq.${encodeURIComponent('"Кубок клуба, этап 2"')}`);
  assert.equal(buildEqFilter('Финал (2026)'), `eq.${encodeURIComponent('"Финал (2026)"')}`);
  assert.equal(buildEqFilter('Кубок "Север"'), `eq.${encodeURIComponent('"Кубок \\"Север\\""')}`);
});

test('mapRole переводит мирного в citizen, остальные роли не трогает', () => {
  assert.equal(mapRole('civilian'), 'citizen');
  assert.equal(mapRole('mafia'), 'mafia');
  assert.equal(mapRole('don'), 'don');
  assert.equal(mapRole('sheriff'), 'sheriff');
});

test('mapWinner переводит результат в команду', () => {
  assert.equal(mapWinner('city_win'), 'red');
  assert.equal(mapWinner('mafia_win'), 'black');
  assert.equal(mapWinner('draw'), 'draw');
});

test('playerResult считает исход по роли и победителю', () => {
  assert.equal(playerResult('don', 'black'), 'win');
  assert.equal(playerResult('civilian', 'black'), 'lose');
  assert.equal(playerResult('sheriff', 'draw'), 'draw');
});

test('buildGamePayload собирает игру и места для трекера', () => {
  const roles = ['don', 'mafia', 'civilian', 'sheriff', 'civilian', 'civilian', 'mafia', 'civilian', 'civilian', 'civilian'];
  const state = {
    meta: { result: 'mafia_win', finishedAt: '2026-06-14T20:30:00.000Z', title: 'Кубок' },
    bestMove: { by: 3, picks: [2, 7] },
    players: roles.map((role, i) => ({
      seat: i + 1,
      role,
      trackerId: `id-${i + 1}`,
      scoreBase: null,
      scoreBonus: i === 2 ? 0.5 : 0,
      comment: i === 2 ? 'ЛХ' : ''
    }))
  };

  const { game, gamePlayers } = buildGamePayload(state, 'season-1', 'tour-1', 12);

  assert.equal(game.season_id, 'season-1');
  assert.equal(game.tournament_id, 'tour-1');
  assert.equal(game.game_number, 12);
  assert.equal(game.winner, 'black');
  assert.equal(game.date, '2026-06-14T20:30:00.000Z');
  assert.equal(game.first_killed, 'id-3', 'ЛХ оставил игрок с места 3');
  assert.equal(game.best_move_seat_1, 2);
  assert.equal(game.best_move_seat_2, 7);
  assert.equal(game.best_move_seat_3, null);

  assert.equal(gamePlayers.length, 10);
  assert.equal(gamePlayers[0].player_id, 'id-1');
  assert.equal(gamePlayers[2].role, 'citizen');
  assert.equal(gamePlayers[0].result, 'win');
  assert.equal(gamePlayers[0].base_score, 1);
  assert.equal(gamePlayers[2].result, 'lose');
  assert.equal(gamePlayers[2].base_score, 0);
  assert.equal(gamePlayers[2].bonus_score, 0.5);
  assert.equal(gamePlayers[2].bonus_comment, 'ЛХ');
  assert.equal(gamePlayers[2].total_score, 0.5);
});
