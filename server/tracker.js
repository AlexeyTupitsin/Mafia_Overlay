// REST-клиент к Supabase трекера (Iron Maf / MafiaClubTracker).
// Сейчас задействован один сценарий — импорт игроков в ростер оверлея.
// service_role-ключ читается из config.json и живёт только здесь, на сервере,
// поэтому минует RLS трекера и никогда не уходит в браузер.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayBase, totalScore } from '../public/shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function getConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const t = cfg.tracker || {};
    return {
      enabled: Boolean(t.enabled),
      supabaseUrl: String(t.supabaseUrl || '').replace(/\/+$/, ''), // без хвостовых слешей
      serviceRoleKey: String(t.serviceRoleKey || '')
    };
  } catch {
    return { enabled: false, supabaseUrl: '', serviceRoleKey: '' };
  }
}

export function isEnabled() {
  const c = getConfig();
  return c.enabled && Boolean(c.supabaseUrl) && Boolean(c.serviceRoleKey);
}

// Тонкая обёртка над PostgREST. Бросает Error с текстом из тела при !ok.
async function rest(restPath, { method = 'GET', body } = {}) {
  const c = getConfig();
  const res = await fetch(`${c.supabaseUrl}/rest/v1/${restPath}`, {
    method,
    headers: {
      apikey: c.serviceRoleKey,
      Authorization: `Bearer ${c.serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message || text; } catch { /* тело не JSON — отдаём как есть */ }
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return text ? JSON.parse(text) : null;
}

// Игроки трекера для импорта. avatar_url уже хранится как полный публичный URL
// Supabase Storage — браузер OBS загрузит его напрямую, перезаливка не нужна.
export async function getPlayers() {
  const rows = await rest('players?select=id,nickname,avatar_url&order=nickname');
  return rows.map((r) => ({
    id: r.id,
    nickname: r.nickname,
    avatarUrl: r.avatar_url || null
  }));
}

// --- отправка завершённой игры ----------------------------------------------

// Чистые функции маппинга (тестируются без сети).

// роли оверлея → роли трекера: civilian → citizen; mafia/don/sheriff без изменений
export function mapRole(role) {
  return role === 'civilian' ? 'citizen' : role;
}

// результат игры → команда-победитель трекера
export function mapWinner(result) {
  return result === 'city_win' ? 'red' : result === 'mafia_win' ? 'black' : 'draw';
}

// результат конкретного игрока по его роли и команде-победителю
export function playerResult(role, winner) {
  if (winner === 'draw') return 'draw';
  const isBlack = role === 'mafia' || role === 'don';
  const team = isBlack ? 'black' : 'red';
  return team === winner ? 'win' : 'lose';
}

// Полный payload игры для трекера. Сопоставление идёт по player.trackerId,
// отображаемому нику не доверяем. Баллы — те же функции, что и в протоколе.
export function buildGamePayload(state, seasonId, tournamentId, gameNumber) {
  const result = state.meta.result;
  const winner = mapWinner(result);
  const bySeat = state.bestMove && state.bestMove.by;
  const picks = (state.bestMove && state.bestMove.picks) || [];
  const game = {
    season_id: seasonId,
    tournament_id: tournamentId,
    game_number: gameNumber,
    date: state.meta.finishedAt,
    winner,
    notes: null,
    // first_killed — это игрок, оставивший ЛХ (первый отстрелянный): bestMove.by
    first_killed: bySeat ? (state.players[bySeat - 1].trackerId || null) : null,
    best_move_seat_1: picks[0] ?? null,
    best_move_seat_2: picks[1] ?? null,
    best_move_seat_3: picks[2] ?? null
  };
  const gamePlayers = state.players.map((pl) => ({
    player_id: pl.trackerId,
    seat: pl.seat,
    role: mapRole(pl.role),
    result: playerResult(pl.role, winner),
    base_score: displayBase(pl, result),
    bonus_score: pl.scoreBonus || 0,
    bonus_comment: pl.comment || null,
    total_score: totalScore(pl, result)
  }));
  return { game, gamePlayers };
}

// --- REST: чтение для отправки ---

export async function getActiveSeason() {
  const rows = await rest('seasons?select=id,name&is_active=eq.true');
  return rows[0] || null;
}

export async function getMaxGameNumber(seasonId) {
  const rows = await rest(`games?season_id=eq.${seasonId}&select=game_number&order=game_number.desc&limit=1`);
  return rows[0] ? rows[0].game_number : 0;
}

export async function findTournament(seasonId, name, date) {
  const q = `tournaments?season_id=eq.${seasonId}&name=eq.${encodeURIComponent(name)}&date=eq.${date}&select=id`;
  const rows = await rest(q);
  return rows[0] ? rows[0].id : null;
}

// --- REST: запись ---

export async function createTournament(seasonId, name, date) {
  const rows = await rest('tournaments', { method: 'POST', body: { season_id: seasonId, name, date } });
  return rows[0].id;
}

export async function createGame(row) {
  const rows = await rest('games', { method: 'POST', body: row });
  return rows[0];
}

export async function createGamePlayers(rows) {
  await rest('game_players', { method: 'POST', body: rows });
}
