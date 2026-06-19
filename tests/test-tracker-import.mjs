// Юнит-тест импорта из трекера: маппинг players → ростер и проброс ошибок.
// Сеть не нужна — global.fetch мокается.

import {
  getPlayers, isEnabled, mapRole, mapWinner, playerResult, buildGamePayload, normalizeAvatar
} from '../server/tracker.js';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass += 1; console.log('  ok:', name); }
  else { fail += 1; console.log('  FAIL:', name); }
}

// isEnabled() зависит от локального config.json — проверяем только тип (не значение,
// чтобы тест не падал в зависимости от того, настроен ли трекер на машине).
check('isEnabled() возвращает boolean', typeof isEnabled() === 'boolean');

const origFetch = global.fetch;

// getPlayers: avatar_url → avatarUrl, отсутствие аватара → null.
const fakeRows = [
  { id: 'uuid-1', nickname: 'Анна', avatar_url: 'https://x.supabase.co/storage/v1/object/public/avatars/a.jpg' },
  { id: 'uuid-2', nickname: 'Борис', avatar_url: null }
];
global.fetch = async () => ({ ok: true, text: async () => JSON.stringify(fakeRows) });
try {
  const players = await getPlayers();
  check('импортировано 2 игрока', players.length === 2);
  check('маппинг id/nickname/avatarUrl',
    players[0].id === 'uuid-1' && players[0].nickname === 'Анна' && players[0].avatarUrl.endsWith('a.jpg'));
  check('нет аватара → avatarUrl = null', players[1].avatarUrl === null);
} finally {
  global.fetch = origFetch;
}

// Ошибка PostgREST пробрасывается с текстом из тела.
global.fetch = async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ message: 'boom' }) });
try {
  await getPlayers();
  check('ошибка трекера пробрасывается', false);
} catch (e) {
  check('ошибка трекера пробрасывается с текстом', e.message === 'boom');
} finally {
  global.fetch = origFetch;
}

// normalizeAvatar: относительный путь фронтенда трекера → абсолютный URL Supabase.
const SB = 'https://proj.supabase.co';
check('normalizeAvatar: пусто → null', normalizeAvatar('', SB) === null && normalizeAvatar(null, SB) === null);
check('normalizeAvatar: абсолютный http остаётся как есть',
  normalizeAvatar('https://x.supabase.co/storage/a.jpg', SB) === 'https://x.supabase.co/storage/a.jpg');
check('normalizeAvatar: /supabase-proxy/ → абсолютный URL Supabase',
  normalizeAvatar('/supabase-proxy/storage/v1/object/public/avatars/u/1.png', SB)
    === 'https://proj.supabase.co/storage/v1/object/public/avatars/u/1.png');
check('normalizeAvatar: /uploads/ не трогаем',
  normalizeAvatar('/uploads/abc.jpg', SB) === '/uploads/abc.jpg');
check('normalizeAvatar: без supabaseUrl относительный путь остаётся как есть (нечем достроить)',
  normalizeAvatar('/supabase-proxy/storage/x.png', '') === '/supabase-proxy/storage/x.png');

// --- чистые функции маппинга отправки игры ---

check('mapRole: civilian → citizen', mapRole('civilian') === 'citizen');
check('mapRole: mafia/don/sheriff без изменений',
  mapRole('mafia') === 'mafia' && mapRole('don') === 'don' && mapRole('sheriff') === 'sheriff');

check('mapWinner: city_win → red', mapWinner('city_win') === 'red');
check('mapWinner: mafia_win → black', mapWinner('mafia_win') === 'black');
check('mapWinner: draw → draw', mapWinner('draw') === 'draw');

check('playerResult: чёрный при победе чёрных → win', playerResult('don', 'black') === 'win');
check('playerResult: красный при победе чёрных → lose', playerResult('civilian', 'black') === 'lose');
check('playerResult: ничья → draw для всех', playerResult('sheriff', 'draw') === 'draw');

// buildGamePayload на компактном состоянии (победа мафии)
const roles = ['don', 'mafia', 'civilian', 'sheriff', 'civilian', 'civilian', 'mafia', 'civilian', 'civilian', 'civilian'];
const state = {
  meta: { result: 'mafia_win', finishedAt: '2026-06-14T20:30:00.000Z', title: 'Кубок' },
  bestMove: { by: 3, picks: [2, 7] },
  players: roles.map((role, i) => ({
    seat: i + 1, role, trackerId: `id-${i + 1}`,
    scoreBase: null, scoreBonus: i === 2 ? 0.5 : 0, comment: i === 2 ? 'ЛХ' : ''
  }))
};
const { game, gamePlayers } = buildGamePayload(state, 'season-1', 'tour-1', 12);

check('payload: season_id/tournament_id/game_number',
  game.season_id === 'season-1' && game.tournament_id === 'tour-1' && game.game_number === 12);
check('payload: winner = black', game.winner === 'black');
check('payload: date = finishedAt', game.date === '2026-06-14T20:30:00.000Z');
check('payload: first_killed = trackerId места ЛХ (seat 3)', game.first_killed === 'id-3');
check('payload: best_move_seat_1/2/3', game.best_move_seat_1 === 2 && game.best_move_seat_2 === 7 && game.best_move_seat_3 === null);
check('payload: 10 игроков', gamePlayers.length === 10);
check('payload: роль civilian → citizen', gamePlayers[2].role === 'citizen');
check('payload: дон при победе мафии → win, base 1', gamePlayers[0].result === 'win' && gamePlayers[0].base_score === 1);
check('payload: мирный при победе мафии → lose, base 0', gamePlayers[2].result === 'lose' && gamePlayers[2].base_score === 0);
check('payload: player_id = trackerId', gamePlayers[0].player_id === 'id-1');
check('payload: бонус и комментарий', gamePlayers[2].bonus_score === 0.5 && gamePlayers[2].bonus_comment === 'ЛХ' && gamePlayers[2].total_score === 0.5);

console.log(`\nПРОВАЛОВ: ${fail} из ${pass + fail}`);
process.exit(fail ? 1 : 0);
