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

// Экранирование для вставки в innerHTML и в серверный протокол. Одна копия на
// панель, оверлей и сервер — раньше их было три, и расходились бы они молча.
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
  }[c]));
}

// ---- ники: ручной перенос строки --------------------------------------------

// Ведущий ставит «|» в нике, чтобы задать точку переноса на плашке оверлея:
// «Тёмный|Рыцарь» → две строки. Символ выбран как не встречающийся в живых никах.
export const NICK_BREAK = '|';

// Ник для оверлея: максимум две строки, первый «|» — точка переноса.
// Второй и далее разделитель смысла не имеет и становится обычным пробелом.
export function splitNickname(nick) {
  const s = String(nick ?? '').trim();
  const at = s.indexOf(NICK_BREAK);
  if (at === -1) return [s];
  const head = s.slice(0, at).trim();
  const tail = s.slice(at + 1).split(NICK_BREAK).join(' ').trim();
  // разделитель в самом начале или в конце — переносить нечего
  return head && tail ? [head, tail] : [(head || tail)];
}

// Ник для всех мест, кроме плашки оверлея и поля ввода: разделитель становится
// пробелом. Через неё же идёт сравнение ников (ростер), чтобы «Тёмный|Рыцарь»
// и «Тёмный Рыцарь» считались одним игроком.
export function displayNickname(nick) {
  return splitNickname(nick).join(' ');
}

// ---- порядок речей -----------------------------------------------------------
// Ленту круга (state.speaking) ведёт сервер; здесь — чистые подсказки для панели.
// Блокировки только в интерфейсе: сервер слово никому не запрещает.

const isAlive = (players, seat) => players[seat - 1]?.status === 'alive';

// Молчанка (3-й фол) действует в один конкретный день — тот, что записал сервер.
export function isSilenced(speaking, seat, round) {
  return speaking?.silenced?.[seat] === round;
}

// Первое живое место по кругу после from (from = null → считаем от №1).
function nextAliveAfter(players, from, ok = () => true) {
  const n = players.length;
  const start = from || 0;
  for (let k = 1; k <= n; k++) {
    const seat = ((start + k - 1) % n) + 1;
    if (isAlive(players, seat) && ok(seat)) return seat;
  }
  return null;
}

// Кто открывает дневной круг: следующий живой после открывавшего прошлый день.
export function recommendedStarter(players, prevStarter) {
  return nextAliveAfter(players, prevStarter);
}

// Угадайка — круг, когда за столом осталось 3 или 4 игрока.
export function isGuessing(players) {
  return players.filter((p) => p.status === 'alive').length <= 4;
}

// Какой ход у игрока в круге: 'full' — обычная речь; 'silent' — молчанка (3 фола):
// без речи, но ход есть и кандидатуру выставить можно; 'short' — молчанка
// в угадайке: молчащему всё же дают короткую речь (30 сек по умолчанию).
export function speechMode(players, speaking, seat, round) {
  if (!isSilenced(speaking, seat, round)) return 'full';
  return isGuessing(players) ? 'short' : 'silent';
}

// Чей ход следующим: по кругу после последнего ходившего, мимо выбывших и уже
// ходивших. Молчащих не пропускаем — у них ход без речи. null — круг пройден.
export function nextSpeakerHint(players, speaking) {
  const spoken = speaking?.spoken || [];
  const ok = (seat) => !spoken.includes(seat);
  const from = spoken.length
    ? spoken[spoken.length - 1]
    : (recommendedStarter(players, speaking?.prevStarter) || 1) - 1;
  return nextAliveAfter(players, from, ok);
}

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
