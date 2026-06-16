// Подключение к серверу + автореконнект (экспоненциальный, 0.5–5 с).
// Использование:
//   const ws = connectWS({ role, onState, onStatus, onError });
//   ws.send({ type: 'ADD_FOUL', payload: { seat: 5 } });

export function connectWS({ role = 'control', onState, onStatus, onError }) {
  let socket = null;
  let attempts = 0;
  let lastRev = -1;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${proto}://${location.host}/ws?role=${role}`);

    socket.onopen = () => {
      attempts = 0;
      lastRev = -1; // после рестарта сервера счётчик rev начинается заново
      if (onStatus) onStatus(true);
    };

    socket.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'state') {
        if (msg.rev < lastRev) return; // отбрасываем устаревшие сообщения
        lastRev = msg.rev;
        onState(msg.state, msg);
      } else if (msg.type === 'error' && onError) {
        onError(msg.message);
      }
    };

    socket.onclose = () => {
      if (onStatus) onStatus(false);
      const delay = Math.min(5000, 500 * 2 ** attempts);
      attempts += 1;
      setTimeout(connect, delay);
    };

    socket.onerror = () => {
      socket.close();
    };
  }

  connect();

  return {
    send(action) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'action', action }));
        return true;
      }
      return false;
    }
  };
}
