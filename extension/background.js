/**
 * Код календаря встроен сюда: importScripts(chrome-extension://…/google-calendar.js) в MV3
 * service worker у части сборок Chrome бросает DOMException (NetworkError / SecurityError).
 * Копия логики — в google-calendar.js (подключается в newtab.html для fallback на странице).
 */
(function (global) {
  const CALENDAR_LIST_URL = 'https://www.googleapis.com/calendar/v3/users/me/calendarList';

  const COLOR_BY_ID = {
    1: '#7986cb',
    2: '#33b679',
    3: '#8e24aa',
    4: '#e67c73',
    5: '#f6c026',
    6: '#f4511e',
    7: '#039be5',
    8: '#616161',
    9: '#3f51b5',
    10: '#0b8043',
    11: '#d60000',
  };

  function getAuthToken(interactive) {
    return new Promise((resolve, reject) => {
      if (typeof chrome === 'undefined' || !chrome.identity || typeof chrome.identity.getAuthToken !== 'function') {
        reject(new Error('OAuth Google доступен только внутри расширения Chrome'));
        return;
      }
      chrome.identity.getAuthToken({ interactive: !!interactive }, (token) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(token || null);
      });
    });
  }

  function removeCachedAuthToken(token) {
    return new Promise((resolve) => {
      if (!token || typeof chrome === 'undefined' || !chrome.identity?.removeCachedAuthToken) {
        resolve();
        return;
      }
      chrome.identity.removeCachedAuthToken({ token }, () => resolve());
    });
  }

  function colorFromEvent(ev) {
    if (ev.colorId && COLOR_BY_ID[String(ev.colorId)]) return COLOR_BY_ID[String(ev.colorId)];
    return '#4285f4';
  }

  function formatTime(d) {
    try {
      return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  function parseEvent(ev, calendarId, calendarColor) {
    if (!ev || ev.status === 'cancelled') return null;
    const title = (ev.summary && String(ev.summary).trim()) || '(Без названия)';
    const isAllDay = !!(ev.start && ev.start.date && !ev.start.dateTime);
    const startRaw =
      ev.start?.dateTime || ev.start?.date || ev.originalStartTime?.dateTime || ev.originalStartTime?.date;
    if (!startRaw) return null;
    const d = new Date(startRaw);
    if (Number.isNaN(d.getTime())) return null;
    const time = isAllDay ? 'Весь день' : formatTime(d);
    let color = colorFromEvent(ev);
    if (color === '#4285f4' && calendarColor && /^#[0-9a-fA-F]{6}$/.test(String(calendarColor).trim())) {
      color = String(calendarColor).trim();
    }
    return {
      id: encodeURIComponent(calendarId) + ':' + (ev.id || String(d.getTime()) + title),
      title,
      time,
      timeSort: d.getTime(),
      color,
    };
  }

  function httpError(res, body) {
    const err = new Error(body.slice(0, 400) || res.statusText || 'HTTP ' + res.status);
    err.status = res.status;
    return err;
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function pad3(n) {
    return String(n).padStart(3, '0');
  }

  function ymdHmsInZone(ms, tz) {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    const parts = f.formatToParts(new Date(ms));
    const g = (t) => parts.find((p) => p.type === t)?.value;
    return {
      y: +g('year'),
      mon: +g('month'),
      d: +g('day'),
      H: +g('hour'),
      M: +g('minute'),
      S: +g('second'),
    };
  }

  function utcMsForWallClock(y, mon, day, H, Mi, S, tz) {
    const approx = Date.UTC(y, mon - 1, day, 12, 0, 0);
    for (let delta = -36 * 3600 * 1000; delta <= 36 * 3600 * 1000; delta += 1000) {
      const ms = approx + delta;
      const p = ymdHmsInZone(ms, tz);
      if (p.y === y && p.mon === mon && p.d === day && p.H === H && p.M === Mi && p.S === S) return ms;
    }
    return Date.UTC(y, mon - 1, day, H, Mi, S);
  }

  function todayYmdInZone(tz) {
    const f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const s = f.format(new Date());
    const [y, m, d] = s.split('-').map(Number);
    return { y, m, d };
  }

  function longOffsetToRfc3339Offset(ms, tz) {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'longOffset',
    });
    const parts = f.formatToParts(new Date(ms));
    let raw = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT+00:00';
    raw = String(raw).replace(/\u2212/g, '-').replace(/\s/g, '');
    const m = raw.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/i);
    if (!m) return 'Z';
    const sign = m[1];
    const hh = m[2].padStart(2, '0');
    const mm = (m[3] || '00').padStart(2, '0');
    const off = `${sign}${hh}:${mm}`;
    if (off === '+00:00' || off === '-00:00') return 'Z';
    return off;
  }

  function formatRfc3339WallClock(y, mon, day, H, Mi, S, fracMs, off) {
    const base = `${y}-${pad2(mon)}-${pad2(day)}T${pad2(H)}:${pad2(Mi)}:${pad2(S)}.${pad3(fracMs)}`;
    return off === 'Z' ? base + 'Z' : base + off;
  }

  function localCalendarDayBoundsRfc3339(tz) {
    const zone = tz || 'UTC';
    const { y, m, d } = todayYmdInZone(zone);
    const startMs = utcMsForWallClock(y, m, d, 0, 0, 0, zone);
    const endMs = utcMsForWallClock(y, m, d, 23, 59, 59, zone) + 999;
    const offStart = longOffsetToRfc3339Offset(startMs, zone);
    const offEnd = longOffsetToRfc3339Offset(endMs, zone);
    return {
      timeMin: formatRfc3339WallClock(y, m, d, 0, 0, 0, 0, offStart),
      timeMax: formatRfc3339WallClock(y, m, d, 23, 59, 59, 999, offEnd),
    };
  }

  async function fetchEventsForCalendar(token, calendarId, timeMin, timeMax, timeZone, calendarColor) {
    const params = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin,
      timeMax,
      maxResults: '250',
      timeZone: timeZone || 'UTC',
    });
    const pathId = encodeURIComponent(calendarId);
    const url = 'https://www.googleapis.com/calendar/v3/calendars/' + pathId + '/events?' + params.toString();
    const res = await fetch(url, {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (res.status === 401) {
      const err = new Error('UNAUTHORIZED');
      err.status = 401;
      throw err;
    }
    if (!res.ok) {
      const t = await res.text();
      throw httpError(res, t);
    }
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    return items.map((ev) => parseEvent(ev, calendarId, calendarColor)).filter(Boolean);
  }

  async function fetchPrimaryCalendarEntry(token) {
    const url =
      CALENDAR_LIST_URL + '?' + new URLSearchParams({ minAccessRole: 'reader', maxResults: '250' }).toString();
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) {
      const t = await res.text();
      throw httpError(res, t);
    }
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    const primary = items.find((c) => c && c.primary === true);
    if (primary && primary.id) {
      return { id: primary.id, backgroundColor: primary.backgroundColor };
    }
    return null;
  }

  async function fetchTodayEvents(token) {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const { timeMin, timeMax } = localCalendarDayBoundsRfc3339(timeZone);

    let calendarId = 'primary';
    let calendarColor;
    try {
      const entry = await fetchPrimaryCalendarEntry(token);
      if (entry) {
        calendarId = entry.id;
        calendarColor = entry.backgroundColor;
      }
    } catch (e) {
      /* остаётся calendarId = 'primary' */
    }

    const rows = await fetchEventsForCalendar(token, calendarId, timeMin, timeMax, timeZone, calendarColor);
    rows.sort((a, b) => a.timeSort - b.timeSort);
    return rows;
  }

  global.VisualBookmarksCalendar = {
    getAuthToken,
    fetchTodayEvents,
    removeCachedAuthToken,
  };
})(typeof self !== 'undefined' ? self : window);

/**
 * Google Calendar в worker: не блокирует поток новой вкладки (OAuth + fetch вне страницы).
 */
async function fetchCalendarTodayInWorker() {
  const VBC = typeof self !== 'undefined' ? self.VisualBookmarksCalendar : null;
  if (!VBC || typeof VBC.getAuthToken !== 'function') {
    return { ok: false, events: [], error: 'calendar module' };
  }
  const shouldRetryAuth = (err) => {
    const st = err && err.status;
    if (st === 401 || st === 403) return true;
    const m = String((err && err.message) || err || '');
    return (
      m.includes('401') ||
      m.includes('UNAUTHORIZED') ||
      m.includes('Invalid Credentials') ||
      (m.includes('403') && (m.includes('insufficient') || m.includes('Insufficient')))
    );
  };
  try {
    let token = await VBC.getAuthToken(false);
    if (!token) return { ok: false, events: [], error: 'no token' };
    try {
      const events = await VBC.fetchTodayEvents(token);
      return { ok: true, events: Array.isArray(events) ? events : [] };
    } catch (apiErr) {
      if (shouldRetryAuth(apiErr) && typeof VBC.removeCachedAuthToken === 'function') {
        await VBC.removeCachedAuthToken(token);
        token = await VBC.getAuthToken(true);
        if (token) {
          const events = await VBC.fetchTodayEvents(token);
          return { ok: true, events: Array.isArray(events) ? events : [] };
        }
      }
      throw apiErr;
    }
  } catch (e) {
    return { ok: false, events: [], error: String((e && e.message) || e) };
  }
}

/**
 * Первое подключение: интерактивный OAuth + загрузка событий в worker, без блокировки потока new tab.
 */
async function connectCalendarInWorker() {
  console.info('[VB Calendar SW]', 'connectCalendarInWorker: старт');
  const VBC = typeof self !== 'undefined' ? self.VisualBookmarksCalendar : null;
  if (!VBC || typeof VBC.getAuthToken !== 'function') {
    console.warn('[VB Calendar SW]', 'нет VisualBookmarksCalendar (модуль не инициализирован в worker)');
    return { ok: false, events: [], error: 'calendar module' };
  }
  const shouldRetryAuth = (err) => {
    const st = err && err.status;
    if (st === 401 || st === 403) return true;
    const m = String((err && err.message) || err || '');
    return (
      m.includes('401') ||
      m.includes('UNAUTHORIZED') ||
      m.includes('Invalid Credentials') ||
      (m.includes('403') && (m.includes('insufficient') || m.includes('Insufficient')))
    );
  };
  try {
    console.info('[VB Calendar SW]', 'getAuthToken(interactive: true) — может открыться окно Google…');
    let token = await VBC.getAuthToken(true);
    if (!token) {
      console.warn('[VB Calendar SW]', 'токен пустой после getAuthToken');
      return { ok: false, events: [], error: 'no token' };
    }
    try {
      console.info('[VB Calendar SW]', 'fetchTodayEvents…');
      const events = await VBC.fetchTodayEvents(token);
      const list = Array.isArray(events) ? events : [];
      console.info('[VB Calendar SW]', 'готово, событий:', list.length);
      return { ok: true, events: list };
    } catch (apiErr) {
      console.warn('[VB Calendar SW]', 'fetchTodayEvents ошибка:', apiErr?.message || apiErr);
      if (shouldRetryAuth(apiErr) && typeof VBC.removeCachedAuthToken === 'function') {
        await VBC.removeCachedAuthToken(token);
        token = await VBC.getAuthToken(true);
        if (token) {
          const events = await VBC.fetchTodayEvents(token);
          const list = Array.isArray(events) ? events : [];
          console.info('[VB Calendar SW]', 'повтор после refresh токена, событий:', list.length);
          return { ok: true, events: list };
        }
      }
      throw apiErr;
    }
  } catch (e) {
    console.warn('[VB Calendar SW]', 'connectCalendarInWorker catch:', e?.message || e);
    return { ok: false, events: [], error: String((e && e.message) || e) };
  }
}

/**
 * Проверка favicon только с сайта закладки (service worker обходит CORS newtab).
 * Если ответ не похож на картинку — иконки «нет», newtab покажет fallback-earth.svg.
 */
const MAX_FAVICON_BYTES = 512 * 1024;
const MIN_FAVICON_BYTES = 16;

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

function detectImageMimeFromBytes(buf) {
  const a = new Uint8Array(buf.slice(0, Math.min(64, buf.byteLength)));
  if (a.length < 4) return null;
  if (a[0] === 0x89 && a[1] === 0x50 && a[2] === 0x4e && a[3] === 0x47) return 'image/png';
  if (a[0] === 0xff && a[1] === 0xd8 && a[2] === 0xff) return 'image/jpeg';
  if (a[0] === 0x47 && a[1] === 0x49 && a[2] === 0x46 && a[3] === 0x38) return 'image/gif';
  if (a[0] === 0x52 && a[1] === 0x49 && a[2] === 0x46 && a[3] === 0x46 && a.length >= 12) {
    if (a[8] === 0x57 && a[9] === 0x45 && a[10] === 0x42 && a[11] === 0x50) return 'image/webp';
  }
  if (a[0] === 0x00 && a[1] === 0x00 && a[2] === 0x01 && a[3] === 0x00) return 'image/x-icon';
  if (a[0] === 0x00 && a[1] === 0x00 && a[2] === 0x02 && a[3] === 0x00) return 'image/x-icon';
  if (a[0] === 0x3c) {
    const head = new TextDecoder('utf-8', { fatal: false }).decode(a);
    if (/<svg[\s>/]/i.test(head)) return 'image/svg+xml';
  }
  const asText = new TextDecoder('utf-8', { fatal: false }).decode(a);
  if (/<svg[\s>/]/i.test(asText.trimStart())) return 'image/svg+xml';
  return null;
}

function isProbablyHtmlBody(buf) {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(buf.slice(0, 256))).trimStart().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<head');
}

const FAVICON_FETCH_MS = 8000;

async function tryFetchVerifiedFavicon(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FAVICON_FETCH_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      credentials: 'omit',
      cache: 'force-cache',
      signal: ctrl.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!res || !res.ok) return null;
  const ctRaw = res.headers.get('content-type') || '';
  const ct = ctRaw.toLowerCase();
  if (ct.includes('text/html')) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength < MIN_FAVICON_BYTES || buf.byteLength > MAX_FAVICON_BYTES) return null;
  if (isProbablyHtmlBody(buf)) return null;
  let mime = detectImageMimeFromBytes(buf);
  if (!mime) {
    const main = ct.split(';')[0].trim().toLowerCase();
    if (main.startsWith('image/')) mime = main;
  }
  if (!mime) return null;
  const base64 = arrayBufferToBase64(buf);
  return 'data:' + mime + ';base64,' + base64;
}

function faviconUrlsToTry(pageUrl) {
  let u;
  try {
    u = new URL(pageUrl);
  } catch {
    return [];
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return [];
  const o = u.origin;
  return [o + '/favicon.ico', o + '/favicon.png'];
}

chrome.runtime.onInstalled.addListener(() => {});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'VB_CALENDAR_SW_WAKE') {
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'VB_CALENDAR_TODAY') {
    void fetchCalendarTodayInWorker().then((r) => sendResponse(r));
    return true;
  }
  if (message?.type === 'VB_CALENDAR_CONNECT') {
    console.info('[VB Calendar SW]', 'сообщение VB_CALENDAR_CONNECT от new tab');
    void connectCalendarInWorker().then((r) => {
      console.info('[VB Calendar SW]', 'sendResponse connect:', r?.ok, r?.error || '', 'events:', Array.isArray(r?.events) ? r.events.length : '—');
      try {
        sendResponse(r);
      } catch (err) {
        console.warn('[VB Calendar SW]', 'sendResponse failed (канал закрыт?):', err?.message || err);
      }
    });
    return true;
  }
  if (message?.type !== 'VB_GET_FAVICON') return false;
  (async () => {
    const urls = faviconUrlsToTry(message.pageUrl);
    if (!urls.length) {
      sendResponse({ ok: false });
      return;
    }
    for (const u of urls) {
      try {
        const dataUrl = await tryFetchVerifiedFavicon(u);
        if (dataUrl) {
          sendResponse({ ok: true, dataUrl, verifiedUrl: u });
          return;
        }
      } catch {
        /* сеть / DNS — следующий путь */
      }
    }
    sendResponse({ ok: false });
  })();
  return true;
});
