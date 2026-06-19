// REST API: загрузка фото, справочник игроков, архив игр, экспорт протокола

import express from 'express';
import multer from 'multer';
import * as persistence from './persistence.js';
import * as images from './images.js';
import * as tracker from './tracker.js';
import * as store from './store.js';
import { displayBase, totalScore } from '../public/shared/constants.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Допустимы только JPG/PNG'));
  }
});

const RESULT_LABELS = {
  city_win: 'Победа мирных',
  mafia_win: 'Победа мафии',
  draw: 'Ничья'
};
const ROLE_LABELS = { civilian: 'Мирный', mafia: 'Мафия', don: 'Дон', sheriff: 'Шериф' };
const STATUS_LABELS = { alive: 'В игре', voted_out: 'Заголосован', killed: 'Убит', removed: 'Удалён' };

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function createRouter() {
  const router = express.Router();

  // Фото игрока: ресайз до 600 px по большей стороне, сохранение в uploads/
  router.post('/upload', upload.single('photo'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Файл не получен (поле photo)' });
      const url = await images.saveImageBuffer(req.file.buffer);
      res.json({ url });
    } catch (err) {
      console.error('[upload]', err.message);
      res.status(500).json({ error: 'Не удалось обработать изображение' });
    }
  });

  router.get('/roster', (req, res) => {
    res.json(persistence.loadRoster());
  });

  router.post('/roster', (req, res) => {
    const entry = persistence.upsertRosterPlayer(req.body || {});
    if (!entry) return res.status(400).json({ error: 'Нужен непустой ник' });
    res.json(entry);
  });

  router.get('/games', (req, res) => {
    res.json(persistence.listGames());
  });

  router.get('/games/:id', (req, res) => {
    const game = persistence.getGame(req.params.id);
    if (!game) return res.status(404).json({ error: 'Игра не найдена' });
    res.json(game);
  });

  // --- интеграция с трекером рейтинга -----------------------------------
  // Панель спрашивает статус, чтобы решить, показывать ли кнопку импорта.
  router.get('/tracker/status', (req, res) => {
    res.json({ enabled: tracker.isEnabled() });
  });

  // Импорт игроков трекера в ростер: ник + аватар + trackerId (для будущей
  // отправки игр). Существующие локальные фото не затираются, если у игрока
  // в трекере нет аватара.
  router.post('/tracker/import-players', async (req, res) => {
    if (!tracker.isEnabled()) {
      return res.status(503).json({ error: 'Интеграция с рейтингом не настроена' });
    }
    try {
      const players = await tracker.getPlayers();
      let photos = 0;
      let photosFailed = 0;
      for (const p of players) {
        // аватар скачиваем локально в uploads/ — надёжнее для OBS, чем внешний
        // URL Supabase. Не скачалось → пропускаем фото, импорт не прерывается.
        let photo;
        if (p.avatarUrl) {
          try {
            photo = await images.downloadAndSaveAvatar(p.avatarUrl);
            photos += 1;
          } catch (e) {
            console.error('[tracker] аватар не скачан:', p.nickname, e.message);
            photosFailed += 1;
          }
        }
        persistence.upsertRosterPlayer({
          nickname: p.nickname,
          photo, // undefined → не трогаем существующее фото в ростере
          trackerId: p.id
        });
      }
      res.json({ imported: players.length, photos, photosFailed });
    } catch (err) {
      console.error('[tracker] import-players', err.message);
      res.status(502).json({ error: `Трекер недоступен: ${err.message}` });
    }
  });

  // Отправка завершённой игры в трекер: турнир find-or-create, номер игры =
  // max в сезоне + 1, затем games + game_players. Любая ошибка проверки →
  // 400 с конкретным текстом, состояние не меняется.
  router.post('/tracker/send-game', async (req, res) => {
    if (!tracker.isEnabled()) {
      return res.status(503).json({ error: 'Интеграция с рейтингом не настроена' });
    }
    const force = !!(req.body && req.body.force);
    try {
      const state = store.getState();
      if (state.meta.status !== 'finished' || !state.meta.result) {
        return res.status(400).json({ error: 'Игра не завершена' });
      }
      if (state.meta.trackerGameId && !force) {
        return res.status(409).json({ error: 'Игра уже отправлена в рейтинг' });
      }

      // полнота мест: ник, роль, привязка к трекеру
      const incomplete = state.players.filter((pl) => !pl.nickname || !pl.nickname.trim() || !pl.role);
      if (incomplete.length) {
        const seats = incomplete.map((pl) => pl.seat).join(', ');
        return res.status(400).json({ error: `Не у всех игроков заполнены ник и роль (места: ${seats})` });
      }
      const unlinked = state.players.filter((pl) => !pl.trackerId).map((pl) => pl.nickname);
      if (unlinked.length) {
        return res.status(400).json({
          error: `Не привязаны к трекеру: ${unlinked.join(', ')} — выберите из рейтинга или импортируйте`
        });
      }
      // один и тот же игрок не может занимать два места (иначе нарушит unique в трекере)
      const ids = state.players.map((pl) => pl.trackerId);
      const dupId = ids.find((id, i) => ids.indexOf(id) !== i);
      if (dupId) {
        const names = state.players.filter((pl) => pl.trackerId === dupId).map((pl) => pl.nickname);
        return res.status(400).json({ error: `Один игрок выбран на два места: ${names.join(', ')}` });
      }

      // защита от игроков, удалённых в трекере после импорта
      const trackerPlayers = await tracker.getPlayers();
      const known = new Set(trackerPlayers.map((pl) => pl.id));
      const gone = state.players.filter((pl) => !known.has(pl.trackerId)).map((pl) => pl.nickname);
      if (gone.length) {
        return res.status(400).json({ error: `Нет в трекере (удалены?): ${gone.join(', ')}` });
      }

      const season = await tracker.getActiveSeason();
      if (!season) {
        return res.status(400).json({ error: 'В трекере нет активного сезона — создайте его' });
      }

      // турнир: find-or-create по (название + дата завершения); без названия — без турнира
      const title = (state.meta.title || '').trim();
      const date = String(state.meta.finishedAt).slice(0, 10); // YYYY-MM-DD
      let tournamentId = null;
      if (title) {
        tournamentId = await tracker.findTournament(season.id, title, date)
          || await tracker.createTournament(season.id, title, date);
      }

      const gameNumber = (await tracker.getMaxGameNumber(season.id)) + 1;
      const { game, gamePlayers } = tracker.buildGamePayload(state, season.id, tournamentId, gameNumber);
      const gameRow = await tracker.createGame(game);
      await tracker.createGamePlayers(gamePlayers.map((r) => ({ ...r, game_id: gameRow.id })));

      store.applyAction({ type: 'SET_TRACKER_GAME_ID', payload: { trackerGameId: gameRow.id } });
      res.json({ ok: true, gameNumber, seasonName: season.name });
    } catch (err) {
      console.error('[tracker] send-game', err.message);
      res.status(502).json({ error: `Трекер недоступен: ${err.message}` });
    }
  });

  // Человекочитаемый протокол (печатная страница)
  router.get('/games/:id/protocol', (req, res) => {
    const game = persistence.getGame(req.params.id);
    if (!game) return res.status(404).send('Игра не найдена');
    res.type('html').send(renderProtocol(game));
  });

  router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    res.status(400).json({ error: err.message });
  });

  return router;
}

function renderProtocol(game) {
  const m = game.meta;
  const fmt = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU') : '—');

  const playersRows = game.players.map((p) => `
    <tr>
      <td>${p.seat}</td>
      <td>${esc(p.nickname) || '—'}</td>
      <td class="role-${p.role || 'none'}">${ROLE_LABELS[p.role] || '—'}</td>
      <td>${STATUS_LABELS[p.status] || p.status}</td>
      <td>${p.fouls}</td>
    </tr>`).join('');

  const nightsRows = game.nights.map((n) => `
    <tr>
      <td>Ночь ${n.night}</td>
      <td>${n.shot === null ? 'промах' : (typeof n.shot === 'number' ? `№${n.shot}` : '—')}</td>
      <td>${n.donCheck ? `№${n.donCheck.seat} — ${n.donCheck.found ? 'шериф ✓' : 'не шериф ✗'}` : '—'}</td>
      <td>${n.sheriffCheck ? `№${n.sheriffCheck.seat} — ${n.sheriffCheck.found ? 'чёрный ✓' : 'красный ✗'}` : '—'}</td>
    </tr>`).join('');

  const votedRows = game.votedOut.map((v) =>
    `<tr><td>День ${v.day}</td><td>${v.seats.map((s) => `№${s}`).join(', ') || '—'}</td></tr>`).join('');

  const fmtScore = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  const scoreRows = game.players.map((p) => {
    const base = displayBase(p, m.result);
    const bonus = p.scoreBonus || 0;
    return `
    <tr>
      <td>${p.seat}</td>
      <td>${esc(p.nickname) || '—'}</td>
      <td>${fmtScore(base)}</td>
      <td>${bonus ? (bonus > 0 ? '+' : '') + fmtScore(bonus) : '—'}</td>
      <td><b>${fmtScore(totalScore(p, m.result))}</b></td>
      <td>${esc(p.comment) || ''}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Протокол — ${esc(m.title) || 'Игра'}${m.gameNumber ? ` №${m.gameNumber}` : ''}</title>
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; max-width: 860px; margin: 24px auto; padding: 0 16px; color: #1a1a1a; }
  h1 { font-size: 24px; margin-bottom: 4px; }
  h2 { font-size: 17px; margin: 28px 0 8px; border-bottom: 2px solid #ddd; padding-bottom: 4px; }
  .meta { color: #555; margin-bottom: 8px; }
  .result { font-size: 18px; font-weight: 700; margin: 8px 0 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { border: 1px solid #ccc; padding: 5px 9px; text-align: left; }
  th { background: #f2f2f2; }
  .role-mafia { color: #444; font-weight: 700; }
  .role-don { color: #7d3fbf; font-weight: 700; }
  .role-sheriff { color: #b8860b; font-weight: 700; }
  .role-civilian { color: #c0392b; }
  .toolbar { margin: 12px 0; }
  .toolbar button { padding: 6px 14px; font-size: 14px; cursor: pointer; }
  @media print { .toolbar { display: none; } body { margin: 0; } }
</style>
</head>
<body>
  <h1>${esc(m.title) || 'Игра'}${m.gameNumber ? ` — игра №${m.gameNumber}` : ''}</h1>
  <div class="meta">Начало: ${fmt(m.startedAt)} · Завершение: ${fmt(m.finishedAt)}</div>
  <div class="result">${RESULT_LABELS[m.result] || 'Игра не завершена'}</div>
  <div class="toolbar">
    <button onclick="window.print()">Печать</button>
    <button onclick="location.href='/api/games/${esc(game.gameId)}'">Скачать JSON</button>
  </div>

  <h2>Игроки</h2>
  <table><tr><th>№</th><th>Ник</th><th>Роль</th><th>Итоговый статус</th><th>Фолы</th></tr>${playersRows}</table>

  <h2>Лучший ход</h2>
  <p>${game.bestMove && game.bestMove.by
    ? `Игрок №${game.bestMove.by}: ${game.bestMove.picks.map((s) => `№${s}`).join(' · ') || '—'}`
    : '—'}</p>

  <h2>Ночи</h2>
  ${game.nights.length ? `<table><tr><th></th><th>Отстрел</th><th>Проверка дона</th><th>Проверка шерифа</th></tr>${nightsRows}</table>` : '<p>—</p>'}

  <h2>Заголосованные</h2>
  ${game.votedOut.length ? `<table><tr><th>День</th><th>Покинули стол</th></tr>${votedRows}</table>` : '<p>—</p>'}

  <h2>Итоговые баллы</h2>
  <table><tr><th>№</th><th>Ник</th><th>Базовый</th><th>Доп</th><th>Итог</th><th>Комментарий</th></tr>${scoreRows}</table>
</body>
</html>`;
}
