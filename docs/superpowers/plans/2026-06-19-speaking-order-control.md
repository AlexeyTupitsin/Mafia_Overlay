# Контроль порядка давания слова — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Панель ведущего отслеживает дневной круг обсуждения и не даёт нарушить три правила выдачи слова (повтор, молчанка, старт круга), оставляя выдачу слова ручной.

**Architecture:** Сервер (`store.js`/`actions.js`) — источник истины: новое поле `speaking` ведёт ленту круга (`spoken`, `circleStarter`, `prevStarter`). `SET_SPEAKER` дописывает ленту, `SET_PHASE`/`NEXT_PHASE` сбрасывают круг при новом дне. Защита — только в UI (`control.js`): кнопки disabled, бейдж «говорил», мягкая подсветка рекомендованного старта (через чистый хелпер в `shared/constants.js`).

**Tech Stack:** Node.js (ESM, Node ≥20), ванильный браузерный JS, WebSocket. Тесты — standalone `.mjs` через `node`.

## Global Constraints

- ESM-модули, Node ≥20, без новых зависимостей.
- Контроль только в панели ведущего; оверлей трансляции не трогаем.
- «Круг» = `phase.kind === 'day'` и `voting.active === false`.
- Молчанка: `fouls === settings.foulSilenceAt` (3), снимается на новом круге.
- Защита только в UI — сервер `SET_SPEAKER` повтор/молчащего НЕ отклоняет.
- Дефолт `settings.foulSilenceAt = 3`, `foulRemoveAt = 4` (уже есть).

---

### Task 1: Поле `speaking` в состоянии + нормализация автосейва

**Files:**
- Modify: `server/store.js` (функция `createInitialState`, ~стр. 14-57; функция `init`, ~стр. 59-62)
- Test: `tests/test-speaking-order.mjs` (Create)

**Interfaces:**
- Produces: `state.speaking = { round: number, spoken: number[], circleStarter: number|null, prevStarter: number|null }` в объекте из `createInitialState()`.
- Produces: `export function normalizeLoaded(state)` в `store.js` — добавляет `speaking` в старые автосейвы, возвращает тот же объект.
- Consumes: `createInitialState`, `normalizeLoaded` (экспортируются из `server/store.js`).

- [ ] **Step 1: Написать падающий тест**

Создать `tests/test-speaking-order.mjs`:

```js
// Юнит-тесты контроля порядка слова. Запуск: node tests/test-speaking-order.mjs
import assert from 'node:assert/strict';
import { handlers } from '../server/actions.js';
import { createInitialState, normalizeLoaded } from '../server/store.js';
import { recommendedStarter } from '../public/shared/constants.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok: ${name}`); }
  catch (e) { console.log(`  FAIL: ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// помощник: состояние «игра идёт, день 1»
function dayState() {
  const s = createInitialState();
  s.meta.status = 'in_progress';
  s.phase = { kind: 'day', round: 1 };
  return s;
}

// --- Task 1: поле speaking ---
test('createInitialState содержит speaking по умолчанию', () => {
  const s = createInitialState();
  assert.deepEqual(s.speaking, { round: 1, spoken: [], circleStarter: null, prevStarter: null });
});

test('normalizeLoaded добавляет speaking в старый автосейв', () => {
  const old = createInitialState();
  delete old.speaking;
  old.phase = { kind: 'day', round: 3 };
  const fixed = normalizeLoaded(old);
  assert.deepEqual(fixed.speaking, { round: 3, spoken: [], circleStarter: null, prevStarter: null });
});

test('normalizeLoaded не затирает существующий speaking', () => {
  const s = createInitialState();
  s.speaking.spoken = [4, 5];
  assert.deepEqual(normalizeLoaded(s).speaking.spoken, [4, 5]);
});

console.log(`\n${passed} проверок пройдено`);
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `node tests/test-speaking-order.mjs`
Expected: FAIL — `normalizeLoaded` не экспортируется / `speaking` отсутствует (ошибка импорта или assert).

- [ ] **Step 3: Добавить поле и нормализацию**

В `server/store.js`, в объект, возвращаемый `createInitialState()`, добавить после блока `speaker: { ... },` (перед `voting:`):

```js
    speaking: {
      round: 1,            // дневной раунд, к которому относится круг
      spoken: [],          // места в порядке выдачи слова в этом круге
      circleStarter: null, // кто открыл текущий круг (первое слово)
      prevStarter: null    // кто открывал прошлый день — основа подсказки старта
    },
```

Там же в `store.js` добавить экспортируемую функцию (после `createInitialState`):

```js
// Старые автосейвы без поля speaking → подставляем дефолт под текущий день.
export function normalizeLoaded(state) {
  if (!state.speaking) {
    state.speaking = {
      round: state.phase?.round || 1,
      spoken: [],
      circleStarter: null,
      prevStarter: null
    };
  }
  return state;
}
```

Изменить `init` так, чтобы загруженный автосейв нормализовался:

```js
export function init(settingsDefaults = {}) {
  defaults = settingsDefaults;
  const loaded = persistence.loadAutosave();
  state = loaded ? normalizeLoaded(loaded) : createInitialState();
}
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `node tests/test-speaking-order.mjs`
Expected: первые 3 проверки `ok` (тесты `recommendedStarter` ниже ещё упадут на импорте — это ок, добавим в Task 3; если импорт `recommendedStarter` ломает запуск, временно проверка `recommendedStarter` ещё не вызывается, импорт несуществующего члена даёт `undefined`, не ошибку).

- [ ] **Step 5: Commit**

```bash
git add server/store.js tests/test-speaking-order.mjs
git commit -m "feat(speaking): add speaking ledger to game state + autosave normalization"
```

---

### Task 2: `SET_SPEAKER` ведёт ленту круга, фазы сбрасывают круг

**Files:**
- Modify: `server/actions.js` (`SET_SPEAKER`, ~стр. 223-230; `SET_PHASE`, ~стр. 192-206; `NEXT_PHASE`, ~стр. 208-221; новый хелпер рядом с `resetTimer`, ~стр. 60-70)
- Test: `tests/test-speaking-order.mjs` (Modify)

**Interfaces:**
- Consumes: `state.speaking` из Task 1; `handlers.SET_SPEAKER/SET_PHASE/NEXT_PHASE`.
- Produces: после `SET_SPEAKER(state, { seat })` в дневном обсуждении `state.speaking.spoken` содержит `seat` (без дублей), `circleStarter` = первое место круга. После `NEXT_PHASE` ночь→день / `SET_PHASE` на новый день: `prevStarter` = прежний `circleStarter`, `spoken` пуст, `circleStarter` = null.

- [ ] **Step 1: Написать падающие тесты**

Добавить в `tests/test-speaking-order.mjs` перед строкой `console.log(`\n${passed}...`:

```js
// --- Task 2: ведение ленты круга ---
test('SET_SPEAKER дописывает spoken и фиксирует circleStarter', () => {
  const s = dayState();
  handlers.SET_SPEAKER(s, { seat: 4 });
  handlers.SET_SPEAKER(s, { seat: 5 });
  assert.deepEqual(s.speaking.spoken, [4, 5]);
  assert.equal(s.speaking.circleStarter, 4);
  assert.equal(s.speaking.round, 1);
});

test('повторная выдача слова не дублирует место', () => {
  const s = dayState();
  handlers.SET_SPEAKER(s, { seat: 4 });
  handlers.SET_SPEAKER(s, { seat: 5 });
  handlers.SET_SPEAKER(s, { seat: 4 });
  assert.deepEqual(s.speaking.spoken, [4, 5]);
});

test('seat null (снять слово) не меняет ленту', () => {
  const s = dayState();
  handlers.SET_SPEAKER(s, { seat: 4 });
  handlers.SET_SPEAKER(s, { seat: null });
  assert.deepEqual(s.speaking.spoken, [4]);
  assert.equal(s.speaker.seat, null);
});

test('во время голосования лента не ведётся', () => {
  const s = dayState();
  s.voting.active = true;
  handlers.SET_SPEAKER(s, { seat: 7 });
  assert.deepEqual(s.speaking.spoken, []);
});

test('NEXT_PHASE ночь→день сбрасывает круг и переносит prevStarter', () => {
  const s = dayState();
  handlers.SET_SPEAKER(s, { seat: 3 });   // circleStarter = 3
  handlers.NEXT_PHASE(s);                  // день1 → ночь1
  handlers.NEXT_PHASE(s);                  // ночь1 → день2
  assert.equal(s.phase.kind, 'day');
  assert.equal(s.phase.round, 2);
  assert.equal(s.speaking.prevStarter, 3);
  assert.deepEqual(s.speaking.spoken, []);
  assert.equal(s.speaking.circleStarter, null);
  assert.equal(s.speaking.round, 2);
});

test('SET_PHASE на тот же день не сбрасывает круг', () => {
  const s = dayState();
  handlers.SET_SPEAKER(s, { seat: 6 });
  handlers.SET_PHASE(s, { kind: 'day', round: 1 });
  assert.deepEqual(s.speaking.spoken, [6]);
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `node tests/test-speaking-order.mjs`
Expected: новые проверки `FAIL` (лента не ведётся / круг не сбрасывается).

- [ ] **Step 3: Реализация**

В `server/actions.js` добавить хелпер рядом с `resetTimer` (после неё):

```js
// Сброс дневного круга обсуждения: переносим стартующего в prevStarter
// (если в прошлом дне реально кто-то говорил), очищаем ленту под текущий день.
function resetCircle(state) {
  const sp = state.speaking;
  if (sp.circleStarter !== null) sp.prevStarter = sp.circleStarter;
  sp.spoken = [];
  sp.circleStarter = null;
  sp.round = state.phase.round;
}
```

Заменить тело `SET_SPEAKER`:

```js
  SET_SPEAKER(state, p) {
    if (p.seat === null) {
      state.speaker.seat = null;
    } else {
      const seat = getPlayer(state, p.seat).seat;
      state.speaker.seat = seat;
      // лента круга ведётся только в дневном обсуждении до голосования
      if (state.phase.kind === 'day' && !state.voting.active && !state.speaking.spoken.includes(seat)) {
        if (state.speaking.spoken.length === 0) state.speaking.circleStarter = seat;
        state.speaking.spoken.push(seat);
        state.speaking.round = state.phase.round;
      }
    }
    resetTimer(state, state.settings.speechSec * 1000);
  },
```

В `SET_PHASE`, после `state.speaker.seat = null;` и `resetTimer(state);`, перед блоком `if (p.kind === 'day' && state.voting.day !== round)`, добавить:

```js
    if (p.kind === 'day' && round !== state.speaking.round) resetCircle(state);
```

В `NEXT_PHASE`, в ветке `else` (переход ночь→день), после `state.phase = { kind: 'day', round: state.phase.round + 1 };` добавить:

```js
      resetCircle(state);
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `node tests/test-speaking-order.mjs`
Expected: все проверки Task 1 и Task 2 — `ok`.

- [ ] **Step 5: Commit**

```bash
git add server/actions.js tests/test-speaking-order.mjs
git commit -m "feat(speaking): track circle ledger in SET_SPEAKER, reset on new day"
```

---

### Task 3: Хелпер `recommendedStarter` в общих константах

**Files:**
- Modify: `public/shared/constants.js` (добавить экспорт в конец файла)
- Test: `tests/test-speaking-order.mjs` (Modify)

**Interfaces:**
- Produces: `export function recommendedStarter(players, prevStarter)` → `number|null`. `players` — массив `{ seat, status }`. Возвращает следующий живой `seat` по кругу 1..10 после `prevStarter`; если `prevStarter == null` — наименьший живой `seat`; если живых нет — `null`.
- Consumes: импортируется в `tests/test-speaking-order.mjs` и (Task 4) в `control.js`.

- [ ] **Step 1: Написать падающие тесты**

Добавить в `tests/test-speaking-order.mjs` перед итоговым `console.log`:

```js
// --- Task 3: рекомендованный старт ---
function players(aliveSeats) {
  return Array.from({ length: 10 }, (_, i) => ({
    seat: i + 1,
    status: aliveSeats.includes(i + 1) ? 'alive' : 'killed'
  }));
}

test('recommendedStarter: prevStarter=null → первое живое от №1', () => {
  assert.equal(recommendedStarter(players([3, 4, 5]), null), 3);
});

test('recommendedStarter: следующий живой после prevStarter', () => {
  assert.equal(recommendedStarter(players([1, 2, 4, 6, 8]), 2), 4);
});

test('recommendedStarter: оборачивается по кругу', () => {
  assert.equal(recommendedStarter(players([1, 2, 3]), 9), 1);
});

test('recommendedStarter: пропускает мёртвых сразу за prevStarter', () => {
  assert.equal(recommendedStarter(players([1, 7]), 1), 7);
});

test('recommendedStarter: нет живых → null', () => {
  assert.equal(recommendedStarter(players([]), 3), null);
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `node tests/test-speaking-order.mjs`
Expected: проверки `recommendedStarter` падают (функция возвращает `undefined`).

- [ ] **Step 3: Реализация**

В конец `public/shared/constants.js` добавить:

```js
// ---- порядок слова ----------------------------------------------------------

// Рекомендованное стартовое место дневного круга: следующий живой по кругу
// (1..10) после prevStarter. Если prevStarter не задан (первый день) —
// наименьший живой seat. Если живых нет — null. Только подсказка, не блокировка.
export function recommendedStarter(players, prevStarter) {
  const alive = new Set(players.filter((p) => p.status === 'alive').map((p) => p.seat));
  if (alive.size === 0) return null;
  if (prevStarter == null) return Math.min(...alive);
  for (let i = 1; i <= 10; i++) {
    const seat = ((prevStarter - 1 + i) % 10) + 1;
    if (alive.has(seat)) return seat;
  }
  return null;
}
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `node tests/test-speaking-order.mjs`
Expected: все проверки `ok`.

- [ ] **Step 5: Commit**

```bash
git add public/shared/constants.js tests/test-speaking-order.mjs
git commit -m "feat(speaking): add recommendedStarter helper"
```

---

### Task 4: UI панели — disabled-кнопки, бейдж «говорил», подсветка старта

**Files:**
- Modify: `public/control/control.js` (импорт, ~стр. 4; `renderPlayersList`, ~стр. 401-456)
- Modify: `public/control/control.css` (добавить правило `.recommended`)

**Interfaces:**
- Consumes: `state.speaking` (Task 1-2), `recommendedStarter` (Task 3).
- Produces: визуальное поведение кнопки «🎙 Слово». Без автоматических тестов — проверка ручная (Step 4).

- [ ] **Step 1: Импортировать хелпер**

В `public/control/control.js` строку 4 заменить на:

```js
import { ROLES, STATUSES, RESULTS, OVERLAY_KEYS, displayBase, totalScore, recommendedStarter } from '/shared/constants.js';
```

- [ ] **Step 2: Вычислить контекст круга в `renderPlayersList`**

В `renderPlayersList`, сразу после строки `const speaker = state.speaker.seat;` (~стр. 405) добавить:

```js
  const sp = state.speaking;
  // круг активен только в дневном обсуждении до голосования
  const inCircle = state.phase.kind === 'day' && !v.active;
  const recommended = inCircle && sp.spoken.length === 0
    ? recommendedStarter(state.players, sp.prevStarter)
    : null;
```

- [ ] **Step 3: Обновить вычисления и кнопку «Слово»**

Внутри `state.players.map((p) => { ... })`, после строки `const silence = ...` (~стр. 412) добавить:

```js
    const alreadySpoke = inCircle && sp.spoken.includes(p.seat);
    // блокируем выдачу слова говорившему/молчащему, но не мешаем снять слово у текущего
    const blockFloor = inCircle && !speaking && (alreadySpoke || silence);
    const floorTitle = alreadySpoke
      ? 'Уже говорил в этом круге'
      : (silence && inCircle ? 'Молчанка (3 фола)' : '');
    const isRecommended = recommended === p.seat && !speaking;
```

Заменить строку кнопки «🎙 Слово» (текущая ~стр. 446):

```js
          <button class="btn ${speaking ? 'active' : ''} ${isRecommended ? 'recommended' : ''}" data-act="speaker" data-seat="${p.seat}" ${out || blockFloor ? 'disabled' : ''} title="${floorTitle}">🎙 Слово${alreadySpoke ? ' ✓' : ''}</button>
```

- [ ] **Step 4: Добавить стиль подсветки**

В конец `public/control/control.css` добавить:

```css
/* рекомендованное стартовое место дневного круга */
.prow-actions .btn.recommended {
  outline: 2px solid #e8b31e;
  outline-offset: -2px;
}
```

- [ ] **Step 5: Ручная проверка**

Запустить сервер: `npm start`. В браузере открыть панель ведущего (`http://localhost:3000/control/`).
1. Начать игру (10 ников, роли, START_GAME) — день 1.
   Ожидаемо: у рекомендованного стартового места (№1) кнопка «🎙 Слово» с жёлтой обводкой.
2. Выдать слово №1, затем №2.
   Ожидаемо: у №1 кнопка стала «🎙 Слово ✓» и `disabled`; подсветка ушла.
3. Поставить игроку №5 три фола (кнопкой «+»).
   Ожидаемо: у №5 кнопка «🎙 Слово» `disabled` с тултипом «Молчанка (3 фола)».
4. Перейти на ночь и обратно на день 2 (NEXT_PHASE дважды).
   Ожидаемо: все «✓» сняты, кнопки снова активны, подсвечено место №2 (старт прошлого дня +1).

- [ ] **Step 6: Commit**

```bash
git add public/control/control.js public/control/control.css
git commit -m "feat(speaking): enforce speaking-order rules in control panel UI"
```

---

## Self-Review

**Spec coverage:**
- Поле `speaking` в store + нормализация → Task 1. ✓
- Правило 1 (одно слово за круг): лента `spoken` (Task 2) + disabled-кнопка (Task 4). ✓
- Правило 2 (молчанка 3 фола): `silence` + `blockFloor` (Task 4); снятие на новом круге — `resetCircle` чистит `spoken`, а `silence` пересчитывается от `fouls` каждый рендер. ✓
- Правило 3 (подсказка старта): `recommendedStarter` (Task 3) + подсветка (Task 4). ✓
- Сброс круга на новый день → `resetCircle` в SET_PHASE/NEXT_PHASE (Task 2). ✓
- Только панель, без оверлея → изменения только в `control.*`. ✓
- Защита только в UI, сервер не отклоняет → `SET_SPEAKER` лишь ведёт ленту (Task 2). ✓

**Placeholder scan:** плейсхолдеров нет — весь код приведён. ✓

**Type consistency:** `speaking` поля (`round`/`spoken`/`circleStarter`/`prevStarter`), `recommendedStarter(players, prevStarter)`, `resetCircle(state)` — имена согласованы между задачами. ✓
