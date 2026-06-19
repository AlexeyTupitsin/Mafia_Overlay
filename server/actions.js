// Обработчики всех типов действий + валидация.
// Каждый обработчик мутирует переданную копию состояния (store клонирует state
// перед вызовом и коммитит только при успехе). NEW_GAME возвращает новый объект.

import { roundScore } from '../public/shared/constants.js';

export class ValidationError extends Error {}

export const ROLES = ['civilian', 'mafia', 'don', 'sheriff'];
export const STATUSES = ['alive', 'voted_out', 'killed', 'removed'];
export const RESULTS = ['city_win', 'mafia_win', 'draw'];
export const OVERLAY_KEYS = ['plates', 'tracker', 'votingBar', 'timer', 'roles'];

const ROLE_LABELS = {
  civilian: 'мирный',
  mafia: 'мафия',
  don: 'дон',
  sheriff: 'шериф'
};
const STATUS_LABELS = {
  alive: 'в игре',
  voted_out: 'заголосован',
  killed: 'убит',
  removed: 'удалён'
};
const RESULT_LABELS = {
  city_win: 'победа мирных',
  mafia_win: 'победа мафии',
  draw: 'ничья'
};

// Действия, перед которыми НЕ делается снапшот для undo (см. B.4)
export const NOT_UNDOABLE = new Set([
  'UNDO', 'TIMER_START', 'TIMER_PAUSE', 'TIMER_RESET', 'SET_OVERLAY_VISIBILITY',
  'SET_TRACKER_GAME_ID', 'SET_COMMENT'
]);

// Действия, не попадающие в протокол игры
export const NOT_LOGGED = new Set([
  'UNDO', 'TIMER_START', 'TIMER_PAUSE', 'TIMER_RESET', 'SET_OVERLAY_VISIBILITY',
  'SET_COMMENT'
]);

function getPlayer(state, seat) {
  if (!Number.isInteger(seat) || seat < 1 || seat > 10) {
    throw new ValidationError(`Некорректный номер места: ${seat}`);
  }
  return state.players[seat - 1];
}

function playerName(state, seat) {
  const p = state.players[seat - 1];
  return p && p.nickname ? `№${seat} ${p.nickname}` : `№${seat}`;
}

// Гарантирует наличие записей ночей до указанного круга включительно.
// Поле shot намеренно не инициализируется: его отсутствие = «не записано»,
// null = «промах», число = место убитого.
function ensureNight(state, round) {
  while (state.nights.length < round) {
    state.nights.push({ night: state.nights.length + 1, donCheck: null, sheriffCheck: null });
  }
  return state.nights[round - 1];
}

function resetTimer(state, durationMs) {
  const t = state.speaker.timer;
  if (durationMs) t.durationMs = durationMs;
  t.running = false;
  t.endsAt = null;
  t.remainingMs = t.durationMs;
}

function resetVotingForDay(state, day) {
  state.voting = { active: false, day, stage: 'nominations', nominations: [], liftAllVotes: null };
}

function addVotedOut(state, day, seats) {
  const entry = state.votedOut.find((v) => v.day === day);
  if (entry) entry.seats.push(...seats);
  else state.votedOut.push({ day, seats: [...seats] });
}

// true, если в игре ещё не было ни одной смерти/выбытия (для условия ЛХ)
function noDeathsYet(state, exceptSeat) {
  return state.players.every((p) => p.seat === exceptSeat || p.status === 'alive');
}

function aliveCount(state) {
  return state.players.filter((p) => p.status === 'alive').length;
}

// Результат проверки вычисляется автоматически по реальной роли проверяемого:
// дон ищет шерифа, шериф ищет чёрных (мафию/дона). Ведущий результат не вводит.
function checkResult(state, who, targetSeat) {
  const role = state.players[targetSeat - 1].role;
  return who === 'don' ? role === 'sheriff' : role === 'mafia' || role === 'don';
}

// Дон/шериф, покинувший стол, проверять не может. Исключение: игрок,
// отстрелянный этой же ночью, ещё «за столом» (покинет его утром) и проверяет.
function assertCheckerAlive(state, role, label) {
  const checker = state.players.find((p) => p.role === role);
  if (!checker || checker.status === 'alive') return;
  const night = state.nights[state.phase.round - 1];
  if (checker.status === 'killed' && night && night.shot === checker.seat) return;
  throw new ValidationError(`${label} выбыл из игры и не может проверять`);
}

export const handlers = {
  NEW_GAME(state, p, ctx) {
    const fresh = ctx.createInitialState();
    fresh.meta.title = typeof p.title === 'string' ? p.title : state.meta.title;
    fresh.meta.gameNumber =
      p.gameNumber !== undefined ? p.gameNumber : (state.meta.gameNumber || 0) + 1 || null;
    if (p.carryPlayers) {
      fresh.players.forEach((pl, i) => {
        pl.nickname = state.players[i].nickname;
        pl.photo = state.players[i].photo;
        pl.trackerId = state.players[i].trackerId || null; // связь с трекером сохраняем
      });
    }
    fresh.settings = { ...state.settings };
    return fresh;
  },

  SET_META(state, p) {
    if (p.title !== undefined) state.meta.title = String(p.title).slice(0, 120);
    if (p.gameNumber !== undefined) {
      const n = Number(p.gameNumber);
      state.meta.gameNumber = Number.isFinite(n) && n > 0 ? n : null;
    }
  },

  SET_PLAYER(state, p) {
    const player = getPlayer(state, p.seat);
    if (p.nickname !== undefined) player.nickname = String(p.nickname).slice(0, 40);
    if (p.photo !== undefined) player.photo = p.photo || null;
    // привязка к трекеру живёт отдельно от ника: правка отображаемого ника
    // (укоротить, добавить тег команды) её не сбрасывает
    if (p.trackerId !== undefined) player.trackerId = p.trackerId || null;
  },

  SWAP_SEATS(state, p) {
    const a = getPlayer(state, p.a);
    const b = getPlayer(state, p.b);
    if (state.meta.status !== 'setup') {
      throw new ValidationError('Пересадка возможна только до начала игры');
    }
    const tmp = { ...a };
    Object.assign(a, { ...b, seat: a.seat });
    Object.assign(b, { ...tmp, seat: b.seat });
  },

  SET_SETTINGS(state, p) {
    for (const key of ['speechSec', 'shortSpeechSec', 'foulSilenceAt', 'foulRemoveAt']) {
      if (p[key] !== undefined) {
        const n = Number(p[key]);
        if (!Number.isFinite(n) || n < 1 || n > 600) {
          throw new ValidationError(`Некорректное значение настройки ${key}`);
        }
        state.settings[key] = Math.round(n);
      }
    }
  },

  SET_ROLE(state, p) {
    if (p.role !== null && !ROLES.includes(p.role)) {
      throw new ValidationError(`Неизвестная роль: ${p.role}`);
    }
    getPlayer(state, p.seat).role = p.role;
  },

  START_GAME(state) {
    if (state.meta.status !== 'setup') {
      throw new ValidationError('Игра уже начата');
    }
    const count = (role) => state.players.filter((pl) => pl.role === role).length;
    if (count('mafia') !== 2 || count('don') !== 1 || count('sheriff') !== 1 || count('civilian') !== 6) {
      throw new ValidationError(
        `Неверный состав ролей: нужно 6 мирных, 2 мафии, 1 дон, 1 шериф ` +
        `(сейчас: ${count('civilian')}/${count('mafia')}/${count('don')}/${count('sheriff')})`
      );
    }
    state.meta.status = 'in_progress';
    state.meta.startedAt = new Date().toISOString();
    state.phase = { kind: 'day', round: 1 };
    resetVotingForDay(state, 1);
    resetTimer(state, state.settings.speechSec * 1000);
  },

  SET_PHASE(state, p) {
    if (p.kind !== 'day' && p.kind !== 'night') {
      throw new ValidationError(`Некорректная фаза: ${p.kind}`);
    }
    const round = Number(p.round);
    if (!Number.isInteger(round) || round < 1 || round > 50) {
      throw new ValidationError(`Некорректный номер круга: ${p.round}`);
    }
    state.phase = { kind: p.kind, round };
    state.speaker.seat = null;
    resetTimer(state);
    if (p.kind === 'day' && state.voting.day !== round) {
      resetVotingForDay(state, round);
    }
  },

  NEXT_PHASE(state) {
    if (state.meta.status !== 'in_progress') {
      throw new ValidationError('Игра не запущена');
    }
    if (state.phase.kind === 'day') {
      state.phase = { kind: 'night', round: state.phase.round };
      ensureNight(state, state.phase.round);
    } else {
      state.phase = { kind: 'day', round: state.phase.round + 1 };
      resetVotingForDay(state, state.phase.round);
    }
    state.speaker.seat = null;
    resetTimer(state);
  },

  SET_SPEAKER(state, p) {
    if (p.seat === null) {
      state.speaker.seat = null;
    } else {
      state.speaker.seat = getPlayer(state, p.seat).seat;
    }
    resetTimer(state, state.settings.speechSec * 1000);
  },

  TIMER_START(state, p) {
    const t = state.speaker.timer;
    if (p.durationMs !== undefined) {
      const ms = Number(p.durationMs);
      if (!Number.isFinite(ms) || ms < 1000 || ms > 600000) {
        throw new ValidationError('Некорректная длительность таймера');
      }
      t.durationMs = ms;
      t.remainingMs = ms;
    }
    if (t.remainingMs <= 0) t.remainingMs = t.durationMs;
    t.endsAt = Date.now() + t.remainingMs;
    t.running = true;
  },

  TIMER_PAUSE(state) {
    const t = state.speaker.timer;
    if (t.running && t.endsAt) {
      t.remainingMs = Math.max(0, t.endsAt - Date.now());
    }
    t.running = false;
    t.endsAt = null;
  },

  TIMER_RESET(state) {
    resetTimer(state);
  },

  ADD_FOUL(state, p) {
    const player = getPlayer(state, p.seat);
    if (player.fouls >= state.settings.foulRemoveAt) {
      throw new ValidationError(`У игрока уже ${player.fouls} фола`);
    }
    player.fouls += 1;
  },

  REMOVE_FOUL(state, p) {
    const player = getPlayer(state, p.seat);
    if (player.fouls <= 0) throw new ValidationError('У игрока нет фолов');
    player.fouls -= 1;
  },

  SET_STATUS(state, p) {
    if (!STATUSES.includes(p.status)) {
      throw new ValidationError(`Неизвестный статус: ${p.status}`);
    }
    getPlayer(state, p.seat).status = p.status;
    if (state.speaker.seat === p.seat && p.status !== 'alive') {
      state.speaker.seat = null;
    }
  },

  NOMINATE(state, p) {
    const player = getPlayer(state, p.seat);
    const v = state.voting;
    if (state.phase.kind !== 'day') {
      throw new ValidationError('Кандидатуры выставляются днём');
    }
    if (v.stage === 'done') {
      throw new ValidationError('Голосование этого дня уже завершено');
    }
    if (v.stage !== 'nominations') {
      throw new ValidationError('Голосование уже идёт');
    }
    if (player.status !== 'alive') {
      throw new ValidationError(`${playerName(state, p.seat)} не в игре`);
    }
    if (v.nominations.some((n) => n.seat === p.seat)) {
      throw new ValidationError(`${playerName(state, p.seat)} уже выставлен`);
    }
    // выставляет тот, у кого сейчас слово; один игрок — одна новая кандидатура
    const by = state.speaker.seat;
    if (by === null) {
      throw new ValidationError('Сначала выдайте слово игроку — выставляет тот, у кого слово');
    }
    if (v.nominations.some((n) => n.by === by)) {
      throw new ValidationError(`${playerName(state, by)} уже выставил кандидатуру`);
    }
    v.day = state.phase.round;
    v.nominations.push({ seat: p.seat, order: v.nominations.length + 1, votes: 0, by });
  },

  UNNOMINATE(state, p) {
    const v = state.voting;
    if (v.stage !== 'nominations') {
      throw new ValidationError('Голосование уже идёт — кандидатуру снять нельзя');
    }
    const idx = v.nominations.findIndex((n) => n.seat === p.seat);
    if (idx === -1) throw new ValidationError('Такой кандидатуры нет');
    v.nominations.splice(idx, 1);
    v.nominations.forEach((n, i) => { n.order = i + 1; });
  },

  VOTING_START(state) {
    const v = state.voting;
    if (v.nominations.length === 0) {
      throw new ValidationError('Нет кандидатур для голосования');
    }
    v.active = true;
    v.stage = 'voting';
    v.nominations.forEach((n) => { n.votes = 0; });
    // с началом голосования слово снимается
    state.speaker.seat = null;
    resetTimer(state);
  },

  SET_VOTES(state, p) {
    const v = state.voting;
    if (!v.active) throw new ValidationError('Голосование не запущено');
    const nom = v.nominations.find((n) => n.seat === p.seat);
    if (!nom) throw new ValidationError(`${playerName(state, p.seat)} не в списке кандидатур`);
    const votes = Number(p.votes);
    if (!Number.isInteger(votes) || votes < 0 || votes > 10) {
      throw new ValidationError('Число голосов должно быть от 0 до 10');
    }
    // сумма голосов не может превышать число игроков за столом
    const alive = aliveCount(state);
    const total = v.nominations.reduce((sum, n) => sum + (n.seat === p.seat ? votes : n.votes), 0);
    if (total > alive) {
      throw new ValidationError(`Сумма голосов (${total}) превышает число игроков за столом (${alive})`);
    }
    nom.votes = votes;
  },

  // Авторасчёт результата: единственный лидер уходит со стола.
  // Равенство → перестрелка между лидерами. «Поднять всех» ставится только если
  // на перестрелке голоса распределились точно так же (равенство между ВСЕМИ
  // теми же кандидатурами); если лидеров меньше — ещё одна перестрелка, и так далее.
  VOTING_FINISH(state) {
    const v = state.voting;
    if (!v.active) throw new ValidationError('Голосование не запущено');
    const max = Math.max(...v.nominations.map((n) => n.votes));
    const leaders = v.nominations.filter((n) => n.votes === max);
    if (leaders.length === 1) {
      const seat = leaders[0].seat;
      getPlayer(state, seat).status = 'voted_out';
      addVotedOut(state, v.day, [seat]);
      v.stage = 'done';
      v.active = false;
    } else if (v.stage === 'revote' && leaders.length === v.nominations.length) {
      v.stage = 'lift_all';
      v.liftAllVotes = null;
    } else {
      v.nominations = leaders.map((n, i) => ({ seat: n.seat, order: i + 1, votes: 0 }));
      v.stage = 'revote';
    }
  },

  REVOTE_START(state, p) {
    const v = state.voting;
    if (!Array.isArray(p.seats) || p.seats.length < 2) {
      throw new ValidationError('Для перестрелки нужно минимум 2 кандидатуры');
    }
    p.seats.forEach((s) => getPlayer(state, s));
    v.nominations = p.seats.map((seat, i) => ({ seat, order: i + 1, votes: 0 }));
    v.stage = 'revote';
    v.active = true;
  },

  LIFT_ALL(state, p) {
    const v = state.voting;
    if (v.stage !== 'lift_all') {
      throw new ValidationError('Сейчас нет голосования «поднять всех»');
    }
    if (p.votes !== undefined && p.votes !== null) {
      const votes = Number(p.votes);
      const alive = aliveCount(state);
      if (!Number.isInteger(votes) || votes < 0 || votes > alive) {
        throw new ValidationError(`Число голосов должно быть от 0 до ${alive}`);
      }
      v.liftAllVotes = votes;
    }
    if (p.passed) {
      const seats = v.nominations.map((n) => n.seat);
      seats.forEach((s) => { getPlayer(state, s).status = 'voted_out'; });
      addVotedOut(state, v.day, seats);
    }
    v.stage = 'done';
    v.active = false;
  },

  SET_SHOT(state, p) {
    const round = state.phase.round;
    const night = ensureNight(state, round);
    const prev = night.shot;
    const seat = p.seat === null ? null : getPlayer(state, p.seat).seat;
    // смена записанного отстрела: «воскрешаем» прежнего убитого
    if (typeof prev === 'number' && prev !== seat) {
      const prevPlayer = state.players[prev - 1];
      if (prevPlayer.status === 'killed') prevPlayer.status = 'alive';
    }
    night.shot = seat;
    if (seat !== null) {
      // условие ЛХ: убит в первую ночь и это первая смерть в игре
      if (round === 1 && state.votedOut.length === 0 && noDeathsYet(state, seat)) {
        state.bestMove.by = seat;
      }
      state.players[seat - 1].status = 'killed';
    } else if (state.bestMove.by === prev && state.bestMove.picks.length === 0) {
      state.bestMove.by = null;
    }
  },

  // Проверять можно и выбывших игроков; результат вычисляется по роли автоматически.
  // seat: null — дон/шериф никого не проверял.
  SET_DON_CHECK(state, p) {
    assertCheckerAlive(state, 'don', 'Дон');
    const night = ensureNight(state, state.phase.round);
    night.donCheck = p.seat === null
      ? null
      : { seat: getPlayer(state, p.seat).seat, found: checkResult(state, 'don', p.seat) };
  },

  SET_SHERIFF_CHECK(state, p) {
    assertCheckerAlive(state, 'sheriff', 'Шериф');
    const night = ensureNight(state, state.phase.round);
    night.sheriffCheck = p.seat === null
      ? null
      : { seat: getPlayer(state, p.seat).seat, found: checkResult(state, 'sheriff', p.seat) };
  },

  SET_BEST_MOVE(state, p) {
    if (!Array.isArray(p.picks) || p.picks.length > 3) {
      throw new ValidationError('ЛХ — до 3 номеров');
    }
    const picks = [...new Set(p.picks.map(Number))];
    picks.forEach((s) => getPlayer(state, s));
    if (p.by !== undefined && p.by !== null) getPlayer(state, p.by);
    state.bestMove = { by: p.by !== undefined ? p.by : state.bestMove.by, picks };
  },

  SET_SCORE(state, p) {
    if (state.meta.status !== 'finished') {
      throw new ValidationError('Баллы выставляются после завершения игры');
    }
    const player = getPlayer(state, p.seat);
    if (p.base !== undefined) {
      if (p.base === null) {
        player.scoreBase = null;
      } else {
        const n = Number(p.base);
        if (!Number.isFinite(n) || n < -10 || n > 10) {
          throw new ValidationError('Базовый балл должен быть числом от -10 до 10');
        }
        player.scoreBase = roundScore(n);
      }
    }
    if (p.bonus !== undefined) {
      const n = Number(p.bonus);
      if (!Number.isFinite(n) || n < -10 || n > 10) {
        throw new ValidationError('Доп.балл должен быть числом от -10 до 10');
      }
      player.scoreBonus = roundScore(n);
    }
    if (p.comment !== undefined) {
      player.comment = String(p.comment).slice(0, 300);
    }
  },

  // Заметка по игроку по ходу игры. Пишет то же поле comment, что и SET_SCORE,
  // но доступно в любом состоянии (SET_SCORE — только после finished).
  SET_COMMENT(state, p) {
    getPlayer(state, p.seat).comment = String(p.comment).slice(0, 300);
  },

  SET_OVERLAY_VISIBILITY(state, p) {
    if (!OVERLAY_KEYS.includes(p.key)) {
      throw new ValidationError(`Неизвестный элемент оверлея: ${p.key}`);
    }
    state.overlay[p.key] = !!p.value;
  },

  FINISH_GAME(state, p) {
    if (!RESULTS.includes(p.result)) {
      throw new ValidationError(`Неизвестный результат: ${p.result}`);
    }
    if (state.meta.status === 'finished') {
      throw new ValidationError('Игра уже завершена');
    }
    state.meta.status = 'finished';
    state.meta.finishedAt = new Date().toISOString();
    state.meta.result = p.result;
    state.speaker.seat = null;
    resetTimer(state);
  },

  // Служебная отметка: id игры в трекере после успешной отправки. Ставится
  // сервером (routes), не из undo. Хранится в meta, чтобы не отправить дважды.
  SET_TRACKER_GAME_ID(state, p) {
    state.meta.trackerGameId = p.trackerGameId || null;
  }
};

// Человекочитаемая подпись действия для протокола (вычисляется ДО применения)
export function labelFor(action, state) {
  const p = action.payload || {};
  const name = (seat) => playerName(state, seat);
  switch (action.type) {
    case 'NEW_GAME': return 'Новая игра';
    case 'SET_META': return 'Изменены данные игры';
    case 'SET_PLAYER': return `Игрок ${name(p.seat)}: ${p.nickname !== undefined ? `ник «${p.nickname}»` : 'фото'}`;
    case 'SWAP_SEATS': return `Пересадка: места ${p.a} ⇄ ${p.b}`;
    case 'SET_SETTINGS': return 'Изменены настройки';
    case 'SET_ROLE': return `Роль ${name(p.seat)}: ${p.role ? ROLE_LABELS[p.role] : 'снята'}`;
    case 'START_GAME': return 'Игра начата';
    case 'SET_PHASE': return `Фаза: ${p.kind === 'day' ? 'день' : 'ночь'} ${p.round}`;
    case 'NEXT_PHASE':
      return state.phase.kind === 'day'
        ? `Переход: ночь ${state.phase.round}`
        : `Переход: день ${state.phase.round + 1}`;
    case 'SET_SPEAKER': return p.seat ? `Речь: ${name(p.seat)}` : 'Речь завершена';
    case 'ADD_FOUL': return `Фол ${name(p.seat)} (${(state.players[p.seat - 1]?.fouls ?? 0) + 1}-й)`;
    case 'REMOVE_FOUL': return `Снят фол ${name(p.seat)}`;
    case 'SET_STATUS': return `Статус ${name(p.seat)}: ${STATUS_LABELS[p.status] || p.status}`;
    case 'NOMINATE': return `Выставлен ${name(p.seat)}${state.speaker.seat ? ` (от ${name(state.speaker.seat)})` : ''}`;
    case 'UNNOMINATE': return `Снята кандидатура ${name(p.seat)}`;
    case 'VOTING_START': return `Голосование, день ${state.voting.day}`;
    case 'SET_VOTES': return `Голоса за ${name(p.seat)}: ${p.votes}`;
    case 'VOTING_FINISH': return 'Итог голосования';
    case 'REVOTE_START': return `Перестрелка: ${(p.seats || []).join(', ')}`;
    case 'LIFT_ALL': return p.passed ? 'Подняли всех' : 'Все остались';
    case 'SET_SHOT': return p.seat ? `Отстрел: ${name(p.seat)} (ночь ${state.phase.round})` : `Промах (ночь ${state.phase.round})`;
    case 'SET_DON_CHECK': return p.seat ? `Проверка дона: ${name(p.seat)}` : 'Дон не проверял';
    case 'SET_SHERIFF_CHECK': return p.seat ? `Проверка шерифа: ${name(p.seat)}` : 'Шериф не проверял';
    case 'SET_BEST_MOVE': return `ЛХ: ${(p.picks || []).join(' · ') || '—'}`;
    case 'SET_SCORE': return `Баллы ${name(p.seat)}`;
    case 'FINISH_GAME': return `Игра завершена: ${RESULT_LABELS[p.result] || p.result}`;
    case 'SET_TRACKER_GAME_ID': return 'Отправлено в рейтинг';
    default: return action.type;
  }
}
