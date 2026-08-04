// WS-клиент для тестов. Сообщения буферизуются, ожидание идёт по rev —
// поэтому тест не зависит от того, сколько состояний сервер прислал на
// подключении (их два: личное и широковещательное ради счётчика клиентов).

import WebSocket from 'ws';

const ACT_TIMEOUT_MS = 10000;

export async function connect(server, role = 'control') {
  const ws = new WebSocket(server.wsUrl(role));
  const queue = [];
  let notify = null;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    queue.push(msg);
    if (notify) notify();
  });

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  // Ждём сообщение, удовлетворяющее предикату, разбирая очередь с начала.
  function waitFor(match) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        notify = null;
        reject(new Error('таймаут ожидания ответа сервера'));
      }, ACT_TIMEOUT_MS);

      const scan = () => {
        const i = queue.findIndex(match);
        if (i === -1) return false;
        const [msg] = queue.splice(i, 1);
        clearTimeout(timer);
        notify = null;
        resolve(msg);
        return true;
      };

      if (!scan()) notify = scan;
    });
  }

  const api = {
    state: null,
    rev: -1,
    lastError: null,
    lastMessage: null, // сырое сообщение — нужно тестам на состав рассылки

    // Ждёт первое состояние после подключения.
    async ready() {
      const msg = await waitFor((m) => m.type === 'state');
      api.state = msg.state;
      api.rev = msg.rev;
      api.lastMessage = msg;
      return msg;
    },

    // Ждёт сообщения о числе клиентов, удовлетворяющего условию. Предикат
    // нужен потому, что закрытие сокета асинхронно: события подключения и
    // отключения соседних тестов могут прийти в любой момент, и ждать «просто
    // следующее» сообщение — гонка. Не дождались — таймаут и падение теста.
    async clientsUntil(match) {
      const msg = await waitFor((m) => m.type === 'clients' && match(m.clients));
      return msg.clients;
    },

    // Шлёт действие и ждёт либо новое состояние (rev вырос), либо ошибку
    // валидации. Возвращает пришедшее сообщение.
    async act(type, payload) {
      api.lastError = null;
      const revBefore = api.rev;
      ws.send(JSON.stringify({ type: 'action', action: { type, payload } }));
      const msg = await waitFor(
        (m) => (m.type === 'state' && m.rev > revBefore) || m.type === 'error'
      );
      if (msg.type === 'error') {
        api.lastError = msg.message;
      } else {
        api.state = msg.state;
        api.rev = msg.rev;
        api.lastMessage = msg;
      }
      return msg;
    },

    // Ждёт очередное состояние без отправки действия (например, после
    // действия другого клиента).
    async nextState() {
      const revBefore = api.rev;
      const msg = await waitFor((m) => m.type === 'state' && m.rev > revBefore);
      api.state = msg.state;
      api.rev = msg.rev;
      api.lastMessage = msg;
      return msg;
    },

    close() {
      ws.close();
    }
  };

  await api.ready();
  return api;
}

// Сокращение: свежая игра с расставленными ролями (6 мирных, 2 мафии, дон, шериф).
export async function startGame(c, { title = 'Тест', gameNumber = 1, nicknames = false } = {}) {
  await c.act('NEW_GAME', { title, gameNumber, carryPlayers: false });
  if (nicknames) {
    for (let s = 1; s <= 10; s++) await c.act('SET_PLAYER', { seat: s, nickname: `Игрок${s}` });
  }
  for (let s = 1; s <= 6; s++) await c.act('SET_ROLE', { seat: s, role: 'civilian' });
  await c.act('SET_ROLE', { seat: 7, role: 'mafia' });
  await c.act('SET_ROLE', { seat: 8, role: 'mafia' });
  await c.act('SET_ROLE', { seat: 9, role: 'don' });
  await c.act('SET_ROLE', { seat: 10, role: 'sheriff' });
  await c.act('START_GAME');
}
