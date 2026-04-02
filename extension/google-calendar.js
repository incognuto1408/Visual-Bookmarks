/**
 * Google Calendar API для расширения (chrome.identity + Calendar API readonly).
 * Требует в manifest.json scope https://www.googleapis.com/auth/calendar.readonly
 * и включённый Google Calendar API в Google Cloud Console.
 */
(function (global) {
  const CALENDAR_LIST_URL = 'https://www.googleapis.com/calendar/v3/users/me/calendarList';

  /** Цвета событий по colorId календаря Google */
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

  /** Сбросить кэшированный токен (после смены scope в manifest и т.п.) */
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

  /**
   * @param {object} ev
   * @param {string} calendarId
   * @param {string} [calendarColor] hex с calendarList (backgroundColor)
   */
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

  /** Компоненты даты/времени в заданной IANA-зоне для момента ms (UTC). */
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

  /** UTC-ms момента «календарных» y-mon-day H:Mi:S в зоне tz. */
  function utcMsForWallClock(y, mon, day, H, Mi, S, tz) {
    const approx = Date.UTC(y, mon - 1, day, 12, 0, 0);
    for (let delta = -36 * 3600 * 1000; delta <= 36 * 3600 * 1000; delta += 1000) {
      const ms = approx + delta;
      const p = ymdHmsInZone(ms, tz);
      if (p.y === y && p.mon === mon && p.d === day && p.H === H && p.M === Mi && p.S === S) return ms;
    }
    return Date.UTC(y, mon - 1, day, H, Mi, S);
  }

  /** Сегодняшняя дата (год-месяц-день) в зоне tz. */
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

  /** Смещение для RFC3339 (например +07:00) в момент ms для зоны tz; UTC → Z. */
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

  /**
   * Начало и конец «сегодня» в зоне пользователя (Intl): 00:00:00.000 … 23:59:59.999
   * в RFC3339 со смещением (+07:00 и т.д.), а не toISOString() в Z.
   */
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

  /**
   * События за интервал [timeMin, timeMax) для одного календаря.
   * timeZone — IANA-зона (как в calendar API), для разворота повторов и all-day.
   */
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

  /**
   * Основной календарь аккаунта — тот же, что «по умолчанию» в Google (в списке primary: true, обычно email).
   * Не семейные/общие календари и не подписки вроде «Праздники …».
   */
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

  /**
   * @param {string} token
   * @returns {Promise<Array<{ id: string; title: string; time: string; timeSort: number; color: string }>>}
   */
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
