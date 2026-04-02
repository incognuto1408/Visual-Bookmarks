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

  function calendarDescriptionPlain(raw) {
    if (!raw || typeof raw !== 'string') return '';
    return raw
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2000);
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

    let endD = null;
    if (!isAllDay) {
      const endRaw = ev.end?.dateTime || ev.end?.date;
      if (endRaw) {
        endD = new Date(endRaw);
        if (Number.isNaN(endD.getTime())) endD = null;
      }
    }

    let startTime;
    let endTime = '';
    let time;
    if (isAllDay) {
      startTime = 'Весь день';
      time = 'Весь день';
    } else {
      startTime = formatTime(d);
      if (endD) {
        endTime = formatTime(endD);
        time = endTime && endTime !== startTime ? startTime + ' — ' + endTime : startTime;
      } else {
        time = startTime;
      }
    }

    const description = calendarDescriptionPlain(ev.description || '');

    let color = colorFromEvent(ev);
    if (color === '#4285f4' && calendarColor && /^#[0-9a-fA-F]{6}$/.test(String(calendarColor).trim())) {
      color = String(calendarColor).trim();
    }
    return {
      id: encodeURIComponent(calendarId) + ':' + (ev.id || String(d.getTime()) + title),
      title,
      time,
      startTime,
      endTime,
      description,
      isAllDay: !!isAllDay,
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
    await new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.identity && typeof chrome.identity.clearAllCachedAuthTokens === 'function') {
        chrome.identity.clearAllCachedAuthTokens(() => {
          void chrome.runtime?.lastError;
          resolve();
        });
      } else {
        resolve();
      }
    });
    console.info('[VB Calendar SW]', 'getAuthToken(interactive: true) — выбор аккаунта Google (кэш токенов сброшен)…');
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

/** Кэш favicon между сессиями: один успешный ответ на origin, «промах» не перезапрашиваем до TTL */
const FAVICON_STORAGE_KEY = 'visualBookmarks_favicon_cache_v1';
/** Общая квота chrome.storage.local ~10 MB на всё расширение — не забиваем основной JSON закладок */
const FAVICON_MAX_ENTRIES = 45;
const FAVICON_MAX_CACHE_PAYLOAD_BYTES = 1.5 * 1024 * 1024;
/** Не кладём в один объект слишком тяжёлый data URL */
const FAVICON_MAX_STORED_DATA_URL_LEN = 56 * 1024;
const FAVICON_MISS_RETRY_MS = 3 * 24 * 60 * 60 * 1000;

const faviconMemoryResult = new Map();
const faviconInFlight = new Map();

function faviconOriginKey(pageUrl) {
  try {
    const u = new URL(pageUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin;
  } catch {
    return '';
  }
}

function readFaviconCacheFromStorage() {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local?.get) {
      resolve({});
      return;
    }
    chrome.storage.local.get(FAVICON_STORAGE_KEY, (o) => {
      const v = o && o[FAVICON_STORAGE_KEY];
      resolve(v && typeof v === 'object' ? v : {});
    });
  });
}

function faviconEntryApproxBytes(entry) {
  if (!entry || typeof entry !== 'object') return 16;
  let n = 48;
  if (typeof entry.dataUrl === 'string') n += entry.dataUrl.length;
  if (typeof entry.verifiedUrl === 'string') n += entry.verifiedUrl.length;
  return n;
}

function faviconCacheTotalBytes(cache) {
  return Object.keys(cache).reduce((s, k) => s + faviconEntryApproxBytes(cache[k]), 0);
}

function pruneFaviconCacheObject(cache) {
  let list = Object.keys(cache).sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0));
  let guard = 0;
  while (
    list.length > 0 &&
    (list.length > FAVICON_MAX_ENTRIES || faviconCacheTotalBytes(cache) > FAVICON_MAX_CACHE_PAYLOAD_BYTES) &&
    guard < 500
  ) {
    delete cache[list[0]];
    guard++;
    list = Object.keys(cache).sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0));
  }
  return cache;
}

async function persistFaviconCacheMerge(origin, partial) {
  const cache = await readFaviconCacheFromStorage();
  const at = partial.at != null ? partial.at : Date.now();
  if (partial.miss === true) {
    cache[origin] = { miss: true, at };
  } else {
    cache[origin] = {
      dataUrl: partial.dataUrl,
      verifiedUrl: partial.verifiedUrl || '',
      at,
    };
  }
  pruneFaviconCacheObject(cache);
  if (typeof chrome === 'undefined' || !chrome.storage?.local?.set) return;
  await new Promise((resolve) => {
    chrome.storage.local.set({ [FAVICON_STORAGE_KEY]: cache }, () => {
      if (chrome.runtime.lastError) {
        const msg = chrome.runtime.lastError.message || '';
        console.warn('[VB Favicon] storage.set:', msg);
        const half = Object.keys(cache).sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0));
        const mid = Math.floor(half.length / 2);
        for (let i = 0; i < mid; i++) delete cache[half[i]];
        pruneFaviconCacheObject(cache);
        chrome.storage.local.set({ [FAVICON_STORAGE_KEY]: cache }, () => {
          if (chrome.runtime.lastError) {
            console.error('[VB Favicon] storage.set retry:', chrome.runtime.lastError.message);
          }
          resolve();
        });
        return;
      }
      resolve();
    });
  });
}

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

/** Запасные источники по домену (Gmail и др. часто без отдачи /favicon.ico расширению). */
function externalFallbackFaviconUrls(pageUrl) {
  let u;
  try {
    u = new URL(pageUrl);
  } catch {
    return [];
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return [];
  const host = u.hostname;
  if (!host) return [];
  const dom = host.replace(/^www\./i, '');
  return [
    'https://www.google.com/s2/favicons?sz=64&domain=' + encodeURIComponent(dom),
    'https://icons.duckduckgo.com/ip3/' + encodeURIComponent(host) + '.ico',
  ];
}

/**
 * Один сетевой проход на origin: память SW + chrome.storage.local, single-flight.
 * В памяти SW храним только успешные ответы — иначе после одной неудачи иконки не обновлялись до перезапуска worker.
 */
function getOrFetchFavicon(pageUrl) {
  const origin = faviconOriginKey(pageUrl);
  if (!origin) return Promise.resolve({ ok: false });

  if (faviconMemoryResult.has(origin)) {
    return Promise.resolve(faviconMemoryResult.get(origin));
  }

  let p = faviconInFlight.get(origin);
  if (!p) {
    p = (async () => {
      const disk = await readFaviconCacheFromStorage();
      const ent = disk[origin];
      if (ent && ent.dataUrl && typeof ent.dataUrl === 'string') {
        if (ent.dataUrl.length <= FAVICON_MAX_STORED_DATA_URL_LEN) {
          return { ok: true, dataUrl: ent.dataUrl, verifiedUrl: ent.verifiedUrl || '' };
        }
      }

      const missFresh =
        ent && ent.miss === true && Date.now() - (ent.at || 0) < FAVICON_MISS_RETRY_MS;

      let dataUrl = null;
      let verifiedUrl = null;

      if (!missFresh) {
        for (const u of faviconUrlsToTry(pageUrl)) {
          try {
            const d = await tryFetchVerifiedFavicon(u);
            if (d) {
              dataUrl = d;
              verifiedUrl = u;
              break;
            }
          } catch {
            /* следующий путь */
          }
        }
      }

      if (!dataUrl) {
        for (const u of externalFallbackFaviconUrls(pageUrl)) {
          try {
            const d = await tryFetchVerifiedFavicon(u);
            if (d) {
              dataUrl = d;
              verifiedUrl = u;
              break;
            }
          } catch {
            /* следующий */
          }
        }
      }

      if (dataUrl) {
        if (dataUrl.length <= FAVICON_MAX_STORED_DATA_URL_LEN) {
          await persistFaviconCacheMerge(origin, { dataUrl, verifiedUrl });
        }
        return { ok: true, dataUrl, verifiedUrl };
      }

      await persistFaviconCacheMerge(origin, { miss: true });
      return { ok: false };
    })()
      .then((r) => {
        if (r && r.ok && r.dataUrl) {
          faviconMemoryResult.set(origin, r);
        }
        return r;
      })
      .finally(() => {
        faviconInFlight.delete(origin);
      });
    faviconInFlight.set(origin, p);
  }
  return p;
}

const PAGE_TITLE_FETCH_MS = 9000;
const PAGE_TITLE_MAX_BYTES = 120000;

function parseTitleFromHtmlString(html) {
  if (!html || typeof html !== 'string') return '';
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const el = doc.querySelector('title');
    if (el) {
      const s = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (s) return s;
    }
  } catch (_) {}
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  let s = m[1].replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Текст для поля «описание» закладки: сначала SEO/соц. описание, в конце &lt;title&gt;.
 * @returns {{ text: string; source: string }}
 */
function parseBookmarkSnippetFromHtml(html) {
  if (!html || typeof html !== 'string') return { text: '', source: '' };
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const metaContent = (sel) => {
      const el = doc.querySelector(sel);
      const c = el?.getAttribute('content');
      if (c == null) return '';
      const s = String(c).replace(/\s+/g, ' ').trim();
      return s.length >= 2 ? s : '';
    };
    let t = metaContent('meta[name="description"]');
    if (t) return { text: t, source: 'meta-description' };
    t = metaContent('meta[property="og:description"]');
    if (t) return { text: t, source: 'og-description' };
    t = metaContent('meta[name="twitter:description"]');
    if (t) return { text: t, source: 'twitter-description' };
  } catch (_) {}
  const title = parseTitleFromHtmlString(html);
  if (title) return { text: title, source: 'html-title' };
  return { text: '', source: '' };
}

async function fetchPageSnippetForBookmark(pageUrl) {
  let u;
  try {
    u = new URL(pageUrl);
  } catch {
    return { ok: false };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PAGE_TITLE_FETCH_MS);
  let res;
  try {
    res = await fetch(u.href, {
      method: 'GET',
      redirect: 'follow',
      credentials: 'omit',
      cache: 'default',
      signal: ctrl.signal,
      headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    });
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
  if (!res || !res.ok) return { ok: false };
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('text/html') && !ct.includes('application/xhtml')) return { ok: false };
  try {
    const buf = await res.arrayBuffer();
    const slice = buf.byteLength > PAGE_TITLE_MAX_BYTES ? buf.slice(0, PAGE_TITLE_MAX_BYTES) : buf;
    const html = new TextDecoder('utf-8', { fatal: false }).decode(slice);
    const { text, source } = parseBookmarkSnippetFromHtml(html);
    if (!text) return { ok: false };
    return { ok: true, description: text.slice(0, 500), source };
  } catch {
    return { ok: false };
  }
}

chrome.runtime.onInstalled.addListener(() => {});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'VB_GET_PAGE_SNIPPET') {
    void fetchPageSnippetForBookmark(message.pageUrl).then((r) => {
      try {
        sendResponse(r);
      } catch (e) {
        console.warn('[VB Snippet] sendResponse:', e?.message || e);
      }
    });
    return true;
  }
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
  void getOrFetchFavicon(message.pageUrl).then((r) => {
    try {
      sendResponse(r);
    } catch (e) {
      console.warn('[VB Favicon] sendResponse:', e?.message || e);
    }
  });
  return true;
});
