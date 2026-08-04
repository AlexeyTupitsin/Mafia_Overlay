// Защита панели и API общим токеном.
//
// Выключена, пока в config.json не задан auth.token — без токена сервер
// работает ровно как раньше. Это осознанно: панель открывают перед эфиром, и
// обязательный вход, отказавший в неподходящий момент, хуже, чем открытый
// доступ в доверенной сети клуба.
//
// Что закрывается: /api и /control, а также WS-подключения панели.
// Что остаётся открытым: /overlay, /shared и /uploads — Browser Source в OBS
// не умеет логиниться. Дыру «кто угодно подключится по WS и будет играть»
// закрывает не токен, а read-only режим: действия от соединений с role=overlay
// сервер игнорирует (см. index.js).

import crypto from 'node:crypto';

const COOKIE = 'mafia_auth';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null; // битый percent-encoding — считаем, что куки нет
    }
  }
  return null;
}

const DENIED_PAGE = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><title>Нужен доступ</title>
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; max-width: 520px; margin: 15vh auto; padding: 0 20px; color: #1a1a1a; }
  h1 { font-size: 20px; } code { background: #f2f2f2; padding: 2px 6px; border-radius: 4px; }
</style></head>
<body>
  <h1>Панель закрыта токеном</h1>
  <p>Откройте адрес с токеном в конце: <code>?token=ВАШ_ТОКЕН</code></p>
  <p>Токен задан в <code>config.json</code>, блок <code>auth</code>. После первого захода
  он сохранится в куки — дальше можно открывать обычный адрес.</p>
</body></html>`;

export function createAuth(rawToken) {
  const token = String(rawToken || '');
  const enabled = token.length > 0;
  const expected = Buffer.from(token);

  // Сравнение постоянного времени: длину сверяем отдельно, иначе
  // timingSafeEqual бросает на разных размерах буферов.
  function valid(candidate) {
    const got = Buffer.from(String(candidate || ''));
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  }

  // Токен берём из query (первый заход по ссылке) или из куки (дальше).
  function authorized(req) {
    if (!enabled) return true;
    const url = new URL(req.url || '/', 'http://localhost');
    const fromQuery = url.searchParams.get('token');
    if (fromQuery !== null) return valid(fromQuery);
    return valid(readCookie(req.headers.cookie, COOKIE));
  }

  // Express-middleware для /api и /control.
  function guard(req, res, next) {
    if (!enabled) return next();

    const fromQuery = typeof req.query.token === 'string' ? req.query.token : null;
    if (fromQuery !== null) {
      if (!valid(fromQuery)) return deny(res);
      res.cookie(COOKIE, token, {
        httpOnly: true, // в JS страницы токен не виден
        sameSite: 'lax',
        maxAge: COOKIE_MAX_AGE_MS
      });
      // Убираем токен из адресной строки, чтобы не осел в истории браузера
      // и не уехал в скриншот настроек.
      const clean = req.originalUrl.replace(/([?&])token=[^&]*/, '$1').replace(/[?&]$/, '');
      return res.redirect(clean || req.baseUrl || '/control');
    }

    if (valid(readCookie(req.headers.cookie, COOKIE))) return next();
    return deny(res);
  }

  function deny(res) {
    res.status(401).type('html').send(DENIED_PAGE);
  }

  return { enabled, guard, authorized };
}
