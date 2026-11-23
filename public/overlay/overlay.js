// Оверлей: рендер состояния, присланного сервером. Никаких действий не отправляет.
// При обрыве связи — тихий реконнект, в кадре остаётся последнее состояние.

import { connectWS } from '/shared/ws-client.js';
import { escapeHtml, splitNickname, RESULTS } from '/shared/constants.js';
import { icon } from '/shared/icons.js';

const $ = (sel) => document.querySelector(sel);

const OUT_ICON = { voted_out: ['thumbDown', '60%'], killed: ['crosshair', '60%'], removed: ['cross', '55%'] };
const ROLE_ICON = { civilian: ['heart', '60%'], mafia: ['pistol', '80%'], sheriff: ['star', '62%'], don: ['hat', '86%'] };

let state = null;

// --- масштабирование под размер источника -----------------------------------

function fit() {
  const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  $('#stage').style.transform = `scale(${scale})`;
}
window.addEventListener('resize', fit);
fit();

// --- плашки: каркас строится один раз ----------------------------------------

const plateEls = [];
(function buildPlates() {
  const root = $('#plates');
  for (let seat = 1; seat <= 10; seat++) {
    const el = document.createElement('div');
    el.className = 'plate';
    el.innerHTML = `
      <div class="plate-card">
        <div class="plate-photo">
          <div class="placeholder">${icon('person', '72px')}</div>
          <div class="plate-fouls"></div>
        </div>
        <div class="plate-name">
          <div class="num">${seat}</div>
          <div class="nick"></div>
        </div>
        <div class="plate-role-ico"></div>
        <div class="plate-status-ico"></div>
      </div>`;
    root.appendChild(el);
    plateEls.push(el);
  }
})();

// --- ник на плашке -----------------------------------------------------------

// «|» в нике — заданная ведущим точка переноса: ник встаёт в две строки, кегль
// при этом не меняется (задан в CSS). Слишком длинную строку срезает ellipsis.
function renderNick(el, nick) {
  const lines = splitNickname(nick).filter(Boolean);
  if (!lines.length) lines.push('—');
  el.innerHTML = lines.map((l) => `<span class="nick-line">${escapeHtml(l)}</span>`).join('');
}

function iconFor(map, key) {
  const def = map[key];
  return def ? icon(def[0], def[1]) : '';
}

function renderPlates() {
  // Роли показываются (цвет рамки/плашки + иконка) только при включённой галке «Роли на плашках».
  const showRoles = state.overlay.roles;
  state.players.forEach((p, i) => {
    const el = plateEls[i];
    const out = p.status !== 'alive';
    const role = showRoles ? (p.role || null) : null;

    el.className = 'plate'
      + (role ? ` role-${role}` : '')
      + (out ? ' out' : '')
      + (state.speaker.seat === p.seat ? ' speaking' : '');

    const photo = el.querySelector('.plate-photo');
    photo.style.backgroundImage = p.photo ? `url("${p.photo}")` : '';
    photo.querySelector('.placeholder').style.display = p.photo ? 'none' : 'flex';

    renderNick(el.querySelector('.nick'), p.nickname || '');

    // верхний левый бокс — иконка роли
    el.querySelector('.plate-role-ico').innerHTML = role ? iconFor(ROLE_ICON, role) : '';
    // верхний правый бокс — статус выбывания (только если выбыл)
    el.querySelector('.plate-status-ico').innerHTML = out ? iconFor(OUT_ICON, p.status) : '';

    // фолы: точки 1–2 обычные, 3-я — предупреждение, 4-я — удаление
    const fouls = el.querySelector('.plate-fouls');
    let dots = '';
    for (let f = 1; f <= 4; f++) {
      const cls = f <= p.fouls ? ` on${f === 3 ? ' warn' : ''}${f === 4 ? ' last' : ''}` : '';
      dots += `<span class="dot${cls}"></span>`;
    }
    fouls.innerHTML = dots;
  });
}

// --- события: короткие анимации поверх обычного рендера ------------------------
//
// Анимации идут через Web Animations API, а не CSS-классы: renderPlates на каждом
// состоянии переписывает className и innerHTML, и CSS-анимация перезапускалась бы
// от любого действия ведущего. Только transform/opacity — стабильно в CEF (OBS).

let prev = null; // снимок прошлого состояния: { gameId, phaseKey, players: [{fouls}] }

function phaseKey(s) {
  return s.meta.status === 'finished'
    ? `finished:${s.meta.result}`
    : `${s.meta.status}:${s.phase.kind}:${s.phase.round}`;
}

// Сравнивает новое состояние с прошлым. Первое состояние после загрузки страницы,
// новая игра и подготовка не анимируются — иначе перезапуск источника в OBS
// «проигрывал» бы все фолы заново.
function detectEvents(s) {
  const ev = { fouls: [], phase: false };
  const sameGame = prev && prev.gameId === s.gameId;
  if (sameGame && s.meta.status !== 'setup') {
    s.players.forEach((p, i) => {
      const was = prev.players[i];
      if (!was) return;
      if (p.fouls > was.fouls) ev.fouls.push({ i, from: was.fouls, to: p.fouls });
    });
    ev.phase = prev.phaseKey !== phaseKey(s);
  }
  prev = {
    gameId: s.gameId,
    phaseKey: phaseKey(s),
    players: s.players.map((p) => ({ fouls: p.fouls }))
  };
  return ev;
}

function playFoul({ i, from, to }) {
  const dots = plateEls[i].querySelectorAll('.plate-fouls .dot');
  for (let f = from + 1; f <= to && f <= dots.length; f++) {
    dots[f - 1].animate([
      { transform: 'scale(2.3)', opacity: 0.3 },
      { transform: 'scale(0.9)', opacity: 1, offset: 0.6 },
      { transform: 'scale(1)', opacity: 1 }
    ], { duration: 520, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
  }
}

function playPhase() {
  const chip = $('#phase-chip');
  if (chip.classList.contains('hidden')) return;
  chip.animate([
    { transform: 'translateY(-10px) scaleY(0.4)', opacity: 0 },
    { transform: 'translateY(0) scaleY(1)', opacity: 1 }
  ], { duration: 480, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
}

function playEvents(ev) {
  if (state.overlay.plates) ev.fouls.forEach(playFoul);
  if (ev.phase) playPhase();
}

// --- трекер -------------------------------------------------------------------

// Номер в трекере и баре голосования окрашен ролью игрока — но только при
// включённой галке «Роли на плашках»: иначе цвет выдавал бы роли зрителям.
function seatColorClass(seat) {
  if (!state.overlay.roles) return 'seat-c-none';
  const role = state.players[seat - 1] && state.players[seat - 1].role;
  return `seat-c-${role || 'none'}`;
}

function trackerCell(content) {
  return content === undefined
    ? '<td><span class="dotcell"></span></td>'
    : `<td>${content}</td>`;
}

// иконки строк трекера: [иконка, размер, класс цвета]
const TRACKER_ROWS = {
  shot: ['crosshair', '20px', ''],
  don: ['hat', '22px', 'ri-don'],
  sheriff: ['star', '20px', 'ri-sheriff'],
  voted: ['thumbDown', '18px', '']
};

function renderTracker() {
  const root = $('#tracker');
  // колонки добавляются динамически по ходу игры (минимум 5)
  const rounds = Math.max(5, state.phase.round + (state.phase.kind === 'night' ? 1 : 0));

  // ЛХ
  const picks = state.bestMove.picks || [];
  const bestHtml = picks.length
    ? picks.map((s) => `<span class="pick ${seatColorClass(s)}">${s}</span>`).join('')
    : '<span class="none">—</span>';

  // строки сетки
  const shotCells = [];
  const donCells = [];
  const sherCells = [];
  const votedCells = [];
  for (let r = 1; r <= rounds; r++) {
    const night = state.nights[r - 1];
    if (night && night.shot !== undefined) {
      shotCells.push(night.shot === null
        ? '<span class="miss">✕</span>'
        : `<span class="cellv ${seatColorClass(night.shot)}">${night.shot}</span>`);
    } else shotCells.push(undefined);

    // результат проверки не показывается (цвет номера = роль проверенного)
    for (const [cells, key] of [[donCells, 'donCheck'], [sherCells, 'sheriffCheck']]) {
      const check = night && night[key];
      cells.push(check
        ? `<span class="cellv ${seatColorClass(check.seat)}">${check.seat}</span>`
        : undefined);
    }

    const voted = state.votedOut.find((v) => v.day === r);
    votedCells.push(voted && voted.seats.length
      ? voted.seats.map((s) => `<span class="cellv ${seatColorClass(s)}">${s}</span>`).join('<span class="miss">,</span>')
      : undefined);
  }

  const row = (key, title, cells) => {
    const [name, size, cls] = TRACKER_ROWS[key];
    return `<tr><td class="row-ico ${cls}" title="${title}">${icon(name, size)}</td>${cells.map(trackerCell).join('')}</tr>`;
  };

  root.innerHTML = `
    <div class="tr-best"><span class="lbl">ЛХ</span>${bestHtml}</div>
    <table>
      <tr><th></th>${Array.from({ length: rounds }, (_, i) => `<th>${i + 1}</th>`).join('')}</tr>
      ${row('shot', 'Отстрелы', shotCells)}
      ${row('don', 'Проверки дона', donCells)}
      ${row('sheriff', 'Проверки шерифа', sherCells)}
      ${row('voted', 'Заголосованные', votedCells)}
    </table>`;
}

// --- бар голосования ------------------------------------------------------------

const STAGE_LABELS = {
  nominations: 'Выставлены',
  voting: 'Голосование',
  revote: 'Перестрелка',
  lift_all: 'Поднять всех?'
};

// Бар кандидатур: только номера выставленных, без количества голосов
function renderVotingBar() {
  const root = $('#voting-bar');
  const v = state.voting;
  const visible = state.overlay.votingBar && v.stage !== 'done' && v.nominations.length > 0;
  root.classList.toggle('hidden', !visible);
  if (!visible) return;

  const chips = v.nominations.map((n) => `
      <div class="vote-chip">
        <div class="num ${seatColorClass(n.seat)}">${n.seat}</div>
      </div>`).join('');

  root.innerHTML = `<div class="vb-stage">${STAGE_LABELS[v.stage] || ''}</div>${chips}`;

  // ставим бар вплотную справа от трекера (трекер растёт вправо по ходу игры).
  // offsetWidth — это ширина ДО scale(0.8), поэтому домножаем на 0.8 (трекер ужат
  // от левого-верхнего угла, offsetLeft при этом не меняется).
  const tracker = $('#tracker');
  root.style.left = `${tracker.offsetLeft + tracker.offsetWidth * 0.8 + 16}px`;
}

// --- фаза игры (слева над трекером) -------------------------------------------------

const RESULT_CLASS = { city_win: 'res-city', mafia_win: 'res-mafia', draw: 'res-draw' };

// Фаза видна зрителю, пока идёт игра; после завершения — итог. Каркас чипа
// статичен (index.html): чип анимируется при смене фазы, и пересоздание
// элемента на каждом состоянии оборвало бы анимацию.
function renderPhase() {
  const { status, result } = state.meta;
  const chip = $('#phase-chip');
  // чип не уже трекера под ним — левый блок читается единым целым.
  // offsetWidth трекера — до scale(0.8), отсюда множитель (см. renderVotingBar)
  chip.style.minWidth = state.overlay.tracker ? `${$('#tracker').offsetWidth * 0.8}px` : '';
  let chipKind = null;
  let chipText = '';
  let chipIcon = '';
  if (status === 'in_progress') {
    const night = state.phase.kind === 'night';
    chipKind = night ? 'night' : 'day';
    chipText = `${night ? 'Ночь' : 'День'} ${state.phase.round}`;
    chipIcon = icon(night ? 'moon' : 'sun', '20px');
  } else if (status === 'finished' && RESULTS[result]) {
    chipKind = RESULT_CLASS[result];
    chipText = RESULTS[result];
    chipIcon = icon('flag', '20px');
  }
  chip.className = `ov ${chipKind || 'hidden'}`;
  if (chip.dataset.text !== chipText) {
    chip.dataset.text = chipText;
    chip.querySelector('.pc-ico').innerHTML = chipIcon;
    chip.querySelector('.pc-text').textContent = chipText;
  }
}

// --- название игры ----------------------------------------------------------------

function renderTitle() {
  const root = $('#title-badge');
  const { title, gameNumber } = state.meta;
  const visible = !!(title || gameNumber);
  root.classList.toggle('hidden', !visible);
  if (visible) {
    root.innerHTML = `<div class="t">${escapeHtml(title || 'Мафия')}</div><div class="g">${gameNumber ? `Игра ${gameNumber}` : ''}</div>`;
  }
}

// --- общий рендер -------------------------------------------------------------------

function render() {
  $('#plates').classList.toggle('hidden', !state.overlay.plates);
  $('#tracker').classList.toggle('hidden', !state.overlay.tracker);
  renderPlates();
  renderTracker();
  renderVotingBar();
  renderPhase();
  renderTitle();
}

connectWS({
  role: 'overlay',
  onState(s) {
    state = s;
    const ev = detectEvents(s);
    render();
    playEvents(ev);
  }
});
