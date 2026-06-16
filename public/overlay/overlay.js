// Оверлей: рендер состояния, присланного сервером. Никаких действий не отправляет.
// При обрыве связи — тихий реконнект, в кадре остаётся последнее состояние.

import { connectWS } from '/shared/ws-client.js';

const $ = (sel) => document.querySelector(sel);

// --- SVG-иконки (inline) ----------------------------------------------------

const ICONS = {
  star: '<svg viewBox="0 0 24 24" width="62%" height="62%" fill="currentColor"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg>',
  crown: '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor"><path d="M3 7l4.5 4L12 4l4.5 7L21 7l-1.6 11H4.6z"/></svg>',
  crosshair: '<svg viewBox="0 0 24 24" width="60%" height="60%" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="7"/><line x1="12" y1="1" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="23"/><line x1="1" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="23" y2="12"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/></svg>',
  thumbDown: '<svg viewBox="0 0 24 24" width="60%" height="60%" fill="currentColor"><path d="M15 3H6.8c-.8 0-1.5.5-1.8 1.2L2.2 11c-.1.2-.2.5-.2.7v1.8C2 14.9 3.1 16 4.5 16H10l-.9 4.3v.3c0 .4.2.8.4 1l1 1 6.6-6.6c.4-.4.6-.9.6-1.4V5c0-1.1-.9-2-2-2zm5 0v12h4V3h-4z" transform="scale(1,-1) translate(0,-24)"/></svg>',
  thumbUp: '<svg viewBox="0 0 24 24" width="62%" height="62%" fill="currentColor"><path d="M15 21H6.8c-.8 0-1.5-.5-1.8-1.2L2.2 13c-.1-.2-.2-.5-.2-.7v-1.8C2 9.1 3.1 8 4.5 8H10l-.9-4.3v-.3c0-.4.2-.8.4-1l1-1 6.6 6.6c.4.4.6.9.6 1.4V19c0 1.1-.9 2-2 2z"/></svg>',
  cross: '<svg viewBox="0 0 24 24" width="55%" height="55%" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>',
  person: '<svg viewBox="0 0 24 24" width="72" height="72" fill="currentColor"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7z"/></svg>',
  // роли: мирный — сердце, мафия — пистолет, дон — шляпа-федора, шериф — звезда
  heart: '<svg viewBox="0 0 24 24" width="60%" height="60%" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
  pistol: '<svg viewBox="0 0 512 512" width="80%" height="80%" fill="currentColor"><path d="M79.238 115.768l-28.51 67.863h406.15l-.273-67.862h-263.83v55.605h-15v-55.605h-16.68v55.605H146.1v-55.605h-17.434v55.605h-15v-55.605H79.238zm387.834 15.96v40.66h18.688v-40.66h-18.688zM56.768 198.63l20.566 32.015L28.894 406.5l101.68 7.174 21.54-97.996h115.74l14.664-80.252 174.55-3.873-.13-32.922H56.767zM263.44 235.85l-11.17 61.142h-96.05l12.98-59.05 12.53-.278-2.224 35.5 14.262 13.576 1.003-33.65 24.69-16.264 43.98-.976z"/></svg>',
  hat: '<svg viewBox="0 0 512 512" width="86%" height="86%" fill="currentColor"><path d="M239.125 97.438c-8.085.263-14.998 3.486-22.125 9.062-10.136 7.93-19.822 21.153-28.906 36.47-12.06 20.333-22.702 43.987-35.188 63.686l1.156.72c-.418.68-.383.62-.25 1.374.134.754.767 2.354 2.407 4.5 3.277 4.293 10.342 10.21 19.936 16.156 19.188 11.89 48.29 24.49 78.813 34.906 30.52 10.418 62.6 18.744 87.874 22.625 12.637 1.94 23.6 2.753 31.406 2.313 6.83-.385 10.57-2.374 11.094-2.47 2.313-12.74 5.12-26.273 7.437-40.03 5.32-31.57 7.318-63.1-.686-79.188-7.48-15.038-17.617-20.69-29.03-22.375-7.012-1.034-14.537-.068-21.627 1.97 8.783 5.46 18.177 9.676 28.594 11.624l-3.436 18.376c-29.7-5.554-51.25-24.54-69.344-42-18.093-17.46-33.43-33.012-47.156-36.437-3.314-.828-6.41-1.236-9.344-1.282-.55-.01-1.086-.018-1.625 0zM51.72 172.156c-3.565.077-6.743.487-9.532 1.22-11.158 2.926-17.707 9.42-21.282 27.343-5.598 28.066 2.315 52.298 19.938 74.874 17.622 22.576 45.243 42.83 77.625 59.937 62.247 32.887 141.57 54.053 199.155 63.19l7.594-18.064 4.342-10.28 9.344 6.062 54.25 35.062c32.376 2.315 60.15-1.828 77.78-10.563 9.02-4.468 15.296-9.976 18.94-16.062 3.642-6.086 5.003-12.87 3.437-21.72-4.446-25.12-12.418-39.6-23.375-49.31-10.958-9.712-25.828-15.125-45.313-19.22-6.452-1.356-13.402-2.563-20.75-3.75-2.82 16.205-4.812 30.047-4.188 38.344.416 5.53-2.52 11.542-6.625 14.717-4.104 3.176-8.748 4.535-13.843 5.407-10.19 1.743-22.893 1.178-37.908-.75-30.03-3.857-68.82-13.617-106.125-26.375-37.304-12.76-72.902-28.365-96.687-44.908-11.892-8.27-21.073-16.588-25.813-26.78-2.37-5.097-3.465-10.944-2.28-16.688 1.183-5.744 4.534-10.91 9.156-15.094 5.593-5.063 11.163-12.628 16.78-21.625-15.758-6.912-30.355-12.82-43.468-17.125-16.417-5.39-30.464-8.075-41.156-7.844zm88.968 51.47c-2.743 3.246-5.603 6.26-8.594 8.968-2.423 2.193-3.146 3.77-3.406 5.03-.26 1.262-.158 2.677.937 5.032 2.19 4.71 9.037 11.992 19.563 19.313 21.05 14.64 55.74 30.15 92.03 42.56 36.292 12.413 74.398 21.896 102.47 25.5 14.035 1.804 25.686 2.02 32.375.876 2.73-.467 4.262-1.1 4.968-1.47-.39-6.627.103-14.072 1.095-22.123-2.2.287-4.467.46-6.813.593-9.955.562-21.878-.436-35.312-2.5-26.868-4.126-59.644-12.682-91.063-23.406-31.418-10.724-61.326-23.52-82.625-36.72-10.65-6.598-19.196-13.17-24.937-20.686-.24-.316-.456-.648-.688-.97z"/></svg>'
};

const OUT_ICON = { voted_out: ICONS.thumbDown, killed: ICONS.crosshair, removed: ICONS.cross };
const ROLE_ICON = { civilian: ICONS.heart, mafia: ICONS.pistol, sheriff: ICONS.star, don: ICONS.hat };

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
          <div class="placeholder">${ICONS.person}</div>
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

    el.querySelector('.nick').textContent = p.nickname || '—';

    // верхний левый бокс — иконка роли
    el.querySelector('.plate-role-ico').innerHTML = role && ROLE_ICON[role] ? ROLE_ICON[role] : '';
    // верхний правый бокс — статус выбывания (только если выбыл)
    el.querySelector('.plate-status-ico').innerHTML = out ? (OUT_ICON[p.status] || '') : '';

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

// --- трекер -------------------------------------------------------------------

function seatColorClass(seat) {
  const role = state.players[seat - 1] && state.players[seat - 1].role;
  return `seat-c-${role || 'none'}`;
}

function trackerCell(content) {
  return content === undefined
    ? '<td><span class="dotcell"></span></td>'
    : `<td>${content}</td>`;
}

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

  const row = (ico, title, cells) =>
    `<tr><td class="row-ico" title="${title}">${ico}</td>${cells.map(trackerCell).join('')}</tr>`;

  root.innerHTML = `
    <div class="tr-best"><span class="lbl">ЛХ</span>${bestHtml}</div>
    <table>
      <tr><th></th>${Array.from({ length: rounds }, (_, i) => `<th>${i + 1}</th>`).join('')}</tr>
      ${row(`<span style="display:inline-block;width:20px;height:20px">${ICONS.crosshair.replace('60%', '100%').replace('60%', '100%')}</span>`, 'Отстрелы', shotCells)}
      ${row(`<span style="display:inline-block;width:22px;height:22px;color:#b07ce8">${ICONS.hat.replace('86%', '100%').replace('86%', '100%')}</span>`, 'Проверки дона', donCells)}
      ${row(`<span style="display:inline-block;width:20px;height:20px;color:#f3c93f">${ICONS.star.replace('62%', '100%').replace('62%', '100%')}</span>`, 'Проверки шерифа', sherCells)}
      ${row(`<span style="display:inline-block;width:20px;height:20px">${ICONS.thumbDown.replace('60%', '90%').replace('60%', '90%')}</span>`, 'Заголосованные', votedCells)}
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function render() {
  $('#plates').classList.toggle('hidden', !state.overlay.plates);
  $('#tracker').classList.toggle('hidden', !state.overlay.tracker);
  renderPlates();
  renderTracker();
  renderVotingBar();
  renderTitle();
}

connectWS({
  role: 'overlay',
  onState(s) {
    state = s;
    render();
  }
});
