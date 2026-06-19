// Обработка и хранение картинок игроков: ресайз + сохранение в uploads/.
// Используется и при ручной загрузке фото, и при импорте аватаров из трекера.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import * as persistence from './persistence.js';

// Ресайз до 600 px по большей стороне и сохранение в uploads/.
// PNG остаётся PNG (прозрачность), остальное — JPEG. Возвращает /uploads/<имя>.
export async function saveImageBuffer(buffer) {
  const meta = await sharp(buffer).metadata();
  const isPng = meta.format === 'png';
  const name = `${randomUUID()}.${isPng ? 'png' : 'jpg'}`;
  let img = sharp(buffer)
    .rotate()
    .resize(600, 600, { fit: 'inside', withoutEnlargement: true });
  img = isPng ? img.png() : img.jpeg({ quality: 85 });
  await img.toFile(path.join(persistence.UPLOADS_DIR, name));
  return `/uploads/${name}`;
}

// Скачать аватар по URL и сохранить локально. Так фото отдаётся с нашего
// сервера (быстро и без зависимости от внешнего хоста в OBS).
// Бросает при сетевой ошибке или не-2xx — вызывающий решает, что делать.
export async function downloadAndSaveAvatar(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return saveImageBuffer(buffer);
}
