// Скриншот страницы через Chrome DevTools Protocol с реальным ожиданием анимаций.
// Запуск: node test-shot.mjs <url> <out.png> [width] [height]
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [url, out, w = '1920', h = '1080'] = process.argv.slice(2);
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--disable-gpu', '--remote-debugging-port=9777',
  `--window-size=${w},${h}`, '--hide-scrollbars', 'about:blank'
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2500);

const targets = await (await fetch('http://localhost:9777/json')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
ws.on('message', (d) => {
  const msg = JSON.parse(d.toString());
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
});
const cmd = (method, params = {}) => new Promise((resolve) => {
  const id = ++msgId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

await new Promise((r) => ws.on('open', r));
await cmd('Page.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url });
await sleep(3500); // ждём WS-состояние и завершение CSS-переходов
const shot = await cmd('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(`saved ${out}`);
chrome.kill();
process.exit(0);
