// Точка входа: Express (статика + REST) + WebSocket-сервер синхронизации

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import * as store from './store.js';
import * as persistence from './persistence.js';
import { createRouter } from './routes.js';
import { ValidationError } from './actions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let config = {};
try {
  config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
} catch {
  console.warn('[server] config.json не прочитан, используются настройки по умолчанию');
}
const PORT = Number(process.env.PORT) || config.port || 3000;

persistence.ensureDirs();
store.init(config.defaults || {});
persistence.cleanupUploads(); // подчищаем фото-сироты до прихода клиентов

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use('/control', express.static(path.join(ROOT, 'public', 'control')));
app.use('/overlay', express.static(path.join(ROOT, 'public', 'overlay')));
app.use('/shared', express.static(path.join(ROOT, 'public', 'shared')));
app.use('/uploads', express.static(persistence.UPLOADS_DIR, { maxAge: '7d' }));
app.use('/api', createRouter());
app.get('/', (req, res) => res.redirect('/control'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// роль клиента берём из query (?role=overlay|control) — для индикатора на панели
function clientCounts() {
  let control = 0;
  let overlay = 0;
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws.clientRole === 'overlay') overlay += 1;
    else control += 1;
  }
  return { control, overlay };
}

function stateMessage() {
  return JSON.stringify({
    type: 'state',
    state: store.getState(),
    rev: store.getRev(),
    undoDepth: store.getUndoDepth(),
    clients: clientCounts(),
    serverNow: Date.now() // для коррекции расхождения часов клиента (таймер)
  });
}

function broadcast() {
  const msg = stateMessage();
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  ws.clientRole = url.searchParams.get('role') === 'overlay' ? 'overlay' : 'control';

  ws.send(stateMessage());
  broadcast(); // обновляем счётчики клиентов у всех

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type !== 'action' || !msg.action) return;
    try {
      store.applyAction(msg.action);
    } catch (err) {
      if (err instanceof ValidationError) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      } else {
        console.error('[server] Ошибка действия:', err);
        ws.send(JSON.stringify({ type: 'error', message: 'Внутренняя ошибка сервера' }));
      }
    }
  });

  ws.on('close', () => broadcast());
});

store.subscribe(() => broadcast());

// Адреса локальной сети для доступа с планшета/телефона.
// Виртуальные адаптеры (Hyper-V, WSL, VPN, VMware…) исключаем, реальные
// LAN-диапазоны (192.168 → 172.16-31 → 10) ставим первыми.
function lanAddresses() {
  const VIRTUAL = /(virtual|vmware|hyper-v|vethernet|wsl|docker|vpn|tap|tunnel|bluetooth|zerotier|tailscale|loopback)/i;
  const rank = (ip) =>
    ip.startsWith('192.168.') ? 0
      : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 1
        : ip.startsWith('10.') ? 2 : 3;
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      list.push({ name, address: a.address, virtual: VIRTUAL.test(name) });
    }
  }
  list.sort((x, y) => (x.virtual - y.virtual) || (rank(x.address) - rank(y.address)));
  return list;
}

// ws перевыпускает ошибки http-сервера на самом WebSocketServer, поэтому
// один и тот же обработчик вешаем на оба, иначе EADDRINUSE останется
// необработанным и Node свалится с сырым стектрейсом.
let listenFailed = false;
function onListenError(err) {
  if (listenFailed) return; // событие приходит и от server, и от wss — реагируем один раз
  listenFailed = true;
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  ✖ Порт ${PORT} уже занят.`);
    console.error('    Скорее всего сервер уже запущен в другом окне — закройте его');
    console.error(`    или укажите другой порт:  PORT=3001 npm start`);
    console.error('');
  } else {
    console.error('[server] Ошибка запуска:', err.message);
  }
  process.exit(1);
}
server.on('error', onListenError);
wss.on('error', onListenError);

server.listen(PORT, () => {
  const lans = lanAddresses();
  const lanIp = lans[0] && lans[0].address;
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log('  ║   Графика трансляции спортивной мафии запущена    ║');
  console.log('  ╚══════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Панель ведущего:  http://localhost:${PORT}/control`);
  if (lanIp) console.log(`  ... с планшета:   http://${lanIp}:${PORT}/control`);
  console.log(`  Оверлей для OBS:  http://localhost:${PORT}/overlay  (Browser Source 1920×1080)`);
  if (lans.length > 1) {
    console.log('');
    console.log('  Если адрес планшета не подходит — попробуйте другой из доступных:');
    for (const n of lans) console.log(`    http://${n.address}:${PORT}/control   (${n.name}${n.virtual ? ', виртуальный' : ''})`);
  }
  console.log('');
});

// При остановке — финальный сейв без debounce
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    persistence.flush();
    process.exit(0);
  });
}
