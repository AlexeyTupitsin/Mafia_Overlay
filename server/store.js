// Состояние игры в памяти + applyAction (reducer).
// Сервер — единственный источник истины: клиенты шлют действия и рендерят state.

import { randomUUID } from 'node:crypto';
import { handlers, labelFor, NOT_UNDOABLE, NOT_LOGGED, ValidationError } from './actions.js';
import * as undo from './undo.js';
import * as persistence from './persistence.js';

let state = null;
let rev = 0;
let defaults = {};
const listeners = new Set();

export function createInitialState() {
  return {
    gameId: randomUUID(),
    meta: {
      title: '',
      gameNumber: null,
      status: 'setup',
      startedAt: null,
      finishedAt: null,
      result: null,
      trackerGameId: null // id игры в трекере после отправки (защита от повтора)
    },
    settings: {
      speechSec: 60,
      shortSpeechSec: 30,
      foulSilenceAt: 3,
      foulRemoveAt: 4,
      ...defaults
    },
    phase: { kind: 'day', round: 1 },
    players: Array.from({ length: 10 }, (_, i) => ({
      seat: i + 1,
      nickname: '',
      photo: null,
      trackerId: null,   // id игрока в трекере (привязка при выборе из ростера)
      role: null,
      status: 'alive',
      fouls: 0,
      scoreBase: null,   // null = авто; число = ручное переопределение
      scoreBonus: 0,     // дополнительный балл (дробный, ±)
      comment: ''        // комментарий ведущего
    })),
    speaker: {
      seat: null,
      timer: { running: false, endsAt: null, remainingMs: 60000, durationMs: 60000 }
    },
    voting: { active: false, day: 1, stage: 'nominations', nominations: [], liftAllVotes: null },
    bestMove: { by: null, picks: [] },
    nights: [],
    votedOut: [],
    overlay: { plates: true, tracker: true, votingBar: true, timer: true, roles: true },
    log: []
  };
}

export function init(settingsDefaults = {}) {
  defaults = settingsDefaults;
  state = persistence.loadAutosave() || createInitialState();
}

export function getState() {
  return state;
}

export function getRev() {
  return rev;
}

export function getUndoDepth() {
  return undo.size();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  rev += 1;
  persistence.scheduleSave(state);
  for (const fn of listeners) fn(state, rev);
}

function logEntry(type, payload, label) {
  return { ts: new Date().toISOString(), type, payload, label };
}

export function applyAction(action) {
  if (!action || typeof action.type !== 'string') {
    throw new ValidationError('Некорректный формат действия');
  }
  const payload = action.payload || {};

  // UNDO: восстанавливаем верхний снапшот; записи протокола не удаляются,
  // а помечаются как отменённые (протокол честный)
  if (action.type === 'UNDO') {
    const snap = undo.pop();
    if (!snap) throw new ValidationError('Нечего отменять');
    const log = state.log.map((entry, i) =>
      i >= snap.logIndex ? { ...entry, undone: true } : entry
    );
    log.push(logEntry('UNDO', {}, `Отмена: ${snap.label}`));
    state = snap.state;
    state.log = log;
    emit();
    return;
  }

  const handler = handlers[action.type];
  if (!handler) throw new ValidationError(`Неизвестное действие: ${action.type}`);

  // подпись вычисляется ДО мутации (по текущим никам/фазе)
  const label = labelFor({ type: action.type, payload }, state);

  // обработчик работает с копией — при ошибке состояние не меняется
  const next = structuredClone(state);
  const ctx = { createInitialState };
  const replaced = handler(next, payload, ctx);

  if (!NOT_UNDOABLE.has(action.type)) {
    undo.push({ state: structuredClone(state), logIndex: state.log.length, label });
  }

  if (action.type === 'NEW_GAME' && state.meta.status !== 'setup') {
    persistence.archiveGame(state); // не теряем предыдущую игру
  }

  state = replaced || next;

  if (!NOT_LOGGED.has(action.type)) {
    state.log.push(logEntry(action.type, payload, label));
  }

  if (action.type === 'FINISH_GAME') {
    persistence.archiveGame(state);
  }

  if (action.type === 'SET_SCORE') {
    persistence.archiveGame(state); // баллы вводятся после finish — обновляем архив
  }

  if (action.type === 'SET_TRACKER_GAME_ID') {
    persistence.archiveGame(state); // отметка отправки — обновляем архив
  }

  emit();
}
