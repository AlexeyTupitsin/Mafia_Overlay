// Типы действий, роли, статусы — общие константы клиентов

export const ROLES = {
  civilian: { label: 'Мирный', short: 'Мир', color: '#cf3b34' },
  mafia: { label: 'Мафия', short: 'Маф', color: '#23262f' },
  don: { label: 'Дон', short: 'Дон', color: '#8040c9' },
  sheriff: { label: 'Шериф', short: 'Шер', color: '#e8b31e' }
};

export const STATUSES = {
  alive: { label: 'В игре' },
  voted_out: { label: 'Заголосован' },
  killed: { label: 'Убит' },
  removed: { label: 'Удалён' }
};

export const RESULTS = {
  city_win: 'Победа мирных',
  mafia_win: 'Победа мафии',
  draw: 'Ничья'
};

export const OVERLAY_KEYS = {
  plates: 'Плашки игроков',
  tracker: 'Трекер',
  votingBar: 'Бар голосования',
  roles: 'Роли на плашках'
};

// ---- баллы игроков ----------------------------------------------------------

// округление до 0.1 (шаг дробного балла)
export function roundScore(n) {
  return Math.round(Number(n) * 10) / 10;
}

// базовый балл по роли и результату игры: победа = 1, поражение/ничья = 0.
// Чёрные (мафия/дон) побеждают при mafia_win, красные — при city_win.
export function autoBaseScore(player, result) {
  if (result !== 'city_win' && result !== 'mafia_win') return 0;
  const isBlack = player.role === 'mafia' || player.role === 'don';
  return isBlack === (result === 'mafia_win') ? 1 : 0;
}

// отображаемый базовый балл: ручное переопределение, иначе авто.
// scoreBase === undefined (старые игры) или null → авто.
export function displayBase(player, result) {
  return player.scoreBase ?? autoBaseScore(player, result);
}

// итоговый балл игрока = базовый + дополнительный
export function totalScore(player, result) {
  return roundScore(displayBase(player, result) + (player.scoreBonus || 0));
}
