// Поднимает сервер отдельным процессом на свободном порту с изолированными
// каталогами данных. Боевые data/ и uploads/ ведущего тесты не трогают —
// каждый файл тестов работает во временной папке и убирает её за собой.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const READY_TIMEOUT_MS = 20000;

// Порт занимаем и сразу отпускаем: гонка теоретически возможна, но на порядки
// надёжнее фиксированного 3000, который часто занят рабочим сервером ведущего.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitReady(baseUrl, child, deadline) {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`сервер завершился с кодом ${child.exitCode}, не успев подняться`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/roster`);
      if (res.ok) return;
    } catch { /* ещё не слушает — пробуем снова */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`сервер не поднялся за ${READY_TIMEOUT_MS} мс`);
}

/**
 * @param {{ dataDir?: string }} opts dataDir передают при рестарте, чтобы
 *   проверить восстановление из autosave той же песочницы.
 */
export async function startServer({ dataDir } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'mafia-test-'));
  const uploadsDir = path.join(dir, 'uploads');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      MAFIA_DATA_DIR: dir,
      MAFIA_UPLOADS_DIR: uploadsDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // Баннер сервера в вывод тестов не пускаем, но stderr держим — иначе падение
  // на старте выглядит как беспричинный таймаут.
  child.stdout.resume();
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  try {
    await waitReady(baseUrl, child, Date.now() + READY_TIMEOUT_MS);
  } catch (err) {
    child.kill();
    throw new Error(`${err.message}${stderr ? `\nstderr: ${stderr}` : ''}`);
  }

  return {
    port,
    baseUrl,
    dataDir: dir,
    uploadsDir,
    wsUrl: (role = 'control') => `ws://127.0.0.1:${port}/ws?role=${role}`,

    // Останавливает сервер, дождавшись выхода процесса: иначе следующий старт
    // на том же dataDir может застать недописанный autosave.
    //
    // Пауза перед kill не декоративная: на Windows child.kill() убивает процесс
    // через TerminateProcess, обработчик SIGTERM в index.js не отрабатывает и
    // финального flush() не происходит. Ждём чуть дольше debounce автосейва
    // (300 мс), иначе последние действия теста просто не попадут на диск.
    async stop({ waitForSave = true } = {}) {
      if (child.exitCode !== null) return;
      if (waitForSave) await new Promise((r) => setTimeout(r, 500));
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await exited;
    },

    // Удаляет песочницу целиком. Вызывать после stop().
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}
