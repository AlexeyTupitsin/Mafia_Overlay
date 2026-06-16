// Панель ведущего: отправляет действия на сервер и рендерит присланный state.

import { connectWS } from '/shared/ws-client.js';
import { ROLES, STATUSES, RESULTS, OVERLAY_KEYS, displayBase, totalScore } from '/shared/constants.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let state = null;
let undoDepth = 0;
let clients = { control: 0, overlay: 0 };
let roster = [];
let clockOffset = 0;                 // serverNow − Date.now(): поправка часов устройства

// локальное состояние интерфейса (не синхронизируется)
let statusMenuSeat = null;          // открытый попап статуса
let heldBlocks = new Set();         // секретные блоки, раскрытые удержанием
let peekRoles = new Set();          // роли игроков, раскрытые удержанием
let winDismissedKey = null;         // отложенный баннер победы (ключ ситуации)
let swapFrom = null;                // первое место для пересадки
let uploadSeat = null;              // место, для которого выбирается фото
let bmBannerDismissed = false;
let setupBuilt = false;
let trackerEnabled = false;          // интеграция с трекером настроена на сервере
const setupRows = [];

// ---------------------------------------------------------------- связь

const ws = connectWS({
  role: 'control',
  onState(s, msg) {
    state = s;
    undoDepth = msg.undoDepth ?? 0;
    clients = msg.clients || clients;
    // разница часов сервера и устройства (на LAN задержкой сети пренебрегаем)
    if (typeof msg.serverNow === 'number') clockOffset = msg.serverNow - Date.now();
    render();
  },
  onStatus(online) {
    $('#conn-ind').classList.toggle('online', online);
    if (!online) $('#conn-text').textContent = 'нет связи';
  },
  onError(message) {
    toast(message);
  }
});

function send(type, payload) {
  if (!ws.send({ type, payload })) toast('Нет соединения с сервером');
}

// высота шапки → CSS-переменная, чтобы sticky-баннер ЛХ вставал точно под ней
// (на мобильном шапка переносится и её высота меняется)
function syncTopbarHeight() {
  const h = $('#topbar').offsetHeight;
  document.documentElement.style.setProperty('--topbar-h', `${h}px`);
}
window.addEventListener('resize', syncTopbarHeight);
syncTopbarHeight();

// ---------------------------------------------------------------- тосты и звук

function toast(message, type = 'error') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

let audioCtx = null;
document.addEventListener('pointerdown', () => {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* без звука */ }
  }
}, { once: true });

function beep(freq, durationSec) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.frequency.value = freq;
  osc.type = 'sine';
  gain.gain.value = 0.25;
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + durationSec);
  osc.stop(audioCtx.currentTime + durationSec);
}

// ---------------------------------------------------------------- таймер

let lastTimerSec = Infinity;

function timerRemainingMs() {
  const t = state.speaker.timer;
  // endsAt считается серверными часами — сравниваем с серверным временем устройства
  return t.running && t.endsAt ? Math.max(0, t.endsAt - (Date.now() + clockOffset)) : t.remainingMs;
}

function tickTimer() {
  if (state) {
    const t = state.speaker.timer;
    const ms = timerRemainingMs();
    const sec = Math.ceil(ms / 1000);
    const disp = $('#timer-display');
    disp.textContent = sec >= 60 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : String(sec);
    disp.classList.toggle('low', t.running && ms <= 10000);
    if (t.running) {
      if (lastTimerSec > 10 && sec <= 10) beep(880, 0.15); // сигнал за 10 сек
      if (lastTimerSec > 0 && sec <= 0) beep(440, 0.6);    // время вышло
      lastTimerSec = sec;
    } else {
      lastTimerSec = Infinity;
    }
  }
  requestAnimationFrame(tickTimer);
}
requestAnimationFrame(tickTimer);

$('#btn-timer-60').onclick = () => send('TIMER_START', { durationMs: state.settings.speechSec * 1000 });
$('#btn-timer-30').onclick = () => send('TIMER_START', { durationMs: state.settings.shortSpeechSec * 1000 });
$('#btn-timer-toggle').onclick = () => {
  if (state.speaker.timer.running) send('TIMER_PAUSE');
  else send('TIMER_START');
};
$('#btn-timer-reset').onclick = () => send('TIMER_RESET');

// ---------------------------------------------------------------- шапка

$('#btn-next-phase').onclick = () => send('NEXT_PHASE');
$('#btn-undo').onclick = () => send('UNDO');

$('#btn-menu').onclick = (e) => {
  e.stopPropagation();
  const menu = $('#menu-popover');
  menu.hidden = !menu.hidden;
  if (!menu.hidden) renderMenuToggles();
};
document.addEventListener('click', (e) => {
  if (!$('#menu-popover').hidden && !e.target.closest('#menu-popover')) {
    $('#menu-popover').hidden = true;
  }
});

function renderMenuToggles() {
  const box = $('#menu-overlay-toggles');
  box.querySelectorAll('.menu-toggle').forEach((el) => el.remove());
  for (const [key, label] of Object.entries(OVERLAY_KEYS)) {
    const row = document.createElement('label');
    row.className = 'menu-toggle';
    row.innerHTML = `<span>${label}</span><input type="checkbox" ${state.overlay[key] ? 'checked' : ''}>`;
    row.querySelector('input').onchange = (e) => {
      send('SET_OVERLAY_VISIBILITY', { key, value: e.target.checked });
    };
    box.appendChild(row);
  }
}

$('#mi-best-move').onclick = () => { $('#menu-popover').hidden = true; openBestMoveModal(); };
$('#mi-settings').onclick = () => { $('#menu-popover').hidden = true; openSettingsModal(); };
$('#mi-archive').onclick = () => { $('#menu-popover').hidden = true; openArchiveModal(); };
$('#mi-new-game').onclick = () => { $('#menu-popover').hidden = true; openNewGameModal(); };
$('#mi-finish').onclick = () => { $('#menu-popover').hidden = true; openFinishModal(); };

// ---------------------------------------------------------------- модальные окна

function openModal(title, bodyHtml, actions) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  const box = $('#modal-actions');
  box.innerHTML = '';
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.className = `btn ${a.cls || ''}`;
    btn.textContent = a.label;
    btn.onclick = a.onClick;
    box.appendChild(btn);
  }
  $('#modal-backdrop').hidden = false;
}

function closeModal() {
  $('#modal-backdrop').hidden = true;
}

$('#modal-backdrop').addEventListener('click', (e) => {
  if (e.target === $('#modal-backdrop')) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeModal(); $('#menu-popover').hidden = true; }
});

function openSettingsModal() {
  const s = state.settings;
  openModal('Настройки', `
    <div class="settings-grid">
      <span>Основная речь, сек</span><input type="number" id="set-speech" min="10" max="600" value="${s.speechSec}">
      <span>Короткая речь, сек</span><input type="number" id="set-short" min="5" max="600" value="${s.shortSpeechSec}">
      <span>Фол «без речи» (номер фола)</span><input type="number" id="set-silence" min="1" max="10" value="${s.foulSilenceAt}">
      <span>Фол «удаление» (номер фола)</span><input type="number" id="set-remove" min="1" max="10" value="${s.foulRemoveAt}">
    </div>`, [
    { label: 'Отмена', onClick: closeModal },
    {
      label: 'Сохранить', cls: 'btn-accent', onClick: () => {
        send('SET_SETTINGS', {
          speechSec: Number($('#set-speech').value),
          shortSpeechSec: Number($('#set-short').value),
          foulSilenceAt: Number($('#set-silence').value),
          foulRemoveAt: Number($('#set-remove').value)
        });
        closeModal();
      }
    }
  ]);
}

function openNewGameModal() {
  openModal('Новая игра', `
    <p style="margin:8px 0">
      <label style="display:flex;align-items:center;gap:10px;font-size:16px">
        <input type="checkbox" id="ng-carry" checked style="width:22px;height:22px">
        Перенести ники и фото из текущей игры
      </label>
    </p>
    <div class="settings-grid">
      <span>Название</span><input type="text" id="ng-title" value="${esc(state.meta.title)}">
      <span>Номер игры</span><input type="number" id="ng-number" min="1" value="${(state.meta.gameNumber || 0) + 1}">
    </div>
    <p class="bp-hint">Текущая игра будет сохранена в архив.</p>`, [
    { label: 'Отмена', onClick: closeModal },
    {
      label: 'Создать', cls: 'btn-accent', onClick: () => {
        bmBannerDismissed = false;
        winDismissedKey = null;
        setupBuilt = false;
        send('NEW_GAME', {
          carryPlayers: $('#ng-carry').checked,
          title: $('#ng-title').value,
          gameNumber: Number($('#ng-number').value) || null
        });
        closeModal();
      }
    }
  ]);
}

function openFinishModal() {
  openModal('Завершить игру', `<div class="result-buttons">
      <button class="btn" data-result="city_win">🔴 Победа мирных</button>
      <button class="btn" data-result="mafia_win">⚫ Победа мафии</button>
      <button class="btn" data-result="draw">⚪ Ничья</button>
    </div>`, [{ label: 'Отмена', onClick: closeModal }]);
  $('#modal-body').querySelectorAll('[data-result]').forEach((btn) => {
    btn.onclick = () => { send('FINISH_GAME', { result: btn.dataset.result }); closeModal(); };
  });
}

async function openArchiveModal() {
  openModal('Архив игр', '<p class="bp-hint">Загрузка…</p>', [{ label: 'Закрыть', onClick: closeModal }]);
  try {
    const games = await (await fetch('/api/games')).json();
    $('#modal-body').innerHTML = games.length
      ? games.map((g) => `
        <div class="archive-item">
          <div class="ai-info">
            <div class="ai-title">${esc(g.title) || 'Без названия'}${g.gameNumber ? ` — игра №${g.gameNumber}` : ''}</div>
            <div class="ai-sub">${g.finishedAt ? new Date(g.finishedAt).toLocaleString('ru-RU') : 'не завершена'} · ${RESULTS[g.result] || '—'}</div>
          </div>
          <a class="btn" href="/api/games/${g.id}/protocol" target="_blank">Протокол</a>
          <a class="btn" href="/api/games/${g.id}" target="_blank">JSON</a>
        </div>`).join('')
      : '<p class="bp-hint" style="padding:10px 0">Архив пуст — завершённые игры появятся здесь.</p>';
  } catch {
    $('#modal-body').innerHTML = '<p class="bp-hint">Не удалось загрузить архив.</p>';
  }
}

function openBestMoveModal() {
  const by = state.bestMove.by;
  const picks = new Set(state.bestMove.picks);
  const buttons = state.players
    .filter((p) => p.status === 'alive')
    .map((p) => `<button class="btn ${picks.has(p.seat) ? 'sel' : ''}" data-bm="${p.seat}">${p.seat}${p.nickname ? `<br><small>${esc(p.nickname)}</small>` : ''}</button>`)
    .join('');
  openModal(`Лучший ход${by ? ` — игрок №${by}` : ''}`, `
    <p class="bp-hint">До 3 номеров подозреваемых. Выбрано: <b id="bm-count">${picks.size}</b></p>
    <div class="bm-grid">${buttons}</div>`, [
    { label: 'Отмена', onClick: closeModal },
    {
      label: 'Сохранить ЛХ', cls: 'btn-accent', onClick: () => {
        send('SET_BEST_MOVE', { by, picks: [...picks] });
        bmBannerDismissed = true;
        closeModal();
      }
    }
  ]);
  $('#modal-body').querySelectorAll('[data-bm]').forEach((btn) => {
    btn.onclick = () => {
      const seat = Number(btn.dataset.bm);
      if (picks.has(seat)) picks.delete(seat);
      else if (picks.size < 3) picks.add(seat);
      btn.classList.toggle('sel', picks.has(seat));
      $('#bm-count').textContent = picks.size;
    };
  });
}

function openRemoveAtFoulModal(seat) {
  const p = state.players[seat - 1];
  openModal(`4-й фол — №${seat} ${esc(p.nickname)}`, '<p style="margin:8px 0">Игрок получил лимит фолов и должен быть удалён из игры.</p>', [
    { label: 'Оставить', onClick: closeModal },
    {
      label: 'Удалить игрока', cls: 'btn-danger', onClick: () => {
        send('SET_STATUS', { seat, status: 'removed' });
        closeModal();
      }
    }
  ]);
}

// ---------------------------------------------------------------- сетка игроков

const grid = $('#players-grid');

grid.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) {
    if (!e.target.closest('.status-pop')) { statusMenuSeat = null; render(); }
    return;
  }
  const seat = Number(btn.dataset.seat);
  switch (btn.dataset.act) {
    case 'speaker': {
      const next = state.speaker.seat === seat ? null : seat;
      send('SET_SPEAKER', { seat: next });
      // при выдаче слова автоматически запускаем таймер речи (60 сек)
      if (next !== null) send('TIMER_START', { durationMs: state.settings.speechSec * 1000 });
      break;
    }
    case 'foul-add': {
      send('ADD_FOUL', { seat });
      if (state.players[seat - 1].fouls + 1 >= state.settings.foulRemoveAt) {
        openRemoveAtFoulModal(seat);
      }
      break;
    }
    case 'foul-del':
      send('REMOVE_FOUL', { seat });
      break;
    case 'nominate':
      send('NOMINATE', { seat });
      break;
    case 'status-menu':
      statusMenuSeat = statusMenuSeat === seat ? null : seat;
      render();
      break;
    case 'set-status':
      send('SET_STATUS', { seat, status: btn.dataset.status });
      statusMenuSeat = null;
      break;
  }
});

// удержание кнопки «роль» — показать роль игрока, пока кнопка зажата
grid.addEventListener('pointerdown', (e) => {
  const btn = e.target.closest('[data-act="peek-role"]');
  if (btn) { peekRoles.add(Number(btn.dataset.seat)); render(); }
});

document.addEventListener('pointerup', () => {
  if (heldBlocks.size) { heldBlocks.clear(); render(); }
  if (peekRoles.size) { peekRoles.clear(); render(); }
});

// Список игроков (роли на панели не отображаются нигде)
function renderPlayersList() {
  const { foulSilenceAt, foulRemoveAt } = state.settings;
  // выставляет тот, у кого слово; один спикер — одна новая кандидатура
  const v = state.voting;
  const speaker = state.speaker.seat;
  const nominatedSeats = new Set(v.nominations.map((n) => n.seat));
  const speakerCanNominate = state.phase.kind === 'day' && v.stage === 'nominations'
    && speaker !== null && !v.nominations.some((n) => n.by === speaker);
  grid.innerHTML = state.players.map((p) => {
    const out = p.status !== 'alive';
    const speaking = state.speaker.seat === p.seat;
    const silence = !out && p.fouls >= foulSilenceAt && p.fouls < foulRemoveAt;
    const peek = peekRoles.has(p.seat);
    const roleText = p.role ? ROLES[p.role].label : 'роль не назначена';
    const statusText = peek
      ? roleText
      : out
        ? STATUSES[p.status].label
        : silence ? `${p.fouls} фола — без речи` : '';
    const dots = [1, 2, 3, 4].map((f) =>
      `<span class="fdot ${f <= p.fouls ? `on${f >= foulRemoveAt ? ' last' : ''}` : ''}"></span>`).join('');
    const statusPop = statusMenuSeat === p.seat ? `
      <div class="status-pop">
        ${Object.entries(STATUSES).map(([key, st]) =>
          `<button class="btn ${p.status === key ? 'active' : ''}" data-act="set-status" data-seat="${p.seat}" data-status="${key}">${st.label}</button>`).join('')}
      </div>` : '';
    return `
      <div class="prow ${out ? 'out' : ''} ${speaking ? 'speaking' : ''}">
        <span class="prow-num">${p.seat}</span>
        <div class="prow-photo" style="${p.photo ? `background-image:url('${p.photo}')` : ''}"></div>
        <div class="prow-main">
          <span class="prow-nick">${esc(p.nickname) || '—'}</span>
          ${statusText ? `<span class="prow-status ${peek ? 'role' : (out || silence ? 'bad' : '')}">${statusText}</span>` : ''}
        </div>
        <div class="prow-fouls">
          <button class="btn btn-foul" data-act="foul-del" data-seat="${p.seat}" ${p.fouls === 0 ? 'disabled' : ''}>−</button>
          <span class="fdots">${dots}</span>
          <button class="btn btn-foul" data-act="foul-add" data-seat="${p.seat}" ${p.fouls >= foulRemoveAt ? 'disabled' : ''}>+</button>
        </div>
        <div class="prow-actions">
          <button class="btn ${speaking ? 'active' : ''}" data-act="speaker" data-seat="${p.seat}" ${out ? 'disabled' : ''}>🎙 Слово</button>
          <button class="btn" data-act="nominate" data-seat="${p.seat}" ${out || !speakerCanNominate || nominatedSeats.has(p.seat) ? 'disabled' : ''} title="${speaker === null ? 'Сначала выдайте слово' : ''}">☝ Выставить</button>
          <button class="btn btn-peek" data-act="peek-role" data-seat="${p.seat}" title="Удерживайте, чтобы увидеть роль">🎭</button>
          <button class="btn" data-act="status-menu" data-seat="${p.seat}">⋮</button>
        </div>
        ${statusPop}
      </div>`;
  }).join('');
}

// ---------------------------------------------------------------- нижняя панель

const bottom = $('#bottom-panel');

bottom.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-bact]');
  if (!btn) return;
  const seat = Number(btn.dataset.seat);
  switch (btn.dataset.bact) {
    case 'unnominate': send('UNNOMINATE', { seat }); break;
    case 'voting-start': send('VOTING_START'); break;
    case 'set-votes': send('SET_VOTES', { seat, votes: Number(btn.dataset.votes) }); break;
    case 'voting-finish': send('VOTING_FINISH'); break;
    case 'lift-yes': send('LIFT_ALL', { passed: true }); break;
    case 'lift-no': send('LIFT_ALL', { passed: false }); break;
    case 'shot': send('SET_SHOT', { seat: btn.dataset.seat === 'miss' ? null : seat }); break;
    case 'check-seat': {
      // клик по номеру сразу записывает проверку; повторный клик по тому же — снимает
      const who = btn.dataset.who;
      const night = state.nights[state.phase.round - 1];
      const recorded = night && night[who === 'don' ? 'donCheck' : 'sheriffCheck'];
      const next = recorded && recorded.seat === seat ? null : seat;
      send(who === 'don' ? 'SET_DON_CHECK' : 'SET_SHERIFF_CHECK', { seat: next });
      break;
    }
    case 'check-none':
      send(btn.dataset.who === 'don' ? 'SET_DON_CHECK' : 'SET_SHERIFF_CHECK', { seat: null });
      break;
    case 'best-move': openBestMoveModal(); break;
  }
});

bottom.addEventListener('pointerdown', (e) => {
  const cover = e.target.closest('.hold-cover');
  if (cover) {
    heldBlocks.add(cover.dataset.block);
    render();
  }
});

function seatButtons(attr, who, selectedSeat, includeDead = false) {
  return state.players.map((p) => {
    const dead = p.status !== 'alive';
    return `<button class="btn ${selectedSeat === p.seat ? 'sel' : ''} ${dead ? 'dead' : ''}"
      data-bact="${attr}" ${who ? `data-who="${who}"` : ''} data-seat="${p.seat}"
      ${dead && !includeDead ? 'disabled' : ''}>${p.seat}</button>`;
  }).join('');
}

function nomName(seat) {
  const p = state.players[seat - 1];
  return `№${seat}${p.nickname ? ` ${esc(p.nickname)}` : ''}`;
}

function renderBottomPanel() {
  if (state.phase.kind === 'night') {
    renderNightPanel();
  } else {
    renderDayPanel();
  }
}

function renderDayPanel() {
  const v = state.voting;
  const chips = v.nominations.map((n) =>
    `<div class="nom-chip"><span>${n.order}. ${nomName(n.seat)}${n.by ? ` <small class="nom-by">← №${n.by}</small>` : ''}</span>
      ${v.stage === 'nominations' ? `<button class="x" data-bact="unnominate" data-seat="${n.seat}" title="Снять кандидатуру">✕</button>` : ''}
    </div>`).join('');

  if (v.stage === 'nominations') {
    bottom.innerHTML = `
      <div class="bp-title">Кандидатуры дня ${v.day}
        <span class="bp-hint">Выставляет тот, у кого слово; один игрок — одна кандидатура</span>
      </div>
      <div class="nom-list">${chips || '<span class="bp-hint">Пока никого не выставили</span>'}</div>
      <div class="bp-footer">
        <button class="btn btn-accent btn-big" data-bact="voting-start" ${v.nominations.length === 0 ? 'disabled' : ''}>Начать голосование</button>
      </div>`;
    return;
  }

  // быстрые кнопки голосов: не больше числа игроков за столом
  const alive = state.players.filter((p) => p.status === 'alive').length;

  if (v.stage === 'voting' || v.stage === 'revote') {
    const max = Math.max(...v.nominations.map((n) => n.votes));
    const total = v.nominations.reduce((s, n) => s + n.votes, 0);
    const rows = v.nominations.map((n) => `
      <div class="vote-row">
        <span class="vr-name ${max > 0 && n.votes === max ? 'leader' : ''}">${n.order}. ${nomName(n.seat)}</span>
        <span class="vote-count">${n.votes}</span>
        <span class="vote-quick">${Array.from({ length: alive + 1 }, (_, i) =>
          `<button class="btn ${n.votes === i ? 'sel' : ''}" data-bact="set-votes" data-seat="${n.seat}" data-votes="${i}" ${total - n.votes + i > alive ? 'disabled' : ''}>${i}</button>`).join('')}
        </span>
      </div>`).join('');
    bottom.innerHTML = `
      <div class="bp-title">${v.stage === 'revote' ? 'Перестрелка (попил)' : `Голосование, день ${v.day}`}
        <span class="bp-hint">Голосов: ${total} из ${alive} за столом</span>
      </div>
      ${rows}
      <div class="bp-footer">
        <button class="btn btn-accent btn-big" data-bact="voting-finish">Завершить голосование</button>
      </div>`;
    return;
  }

  if (v.stage === 'lift_all') {
    const seats = v.nominations.map((n) => nomName(n.seat)).join(', ');
    bottom.innerHTML = `
      <div class="bp-title">Поднять всех? <span class="bp-hint">Повторное равенство: ${seats}</span></div>
      <div class="bp-footer">
        <button class="btn btn-danger btn-big" data-bact="lift-yes">Подняли — уходят все</button>
        <button class="btn btn-big" data-bact="lift-no">Остаются за столом</button>
      </div>`;
    return;
  }

  // stage === 'done'
  const voted = state.votedOut.find((x) => x.day === v.day);
  bottom.innerHTML = `
    <div class="bp-title">Голосование дня ${v.day} завершено</div>
    <p style="font-size:17px">${voted && voted.seats.length
      ? `Покинул(и) стол: <b>${voted.seats.map(nomName).join(', ')}</b>`
      : 'Никто не покинул стол'}</p>
    <div class="bp-footer"><span class="bp-hint">Дальше: «${`Ночь ${state.phase.round} →`}» в шапке. Ошиблись — «⎌ Отменить».</span></div>`;
}

function renderNightPanel() {
  const round = state.phase.round;
  const night = state.nights[round - 1] || {};
  const don = night.donCheck;
  const sher = night.sheriffCheck;

  // Результат проверки ведущий не вводит — он вычисляется сервером по роли.
  // Проверять можно и выбывших; выбывший дон/шериф проверять не может
  // (кроме отстрелянного этой же ночью — он покинет стол только утром).
  const checkBlock = (who, title, icon, recorded) => {
    const checkerOut = state.players.some((pl) => pl.role === who && pl.status !== 'alive'
      && !(pl.status === 'killed' && night.shot === pl.seat));
    const body = checkerOut
      ? '<p class="bp-hint" style="padding:6px 0">Выбыл из игры — проверка недоступна.</p>'
      : `
        <div class="seat-grid">${seatButtons('check-seat', who, recorded ? recorded.seat : null, true)}</div>
        <div class="check-results">
          <button class="btn ${recorded ? '' : 'sel'}" data-bact="check-none" data-who="${who}">Никого не проверял</button>
        </div>`;
    return `
      <div class="nblock secret ${heldBlocks.has(who) ? 'held' : ''}">
        <h3>${icon} ${title} <span class="current masked-secret">${recorded ? `№${recorded.seat}` : '—'}</span></h3>
        ${body}
        <div class="hold-cover" data-block="${who}">👁 Показать (удерживать)</div>
      </div>`;
  };

  const shotRecorded = night.shot !== undefined;
  bottom.innerHTML = `
    <div class="bp-title">Ночь ${round}</div>
    <div class="night-blocks">
      <div class="nblock">
        <h3>🎯 Отстрел мафии <span class="current">${shotRecorded ? (night.shot === null ? 'промах' : `№${night.shot}`) : '—'}</span></h3>
        <div class="seat-grid">${seatButtons('shot', null, typeof night.shot === 'number' ? night.shot : null)}</div>
        <div class="check-results">
          <button class="btn ${shotRecorded && night.shot === null ? 'sel' : ''}" data-bact="shot" data-seat="miss">Промах</button>
        </div>
      </div>
      ${checkBlock('don', 'Проверка дона', '🟣', don)}
      ${checkBlock('sheriff', 'Проверка шерифа', '⭐', sher)}
    </div>`;
}

// ---------------------------------------------------------------- баннер ЛХ

function renderBestMoveBanner() {
  const banner = $('#best-move-banner');
  const bm = state.bestMove;
  // показываем только днём — т.е. на следующее утро после ночи, когда был убит игрок
  const show = !bmBannerDismissed && bm.by && bm.picks.length === 0
    && state.meta.status === 'in_progress' && state.phase.kind === 'day';
  banner.hidden = !show;
  if (show) {
    banner.innerHTML = `
      <span>⭐ Лучший ход: игрок №${bm.by} убит первым — может назвать до 3 подозреваемых</span>
      <span style="display:flex;gap:8px">
        <button class="btn btn-accent" id="bm-open">Ввести ЛХ</button>
        <button class="btn" id="bm-skip">Без ЛХ</button>
      </span>`;
    $('#bm-open').onclick = openBestMoveModal;
    $('#bm-skip').onclick = () => { bmBannerDismissed = true; render(); };
  }
}

// ---------------------------------------------------------------- контроль победы

// Проверка состояния игры после отстрелов/голосований: все мафы выбыли — победа
// мирных; мафов столько же, сколько мирных, — победа мафии. Ведущий подтверждает.
function renderWinBanner() {
  const banner = $('#win-banner');
  let result = null;
  let text = '';
  if (state.meta.status === 'in_progress') {
    const black = state.players.filter((p) => p.status === 'alive' && (p.role === 'mafia' || p.role === 'don')).length;
    const red = state.players.filter((p) => p.status === 'alive' && p.role !== 'mafia' && p.role !== 'don').length;
    if (black === 0) {
      result = 'city_win';
      text = RESULTS.city_win;
    } else if (black >= red) {
      result = 'mafia_win';
      text = RESULTS.mafia_win;
    }
  }
  const key = result && `${result}:${state.players.map((p) => p.status).join(',')}`;
  const show = !!result && winDismissedKey !== key;
  banner.hidden = !show;
  if (show) {
    banner.innerHTML = `
      <span>🏁 ${text}</span>
      <span style="display:flex;gap:8px">
        <button class="btn btn-accent" id="win-finish">Завершить игру</button>
        <button class="btn" id="win-later">Позже</button>
      </span>`;
    $('#win-finish').onclick = () => send('FINISH_GAME', { result });
    $('#win-later').onclick = () => { winDismissedKey = key; render(); };
  }
}

// ---------------------------------------------------------------- подготовка игры

async function loadRoster() {
  try {
    roster = await (await fetch('/api/roster')).json();
    $('#roster-list').innerHTML = roster.map((r) => `<option value="${esc(r.nickname)}">`).join('');
  } catch { /* справочник недоступен — не критично */ }
}
loadRoster();

// Кнопки трекера (импорт в сетапе, отправка на финале) видны, только если
// интеграция настроена на сервере (service_role-ключ в config.json).
async function initTracker() {
  try {
    trackerEnabled = (await (await fetch('/api/tracker/status')).json()).enabled;
  } catch { /* интеграции нет — кнопок не показываем */ }
  $('#btn-import-tracker').hidden = !trackerEnabled;
  if (state) render();
}
initTracker();

$('#btn-import-tracker').onclick = async () => {
  const btn = $('#btn-import-tracker');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Импорт…';
  try {
    const res = await fetch('/api/tracker/import-players', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка импорта');
    toast(`Импортировано игроков: ${data.imported}`, 'info');
    await loadRoster(); // обновляем datalist — ники сразу доступны при вводе
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
};

$('#btn-send-tracker').onclick = () => sendGameToTracker(false);

async function sendGameToTracker(force) {
  const btn = $('#btn-send-tracker');
  btn.disabled = true;
  btn.textContent = 'Отправка…';
  try {
    const res = await fetch('/api/tracker/send-game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force })
    });
    const data = await res.json();
    if (res.status === 409 && !force) {
      if (window.confirm('Игра уже отправлена в рейтинг. Отправить ещё раз? В трекере появится дубль.')) {
        return await sendGameToTracker(true);
      }
      return;
    }
    if (!res.ok) throw new Error(data.error || 'Ошибка отправки');
    toast(`Игра отправлена (№${data.gameNumber}, сезон «${data.seasonName}»)`, 'info');
  } catch (err) {
    toast(err.message);
  } finally {
    if (state) render(); // вернёт кнопке корректную надпись (в т.ч. «Отправлено ✓»)
  }
}

async function uploadPhoto(file, seat) {
  const fd = new FormData();
  fd.append('photo', file);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка загрузки');
    send('SET_PLAYER', { seat, photo: data.url });
    const nickname = state.players[seat - 1].nickname;
    if (nickname) saveToRoster(nickname, data.url);
  } catch (err) {
    toast(err.message);
  }
}

async function saveToRoster(nickname, photo) {
  try {
    await fetch('/api/roster', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname, photo })
    });
    loadRoster();
  } catch { /* не критично */ }
}

$('#photo-input').onchange = (e) => {
  if (e.target.files[0] && uploadSeat) uploadPhoto(e.target.files[0], uploadSeat);
  e.target.value = '';
};

function buildSetup() {
  const rowsBox = $('#setup-rows');
  rowsBox.innerHTML = '';
  setupRows.length = 0;

  for (let seat = 1; seat <= 10; seat++) {
    const row = document.createElement('div');
    row.className = 'srow';
    row.dataset.seat = seat;
    row.innerHTML = `
      <span class="sdrag" draggable="true" title="Перетащите строку для пересадки">⠿</span>
      <span class="snum">${seat}</span>
      <div class="sphoto" title="Фото: клик или перетащите файл">фото</div>
      <input type="text" class="snick" placeholder="Ник игрока" maxlength="40" list="roster-list">
      <div class="sroles">
        ${['civilian', 'mafia', 'don', 'sheriff'].map((r) =>
          `<button class="btn role-${r}" data-role="${r}">${ROLES[r].short}</button>`).join('')}
        <button class="btn role-assigned" data-role-clear hidden title="Сбросить и выбрать заново">✓ назначена</button>
      </div>
      <button class="btn" data-swap title="Пересадка: выберите два места">⇄</button>`;

    const photoEl = row.querySelector('.sphoto');
    const nickEl = row.querySelector('.snick');

    photoEl.onclick = () => { uploadSeat = seat; $('#photo-input').click(); };
    photoEl.ondragover = (e) => { e.preventDefault(); photoEl.classList.add('dragover'); };
    photoEl.ondragleave = () => photoEl.classList.remove('dragover');
    photoEl.ondrop = (e) => {
      e.preventDefault();
      photoEl.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file) uploadPhoto(file, seat);
    };

    nickEl.onchange = () => {
      const nickname = nickEl.value.trim();
      send('SET_PLAYER', { seat, nickname });
      // подстановка фото из справочника
      const known = roster.find((r) => r.nickname.toLowerCase() === nickname.toLowerCase());
      if (known && known.photo) send('SET_PLAYER', { seat, photo: known.photo });
      // привязка к трекеру переносится на место; ручная правка ника её не сбросит
      if (known && known.trackerId) send('SET_PLAYER', { seat, trackerId: known.trackerId });
      if (nickname) saveToRoster(nickname, known ? undefined : state.players[seat - 1].photo);
    };

    // после выбора роль скрывается («✓ назначена»); сброс — повторный выбор
    row.querySelectorAll('[data-role]').forEach((btn) => {
      btn.onclick = () => send('SET_ROLE', { seat, role: btn.dataset.role });
    });
    row.querySelector('[data-role-clear]').onclick = () => send('SET_ROLE', { seat, role: null });

    row.querySelector('[data-swap]').onclick = () => {
      if (swapFrom === null) {
        swapFrom = seat;
      } else if (swapFrom === seat) {
        swapFrom = null;
      } else {
        send('SWAP_SEATS', { a: swapFrom, b: seat });
        swapFrom = null;
      }
      render();
    };

    // перетаскивание строки за ручку ⠿ для пересадки игроков местами
    const handle = row.querySelector('.sdrag');
    handle.ondragstart = (e) => {
      e.dataTransfer.setData('text/plain', String(seat));
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    };
    handle.ondragend = () => row.classList.remove('dragging');
    row.ondragover = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; row.classList.add('drag-over'); };
    row.ondragleave = () => row.classList.remove('drag-over');
    row.ondrop = (e) => {
      e.preventDefault();
      row.classList.remove('drag-over');
      const from = Number(e.dataTransfer.getData('text/plain'));
      if (from && from !== seat) send('SWAP_SEATS', { a: from, b: seat });
    };

    rowsBox.appendChild(row);
    setupRows.push({ row, photoEl, nickEl });
  }

  $('#meta-title').onchange = () => send('SET_META', { title: $('#meta-title').value });
  $('#meta-number').onchange = () => send('SET_META', { gameNumber: Number($('#meta-number').value) || null });
  $('#btn-start-game').onclick = () => send('START_GAME');
  setupBuilt = true;
}

function updateSetup() {
  if (!setupBuilt) buildSetup();

  if (document.activeElement !== $('#meta-title')) $('#meta-title').value = state.meta.title;
  if (document.activeElement !== $('#meta-number')) $('#meta-number').value = state.meta.gameNumber || '';

  state.players.forEach((p, i) => {
    const { row, photoEl, nickEl } = setupRows[i];
    if (document.activeElement !== nickEl) nickEl.value = p.nickname;
    photoEl.style.backgroundImage = p.photo ? `url('${p.photo}')` : '';
    photoEl.textContent = p.photo ? '' : 'фото';
    row.classList.toggle('swap-from', swapFrom === p.seat);
    // выбранная роль не показывается: видна только пометка «назначена»
    const hasRole = !!p.role;
    row.querySelectorAll('[data-role]').forEach((btn) => { btn.hidden = hasRole; });
    row.querySelector('[data-role-clear]').hidden = !hasRole;
  });

  const count = (role) => state.players.filter((p) => p.role === role).length;
  const assigned = state.players.filter((p) => p.role).length;
  const ok = count('civilian') === 6 && count('mafia') === 2 && count('don') === 1 && count('sheriff') === 1;
  // раскладку ролей не показываем (могут увидеть игроки за столом) — только общая готовность
  const summary = $('#roles-summary');
  summary.textContent = ok ? 'Состав ролей готов' : `Назначено ролей: ${assigned}/10`;
  summary.classList.toggle('ok', ok);
}

// ---------------------------------------------------------------- финальный экран

$('#btn-protocol').onclick = () => window.open(`/api/games/${state.gameId}/protocol`, '_blank');
$('#btn-new-after-finish').onclick = () => {
  bmBannerDismissed = false;
  winDismissedKey = null;
  setupBuilt = false;
  send('NEW_GAME', { carryPlayers: true });
};

// таблица баллов на экране завершения; поля не перерисовываются, пока в фокусе
function renderScoreTable() {
  const box = $('#score-table');
  const result = state.meta.result;
  const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  box.innerHTML = `
    <table class="score-grid">
      <tr><th>№</th><th>Ник</th><th>Роль</th><th>Базовый</th><th>Доп.балл</th><th>Итог</th><th>Комментарий</th></tr>
      ${state.players.map((p) => `
        <tr>
          <td>${p.seat}</td>
          <td class="sc-nick">${esc(p.nickname) || '—'}</td>
          <td class="role-${p.role || 'none'}">${p.role ? ROLES[p.role].short : '—'}</td>
          <td><input class="sc-base" type="number" step="0.1" data-seat="${p.seat}" value="${fmt(displayBase(p, result))}"></td>
          <td><input class="sc-bonus" type="number" step="0.1" data-seat="${p.seat}" value="${p.scoreBonus || 0}"></td>
          <td class="sc-total"><b>${fmt(totalScore(p, result))}</b></td>
          <td><input class="sc-comment" type="text" maxlength="300" data-seat="${p.seat}" value="${esc(p.comment)}"></td>
        </tr>`).join('')}
    </table>`;
}

// ввод баллов: change по input → SET_SCORE; пустой базовый = сброс к авто
$('#score-table').addEventListener('change', (e) => {
  const el = e.target;
  const seat = Number(el.dataset.seat);
  if (!seat) return;
  if (el.classList.contains('sc-base')) {
    send('SET_SCORE', { seat, base: el.value.trim() === '' ? null : Number(el.value) });
  } else if (el.classList.contains('sc-bonus')) {
    send('SET_SCORE', { seat, bonus: Number(el.value) || 0 });
  } else if (el.classList.contains('sc-comment')) {
    send('SET_SCORE', { seat, comment: el.value });
  }
});

// ---------------------------------------------------------------- общий рендер

function render() {
  if (!state) return;

  const { status } = state.meta;
  $('#setup-screen').hidden = status !== 'setup';
  $('#game-screen').hidden = status !== 'in_progress';
  $('#finished-screen').hidden = status !== 'finished';

  // шапка
  const phase = state.phase;
  $('#phase-label').textContent =
    status === 'setup' ? 'Подготовка'
      : status === 'finished' ? 'Игра завершена'
        : `${phase.kind === 'day' ? '☀ День' : '🌙 Ночь'} ${phase.round}`;

  const nextBtn = $('#btn-next-phase');
  nextBtn.hidden = status !== 'in_progress';
  nextBtn.textContent = phase.kind === 'day' ? `Ночь ${phase.round} →` : `День ${phase.round + 1} →`;

  $('#timer-box').hidden = status !== 'in_progress';
  $('#btn-timer-toggle').textContent = state.speaker.timer.running ? '⏸' : '▶';
  $('#btn-timer-60').textContent = String(state.settings.speechSec);
  $('#btn-timer-30').textContent = String(state.settings.shortSpeechSec);

  $('#btn-undo').disabled = undoDepth === 0;
  $('#conn-text').textContent = `оверлей: ${clients.overlay}`;

  if (status === 'setup') {
    updateSetup();
  } else if (status === 'in_progress') {
    // ночью список игроков скрыт — на панели только отстрел и проверки дона/шерифа
    const isNight = phase.kind === 'night';
    $('#players-grid').hidden = isNight;
    if (!isNight) renderPlayersList();
    renderBottomPanel();
    renderBestMoveBanner();
    renderWinBanner();
  } else if (status === 'finished') {
    $('#finished-result').textContent = RESULTS[state.meta.result] || 'Игра завершена';
    const sendBtn = $('#btn-send-tracker');
    // отправка игры в рейтинг временно скрыта
    sendBtn.hidden = true;
    const sent = !!state.meta.trackerGameId;
    sendBtn.textContent = sent ? 'Отправлено ✓' : '⬆ Отправить в рейтинг';
    sendBtn.disabled = sent;
    // не перерисовываем таблицу, пока пользователь редактирует поле (фокус внутри)
    if (!$('#score-table').contains(document.activeElement)) renderScoreTable();
  }

  if (!$('#menu-popover').hidden) renderMenuToggles();

  syncTopbarHeight();
}
