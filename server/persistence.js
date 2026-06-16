// Автосейв/загрузка data/autosave.json, архив игр, справочник игроков.
// Запись атомарная: temp-файл + rename, debounce 300 мс.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const GAMES_DIR = path.join(DATA_DIR, 'games');
export const UPLOADS_DIR = path.join(ROOT, 'uploads');
const AUTOSAVE_FILE = path.join(DATA_DIR, 'autosave.json');
const ROSTER_FILE = path.join(DATA_DIR, 'players.json');

const SAVE_DEBOUNCE_MS = 300;

export function ensureDirs() {
  for (const dir of [DATA_DIR, GAMES_DIR, UPLOADS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function atomicWrite(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// --- автосейв -------------------------------------------------------------

let saveTimer = null;
let pendingState = null;

export function scheduleSave(state) {
  pendingState = state;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow(pendingState);
  }, SAVE_DEBOUNCE_MS);
}

export function saveNow(state) {
  if (!state) return;
  try {
    atomicWrite(AUTOSAVE_FILE, JSON.stringify(state));
  } catch (err) {
    console.error('[persistence] Ошибка автосейва:', err.message);
  }
}

export function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveNow(pendingState);
}

// Восстановление при старте: поднимаем autosave, в том числе завершённую игру
// (ведущий сам начнёт новую) — главное не потерять данные
export function loadAutosave() {
  const state = readJson(AUTOSAVE_FILE);
  if (state && state.gameId && state.meta && Array.isArray(state.players)) {
    return state;
  }
  return null;
}

// --- архив игр -------------------------------------------------------------

export function archiveGame(state) {
  try {
    atomicWrite(path.join(GAMES_DIR, `${state.gameId}.json`), JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[persistence] Ошибка записи архива:', err.message);
  }
}

export function listGames() {
  let files = [];
  try {
    files = fs.readdirSync(GAMES_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const games = [];
  for (const file of files) {
    const game = readJson(path.join(GAMES_DIR, file));
    if (!game || !game.meta) continue;
    games.push({
      id: game.gameId,
      title: game.meta.title,
      gameNumber: game.meta.gameNumber,
      startedAt: game.meta.startedAt,
      finishedAt: game.meta.finishedAt,
      result: game.meta.result,
      status: game.meta.status
    });
  }
  games.sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')));
  return games;
}

export function getGame(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
  return readJson(path.join(GAMES_DIR, `${id}.json`));
}

// --- сборка мусора в uploads/ ------------------------------------------------
// Фото, на которые больше никто не ссылается (заменены или остались от старых
// игр), копятся в uploads/ и засоряют диск. Чистим ОДИН раз при старте сервера —
// в этот момент клиентов ещё нет, значит нет гонки с только что загруженным,
// но ещё не сохранённым в autosave фото.

const UPLOAD_REF = /\/uploads\/([A-Za-z0-9._-]+)/g;

function collectReferencedPhotos() {
  const referenced = new Set();
  const files = [AUTOSAVE_FILE, ROSTER_FILE];
  try {
    for (const f of fs.readdirSync(GAMES_DIR)) {
      if (f.endsWith('.json')) files.push(path.join(GAMES_DIR, f));
    }
  } catch { /* нет архива — не страшно */ }

  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(UPLOAD_REF)) referenced.add(m[1]);
  }
  return referenced;
}

export function cleanupUploads() {
  let files;
  try {
    files = fs.readdirSync(UPLOADS_DIR);
  } catch {
    return;
  }
  const referenced = collectReferencedPhotos();
  let removed = 0;
  for (const name of files) {
    if (referenced.has(name)) continue;
    try {
      fs.unlinkSync(path.join(UPLOADS_DIR, name));
      removed += 1;
    } catch (err) {
      console.error('[persistence] Не удалить файл uploads:', name, err.message);
    }
  }
  if (removed) console.log(`[persistence] Удалено неиспользуемых фото: ${removed}`);
}

// --- справочник игроков ------------------------------------------------------

export function loadRoster() {
  return readJson(ROSTER_FILE) || [];
}

export function upsertRosterPlayer({ nickname, photo, trackerId }) {
  const nick = String(nickname || '').trim().slice(0, 40);
  if (!nick) return null;
  const roster = loadRoster();
  let entry = roster.find((r) => r.nickname.toLowerCase() === nick.toLowerCase());
  if (entry) {
    // undefined-поля не трогаем: ручное сохранение ника не сотрёт фото/привязку
    if (photo !== undefined) entry.photo = photo || null;
    if (trackerId !== undefined) entry.trackerId = trackerId || null;
    entry.nickname = nick;
  } else {
    entry = { nickname: nick, photo: photo || null, trackerId: trackerId || null };
    roster.push(entry);
  }
  roster.sort((a, b) => a.nickname.localeCompare(b.nickname, 'ru'));
  try {
    atomicWrite(ROSTER_FILE, JSON.stringify(roster, null, 2));
  } catch (err) {
    console.error('[persistence] Ошибка записи справочника:', err.message);
  }
  return entry;
}
