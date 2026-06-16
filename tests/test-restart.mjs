// Проверка восстановления из autosave + страниц + загрузки фото
import WebSocket from 'ws';
import sharp from 'sharp';

const expectedGameId = process.argv[2];
let failures = 0;
const check = (name, cond) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${name}`);
  if (!cond) failures++;
};

// 1) состояние восстановлено из autosave.json
const stateMsg = await new Promise((resolve, reject) => {
  const ws = new WebSocket('ws://localhost:3000/ws');
  ws.once('message', (d) => { resolve(JSON.parse(d.toString())); ws.close(); });
  ws.once('error', reject);
});
check('состояние восстановлено после рестарта',
  stateMsg.state.gameId === expectedGameId && stateMsg.state.meta.status === 'finished');
check('лог сохранён', stateMsg.state.log.length > 10);

// 2) страницы открываются
const control = await fetch('http://localhost:3000/control/');
check('/control отвечает 200', control.ok);
const overlay = await fetch('http://localhost:3000/overlay/');
check('/overlay отвечает 200', overlay.ok);
const css = await (await fetch('http://localhost:3000/overlay/overlay.css')).text();
check('у body оверлея прозрачный фон', /body\s*{[^}]*background:\s*transparent/s.test(css));

// 3) загрузка фото: генерируем PNG 1200×800 и шлём multipart
const png = await sharp({
  create: { width: 1200, height: 800, channels: 4, background: { r: 200, g: 60, b: 60, alpha: 1 } }
}).png().toBuffer();
const fd = new FormData();
fd.append('photo', new Blob([png], { type: 'image/png' }), 'test.png');
const up = await fetch('http://localhost:3000/api/upload', { method: 'POST', body: fd });
const upJson = await up.json();
check('upload отвечает url', up.ok && upJson.url && upJson.url.startsWith('/uploads/'));
if (up.ok) {
  const img = await fetch(`http://localhost:3000${upJson.url}`);
  const buf = Buffer.from(await img.arrayBuffer());
  const meta = await sharp(buf).metadata();
  check('ресайз до 600 px по большей стороне', img.ok && meta.width === 600 && meta.height === 400);
}

console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
