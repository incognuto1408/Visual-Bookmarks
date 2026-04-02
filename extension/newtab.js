/** Плитка ждёт цвет из favicon (после загрузки подставляется hex) */
const FAVICON_BG = '__favicon__';
/** Цвет плитки по умолчанию, если значение битое или пустое */
const DEFAULT_TILE_BG = '#3b82f6';

/**
 * Допустимы: маркер favicon, #rgb / #rgba / #rrggbb / #rrggbbaa, linear-gradient(...), rgb()/rgba().
 * Иначе (например #100c000 — 7 hex-символов) — fallback, чтобы не ломать CSS.
 */
function sanitizeBookmarkBackgroundColor(raw, fallback = DEFAULT_TILE_BG) {
  if (raw === FAVICON_BG) return FAVICON_BG;
  if (raw == null || String(raw).trim() === '') return fallback;
  const s = String(raw).trim();
  if (s === FAVICON_BG) return FAVICON_BG;
  if (/^linear-gradient\s*\(/i.test(s)) return s;
  if (/^rgba?\s*\(/i.test(s)) return s;
  if (
    /^#[0-9a-fA-F]{3}$/.test(s) ||
    /^#[0-9a-fA-F]{4}$/.test(s) ||
    /^#[0-9a-fA-F]{6}$/.test(s) ||
    /^#[0-9a-fA-F]{8}$/.test(s)
  ) {
    return s;
  }
  return fallback;
}

const STORAGE_KEY = 'visualBookmarks_state_v2';
const STORAGE_KEY_LEGACY = 'visualBookmarks_state_v1';
/** Кэш иконок в background.js; при QUOTA очищаем, чтобы снова сохранялись закладки (тот же ключ, что в background.js). */
const FAVICON_CACHE_STORAGE_KEY = 'visualBookmarks_favicon_cache_v1';
/** Одноразовая миграция: старый ключ chrome.storage (data URL) → IndexedDB, затем ключ удаляется */
const LEGACY_CHROME_CUSTOM_BG_KEY = 'visualBookmarks_customBg_dataUrl_v1';
/** Кэш событий календаря: 1 ч при непустом ответе, 2 мин при пустом (чтобы не «залипать» на ошибке/токене). */
const STORAGE_KEY_CALENDAR_CACHE = 'visualBookmarks_calendar_events_cache_v2';
const STORAGE_KEY_CALENDAR_CACHE_LEGACY = 'visualBookmarks_calendar_events_cache_v1';
const CALENDAR_CACHE_TTL_MS = 60 * 60 * 1000;
const CALENDAR_EMPTY_CACHE_TTL_MS = 2 * 60 * 1000;
const CUSTOM_BG_MARKER = '__VB_CUSTOM_BG__';
/** Подложка под фон (до загрузки картинки, custom из IDB, невалидный URL) */
const PAGE_BG_GROUND_COLOR = '#ffffff';
/** Синхронное зеркало для первого кадра новой вкладки (stale-while-revalidate с chrome.storage) */
const LOCAL_BOOT_CACHE_KEY = 'visualBookmarks_newtab_boot_v1';
const LOCAL_BOOT_BG_KEY = 'visualBookmarks_newtab_boot_bg_v1';
const BOOT_CACHE_VERSION = 1;
const SYNC_DEBOUNCE_MS = 2500;

/** В консоли: localStorage.setItem('VB_DEBUG_STORAGE','1'); reload — логи чтения/записи chrome.storage.local. @returns {boolean} */
function vbDebugStorage() {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('VB_DEBUG_STORAGE') === '1';
  } catch {
    return false;
  }
}

/** uiLanguage из зеркала localStorage до async loadState — чтобы подгрузить нужный locales/*.json до первого renderAll */
function peekSettingsForI18n() {
  if (typeof localStorage === 'undefined') return { uiLanguage: 'auto' };
  try {
    const raw = localStorage.getItem(LOCAL_BOOT_CACHE_KEY);
    if (!raw) return { uiLanguage: 'auto' };
    const o = JSON.parse(raw);
    if (o && o.settings && typeof o.settings === 'object') return o.settings;
  } catch (_) {}
  return { uiLanguage: 'auto' };
}

let pageBgObjectUrl = null;
/** Подпись последнего применённого фона — без повторной очистки style при лишних renderAll() */
let pageBgApplySig = '';
/** Инкремент при уходе с кастомного IDB-фона, чтобы отбросить поздний ответ async */
let idbBgPaintGen = 0;
/** Один активный запрос фона из IndexedDB (второй renderAll до готовности не сбрасывает DOM) */
let idbBgPaintPromise = null;

function revokePageBgObjectUrl() {
  if (pageBgObjectUrl) {
    try {
      URL.revokeObjectURL(pageBgObjectUrl);
    } catch (_) {}
    pageBgObjectUrl = null;
  }
}

function isCustomBackgroundMarker(bg) {
  return !!(bg && bg.type === 'image' && bg.value === CUSTOM_BG_MARKER);
}

async function abandonCustomBackgroundBlobIfAny() {
  revokePageBgObjectUrl();
  if (typeof VisualBookmarksCustomBg !== 'undefined') {
    try {
      await VisualBookmarksCustomBg.clear();
    } catch (_) {}
  }
}

async function migrateAndRemoveLegacyCustomBgFromChromeStorage() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const t = setTimeout(() => {
      console.warn('[VB] Миграция legacy custom bg: таймаут — продолжаем загрузку (возможна потеря миграции фона)');
      finish();
    }, 12000);

    if (typeof storageLocal.get !== 'function') {
      clearTimeout(t);
      finish();
      return;
    }

    storageLocal.get([LEGACY_CHROME_CUSTOM_BG_KEY], (res) => {
      void (async () => {
        try {
          const d = res && res[LEGACY_CHROME_CUSTOM_BG_KEY];
          if (typeof d === 'string' && d.startsWith('data:') && typeof VisualBookmarksCustomBg !== 'undefined') {
            try {
              await Promise.race([
                VisualBookmarksCustomBg.saveFromDataUrl(d),
                new Promise((_, rej) => setTimeout(() => rej(new Error('saveFromDataUrl timeout')), 20000)),
              ]);
            } catch (e) {
              console.warn('VB: миграция фона chrome.storage → IndexedDB', e);
            }
          }
        } finally {
          try {
            if (typeof storageLocal.remove === 'function') {
              storageLocal.remove([LEGACY_CHROME_CUSTOM_BG_KEY], () => {
                clearTimeout(t);
                finish();
              });
            } else {
              clearTimeout(t);
              finish();
            }
          } catch {
            clearTimeout(t);
            finish();
          }
        }
      })();
    });
  });
}

async function paintCustomBackgroundFromIdb(el, gen) {
  if (!el) return;
  if (typeof gen === 'number' && gen !== idbBgPaintGen) return;
  if (typeof VisualBookmarksCustomBg === 'undefined') {
    el.style.backgroundColor = PAGE_BG_GROUND_COLOR;
    return;
  }
  try {
    const blob = await VisualBookmarksCustomBg.loadBlob();
    if (typeof gen === 'number' && gen !== idbBgPaintGen) return;
    if (!blob) {
      el.style.backgroundColor = PAGE_BG_GROUND_COLOR;
      return;
    }
    revokePageBgObjectUrl();
    pageBgObjectUrl = URL.createObjectURL(blob);
    el.style.backgroundImage = 'url("' + pageBgObjectUrl.replace(/"/g, '\\"') + '")';
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
  } catch (e) {
    console.warn('VB: фон из IndexedDB', e);
    if (typeof gen === 'number' && gen !== idbBgPaintGen) return;
    el.style.backgroundColor = PAGE_BG_GROUND_COLOR;
  }
}

async function flushTransientDataUrlBackgroundToIdbIfAny() {
  const bg = app.settings?.background;
  if (bg?.type !== 'image' || typeof bg.value !== 'string' || !bg.value.startsWith('data:')) return;
  if (typeof VisualBookmarksCustomBg === 'undefined') return;
  try {
    await VisualBookmarksCustomBg.saveFromDataUrl(bg.value);
    app.settings.background = { type: 'image', value: CUSTOM_BG_MARKER };
  } catch (e) {
    console.warn('VB: сохранение фона в IndexedDB', e);
  }
}
/** Интервал между успешными синхронизациями Crypt-Chain (мс); таймер отсчитывается от `lastServerSyncAt` */
const SERVER_PULL_INTERVAL_MS = 60 * 1000;

const PRESET_BACKGROUNDS = [
  { id: 'earth', value: 'https://images.unsplash.com/photo-1451186859696-371d9477be93?w=1920&q=80' },
  { id: 'mountains', value: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1920&q=80' },
  { id: 'forest', value: 'https://images.unsplash.com/photo-1448375240586-882707db888b?w=1920&q=80' },
  { id: 'lake', value: 'https://images.unsplash.com/photo-1439066615861-d1af74d74000?w=1920&q=80' },
  { id: 'cyclist', value: 'https://images.unsplash.com/photo-1541625602330-2277a4c46182?w=1920&q=80' },
  { id: 'sunset', value: 'https://images.unsplash.com/photo-1495616811223-4d98c6e9c869?w=1920&q=80' },
  { id: 'ocean', value: 'https://images.unsplash.com/photo-1505118380757-91f5f5632de0?w=1920&q=80' },
  { id: 'desert', value: 'https://images.unsplash.com/photo-1509316785289-025f5b846b35?w=1920&q=80' },
  { id: 'autumn', value: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=1920&q=80' },
  { id: 'night', value: 'https://images.unsplash.com/photo-1419242902214-272b3f66ee7a?w=1920&q=80' },
];

const SEARCH_ENGINES = [
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=', icon: 'https://www.google.com/favicon.ico', placeholder: 'Поиск в Google' },
  { id: 'yandex', name: 'Яндекс', url: 'https://yandex.ru/search/?text=', icon: 'https://yandex.ru/favicon.ico', placeholder: 'Поиск в Яндексе' },
  { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=', icon: 'https://duckduckgo.com/favicon.ico', placeholder: 'Поиск в DuckDuckGo' },
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=', icon: 'https://www.bing.com/favicon.ico', placeholder: 'Поиск в Bing' },
];

const PRESET_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899', '#1e3a5f', '#0d1b2a', '#2d1b4e', '#1a1a1a', '#374151', '#ffffff', '#f3f4f6', '#d1d5db'];

const MOCK_STABILITY = {
  usdt: 7638,
  rend: 10.7,
  stab: 2744.14,
  rendDp: 13202.95,
  totalBalance: 30620.79,
  stabUsdtRate: 3.56,
  masterDepoProfit: 0.15,
  masterDepoProfitDirection: 'down',
  packageType: 'Royal',
  rank: 'Regional Director',
  keyType: 'Platinum',
  sabStatus: 'VIP Plus Free (14)',
};

const MOCK_NOTIFICATIONS = [
  { id: 1, text: 'Начислены проценты по Smart Saving: +12.5 STAB', time: '5 мин назад', read: false },
  { id: 2, text: 'Обновлен курс STAB/USDT', time: '1 час назад', read: false },
  { id: 3, text: 'Новая акция: бонус 10% на пополнение', time: '3 часа назад', read: true },
];

const DEFAULT_SETTINGS = {
  background: { type: 'preset', value: PRESET_BACKGROUNDS[0].value },
  searchEngine: 'google',
  showSearch: true,
  gridColumns: 5,
  maxBookmarks: 100,
  bookmarkView: 'icons',
  showBookmarksBar: false,
  showInfoPanel: false,
  showStabilityInfo: false,
  /** false — поиск и закладки открываются в этой же вкладке */
  openLinksInNewTab: false,
  changeBgDaily: false,
  theme: 'auto',
  /** auto | ru | uk | en | hy — при auto язык берётся из UI браузера */
  uiLanguage: 'auto',
  _lastBgDay: null,
  /** Виджет Google Календаря на новой вкладке */
  showCalendar: true,
  /** Пользователь прошёл OAuth и хочет показывать события календаря */
  googleCalendarEnabled: false,
};

/** Стартовые закладки: цвет фона подбирается из логотипа (favicon) после первого запуска */
const DEFAULT_BOOKMARKS = [
  { title: 'Stability — платформа', url: 'https://stabilityin.com/', backgroundColor: FAVICON_BG, order: 0, clickCount: 0 },
  { title: 'Stability — кабинет', url: 'https://accounts.stabilityin.com/', backgroundColor: FAVICON_BG, order: 1, clickCount: 0 },
  { title: 'Stability.top', url: 'http://stability.top/', backgroundColor: FAVICON_BG, order: 2, clickCount: 0 },
  { title: 'MyReserve', url: 'https://myreserve.ai/', backgroundColor: FAVICON_BG, order: 3, clickCount: 0 },
  { title: 'MyExchange — swap', url: 'https://myexchange.ai/swap', backgroundColor: FAVICON_BG, order: 4, clickCount: 0 },
  { title: 'MyCurrency — кабинет', url: 'https://mycurrency.ai/account/dashboard', backgroundColor: FAVICON_BG, order: 5, clickCount: 0 },
  { title: 'YouTube — Stability', url: 'https://www.youtube.com/@StabilityInternational', backgroundColor: FAVICON_BG, order: 6, clickCount: 0 },
  { title: 'Instagram — stability.top', url: 'https://www.instagram.com/stability.top/', backgroundColor: FAVICON_BG, order: 7, clickCount: 0 },
];

/** Расширение: chrome.storage. Вне расширения (file:// и т.д.) — localStorage, чтобы не падать на chrome.storage === undefined */
const storageLocal = (() => {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    return chrome.storage.local;
  }
  return {
    get(keys, callback) {
      try {
        const out = {};
        const list = Array.isArray(keys) ? keys : [keys];
        list.forEach((k) => {
          const raw = localStorage.getItem(k);
          if (raw != null) {
            try {
              out[k] = JSON.parse(raw);
            } catch {
              out[k] = raw;
            }
          }
        });
        queueMicrotask(() => callback(out));
      } catch {
        queueMicrotask(() => callback({}));
      }
    },
    set(obj, callback) {
      try {
        Object.keys(obj).forEach((k) => {
          localStorage.setItem(k, JSON.stringify(obj[k]));
        });
      } catch (_) {}
      queueMicrotask(() => callback && callback());
    },
    remove(keys, callback) {
      try {
        const list = Array.isArray(keys) ? keys : [keys];
        list.forEach((k) => localStorage.removeItem(k));
      } catch (_) {}
      queueMicrotask(() => callback && callback());
    },
  };
})();

function getExtensionManifest() {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getManifest === 'function') {
      return chrome.runtime.getManifest();
    }
  } catch (_) {}
  return { oauth2: { client_id: '' } };
}

function isExtensionContext() {
  return typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
}

/** @type {{ updatedAt: number; bookmarks: any[]; settings: typeof DEFAULT_SETTINGS; user: any | null; lastServerSyncAt: number | null }} */
let app = {
  updatedAt: 0,
  bookmarks: [],
  settings: { ...DEFAULT_SETTINGS },
  user: null,
  /** Успешный обмен с Crypt-Chain (pull/push); следующий фоновый pull не раньше чем через минуту отсюда */
  lastServerSyncAt: null,
};

function tr(key) {
  return typeof VisualBookmarksI18n !== 'undefined' ? VisualBookmarksI18n.t(key) : key;
}
function trR(key, vars) {
  return typeof VisualBookmarksI18n !== 'undefined' ? VisualBookmarksI18n.tReplace(key, vars) : key;
}
async function syncI18n() {
  if (typeof VisualBookmarksI18n === 'undefined') return;
  try {
    await VisualBookmarksI18n.loadPacks(app.settings);
  } catch (e) {
    console.warn('VB i18n loadPacks:', e);
  }
  VisualBookmarksI18n.syncFromSettings(app.settings);
  VisualBookmarksI18n.applyDom(document);
}

let editingBookmarkId = null;
let pendingDeleteBookmarkId = null;
let pendingDeleteProgress = 0;
let pendingDeleteIntervalId = null;
let pendingDeleteStartMs = 0;
const BOOKMARK_DELETE_COUNTDOWN_MS = 3000;
let authMode = 'login';
let settingsTab = 'appearance';
let bgPage = 0;
let engineMenuOpen = false;
let profileMenuOpen = false;
let draggedGridIndex = null;
let dragOverGridIndex = null;
let stabilityExpanded = false;
let stabilityNotifOpen = false;
let notifications = MOCK_NOTIFICATIONS.map((n) => ({ ...n }));
let bmAutoColor = false;
/** Пользователь вручную менял цвет в модалке (иначе при «Добавить» цвет берётся с favicon) */
let bmColorUserTouched = false;
/** Ввод в поле описания — не перезаписывать авто-подставленным заголовком страницы */
let bmDescUserEdited = false;
let bmDescAutofillTimer = null;
let bmDescAutofillGen = 0;
const BM_DESC_AUTOFILL_DEBOUNCE_MS = 550;

/** События primary-календаря на сегодня (Google Calendar API) */
let calendarEvents = [];
let calendarEventIndex = 0;
let calendarRotateTimer = null;
/** Повторный клик «Подключить календарь», пока ждём service worker / OAuth */
let calendarConnectInFlight = false;
/** Логи в консоли new tab: фильтр по строке `[VB Calendar]` */
const VB_CALENDAR_DEBUG = true;
function logCalendarConnect(...args) {
  if (VB_CALENDAR_DEBUG) console.info('[VB Calendar]', ...args);
}

/** Спиннер + disabled на кнопках подключения календаря (модалка и настройки). */
function setCalendarConnectButtonsLoading(loading) {
  const nodes = [
    document.getElementById('btnCalendarModalConnect'),
    document.getElementById('btnCalendarSettingsConnect'),
  ];
  for (const b of nodes) {
    if (!b) continue;
    b.disabled = !!loading;
    b.classList.toggle('vb-btn-loader', !!loading);
    if (loading) b.setAttribute('aria-busy', 'true');
    else b.removeAttribute('aria-busy');
  }
}

const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error('#' + id);
  return el;
};

function generateId() {
  return crypto.randomUUID();
}

function normalizeUrl(raw) {
  const t = String(raw || '').trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  return 'https://' + t;
}

/**
 * Валидный http(s) URL для закладки или null. Без схемы подставляется https://.
 * Отклоняет javascript:, data:, пустой хост, непарсящийся ввод.
 */
function tryNormalizeBookmarkUrl(raw) {
  const t = String(raw || '').trim();
  if (!t) return null;
  const compact = t.replace(/\s/g, '');
  if (!compact) return null;
  const candidate = /^https?:\/\//i.test(compact) ? compact : 'https://' + compact;
  let u;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  const p = u.protocol.toLowerCase();
  if (p !== 'http:' && p !== 'https:') return null;
  const host = u.hostname;
  if (!host || /\s/.test(host)) return null;
  return u.href;
}

function defaultBookmarkTitleFromUrl(canonicalUrl) {
  try {
    const h = new URL(canonicalUrl).hostname.replace(/^www\./i, '');
    return h || canonicalUrl;
  } catch {
    return canonicalUrl;
  }
}

function tabUrlMatchesBookmarkEntry(tabUrl, bookmarkCanonical) {
  try {
    const t = new URL(tabUrl);
    const b = new URL(bookmarkCanonical);
    if (t.origin !== b.origin) return false;
    const norm = (p) => {
      const x = (p || '/').replace(/\/$/, '');
      return x === '' ? '/' : x;
    };
    const bt = norm(b.pathname);
    const tt = norm(t.pathname);
    if (bt === '/') return true;
    return tt === bt || tt.startsWith(bt + '/');
  } catch {
    return false;
  }
}

function isUnusableAutoBookmarkTitle(t) {
  const s = String(t || '').trim().toLowerCase();
  if (s.length < 2) return true;
  if (/^https?:\/\//i.test(s)) return true;
  const bad = [
    'new tab',
    'новая вкладка',
    'нова вкладка',
    'about:blank',
    'chrome://',
    'visual bookmarks',
  ];
  return bad.some((b) => s.includes(b));
}

function tryGetBookmarkTitleFromOpenTab(canonicalUrl) {
  return new Promise((resolve) => {
    if (!isExtensionContext() || typeof chrome === 'undefined' || !chrome.tabs?.query) {
      resolve(null);
      return;
    }
    chrome.tabs.query({ currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError || !tabs?.length) {
        resolve(null);
        return;
      }
      let best = null;
      for (const tab of tabs) {
        if (!tab.url || !/^https?:/i.test(tab.url)) continue;
        if (!tabUrlMatchesBookmarkEntry(tab.url, canonicalUrl)) continue;
        const title = (tab.title || '').replace(/\s+/g, ' ').trim();
        if (!title || isUnusableAutoBookmarkTitle(title)) continue;
        const len = new URL(tab.url).pathname.length;
        if (!best || len > best.len) best = { title, len };
      }
      resolve(best ? best.title : null);
    });
  });
}

function scheduleBookmarkDescAutofill() {
  if (editingBookmarkId) return;
  clearTimeout(bmDescAutofillTimer);
  bmDescAutofillTimer = setTimeout(() => {
    bmDescAutofillTimer = null;
    void tryAutofillBookmarkDescFromPage();
  }, BM_DESC_AUTOFILL_DEBOUNCE_MS);
}

async function tryAutofillBookmarkDescFromPage() {
  if (editingBookmarkId || bmDescUserEdited) return;
  const raw = $('bmUrl').value;
  const url = tryNormalizeBookmarkUrl(raw);
  if (!url) return;
  if ($('bmDesc').value.trim() !== '') return;
  const gen = ++bmDescAutofillGen;

  let text = '';
  let source = '';
  if (isExtensionContext() && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    const r = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'VB_GET_PAGE_SNIPPET', pageUrl: url }, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false });
            return;
          }
          resolve(resp && typeof resp === 'object' ? resp : { ok: false });
        });
      } catch {
        resolve({ ok: false });
      }
    });
    if (gen !== bmDescAutofillGen) return;
    if (editingBookmarkId || bmDescUserEdited || $('bmDesc').value.trim() !== '') return;
    const d = r && r.ok && typeof r.description === 'string' ? r.description.trim() : '';
    if (d && !isUnusableAutoBookmarkTitle(d)) {
      text = d;
      source = typeof r.source === 'string' ? r.source : 'html';
    }
  }

  if (!text) {
    const tabTitle = await tryGetBookmarkTitleFromOpenTab(url);
    if (gen !== bmDescAutofillGen) return;
    if (editingBookmarkId || bmDescUserEdited || $('bmDesc').value.trim() !== '') return;
    if (tabTitle && !isUnusableAutoBookmarkTitle(tabTitle)) {
      text = tabTitle;
      source = 'tab-title';
    }
  }

  if (!text) return;
  $('bmDesc').value = text.slice(0, 500);
  if (source) {
    $('bmDesc').setAttribute('data-vb-desc-source', source);
    $('bmDesc').title = tr('bm.descAutofillHint') + ' (' + source + ')';
  } else {
    $('bmDesc').removeAttribute('data-vb-desc-source');
    $('bmDesc').removeAttribute('title');
  }
  updateBmPreview();
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Лимит длины data URL в storage (синк / квота chrome.storage) */
const MAX_FAVICON_DATA_URL_LEN = 180000;

function clampFaviconDataUrl(d) {
  if (!d || typeof d !== 'string' || !d.startsWith('data:')) return undefined;
  if (d.length > MAX_FAVICON_DATA_URL_LEN) return undefined;
  return d;
}

/** Запасная иконка earth.svg, если у сайта нет проверенного favicon (см. background.js) */
function fallbackIconUrl() {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function') {
      return chrome.runtime.getURL('icons/fallback-earth.svg');
    }
  } catch (_) {}
  return 'icons/fallback-earth.svg';
}

const FAVICON_MESSAGE_MS = 10000;

function getFaviconViaBackground(pageUrl) {
  return new Promise((resolve) => {
    if (!isExtensionContext() || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      resolve({ ok: false });
      return;
    }
    const timer = setTimeout(() => resolve({ ok: false }), FAVICON_MESSAGE_MS);
    chrome.runtime.sendMessage({ type: 'VB_GET_FAVICON', pageUrl }, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        resolve({ ok: false });
        return;
      }
      resolve(response && response.ok && response.dataUrl ? response : { ok: false });
    });
  });
}

const vbFaviconSessionCache = new Map();

/** Тот же запрос к SW, но один раз на URL за сессию вкладки (без хранения в JSON) */
function getFaviconCached(pageUrl) {
  const key = String(pageUrl || '');
  if (!key) return Promise.resolve({ ok: false });
  const hit = vbFaviconSessionCache.get(key);
  if (hit) return Promise.resolve(hit);
  return getFaviconViaBackground(key).then((fr) => {
    vbFaviconSessionCache.set(key, fr);
    return fr;
  });
}

/** Синхронно: уже загруженная в этой вкладке иконка — без мигания при каждом renderGrid */
function faviconDataUrlFromSessionCache(pageUrl) {
  const key = String(pageUrl || '').trim();
  if (!key) return null;
  const hit = vbFaviconSessionCache.get(key);
  if (hit && hit.ok && typeof hit.dataUrl === 'string' && hit.dataUrl.startsWith('data:')) return hit.dataUrl;
  return null;
}

function bookmarkTileIconSrc(pageUrl, view) {
  if (view === 'screenshots') return screenshotThumb(pageUrl);
  return faviconDataUrlFromSessionCache(pageUrl) || fallbackIconUrl();
}

function wireTileImageFallback(img) {
  const fb = fallbackIconUrl();
  img.addEventListener('error', function onTileImgErr() {
    if (img.dataset.fallbackEarth) {
      img.removeEventListener('error', onTileImgErr);
      img.style.display = 'none';
      const letter = img.nextElementSibling;
      if (letter && letter.classList.contains('bm-card__letter')) letter.style.display = 'flex';
      return;
    }
    img.dataset.fallbackEarth = '1';
    img.src = fb;
  });
}

function wireGridImageFallbacks(gridEl) {
  gridEl.querySelectorAll('.bm-card__body > img.bm-card__img').forEach((img) => wireTileImageFallback(img));
}

/** Подстановка favicon по URL через service worker (в JSON/sync не храним) */
function wireTileFaviconLazyLoad(gridEl) {
  if ((app.settings.bookmarkView || 'icons') === 'screenshots') return;
  gridEl.querySelectorAll('img[data-vb-favicon]').forEach((img) => {
    const pageUrl = img.getAttribute('data-vb-favicon');
    if (!pageUrl) return;
    getFaviconCached(pageUrl).then((fr) => {
      if (!fr.ok || !fr.dataUrl || !img.isConnected) return;
      if (img.src === fr.dataUrl) return;
      img.src = fr.dataUrl;
    });
  });
}

/** Цвет с уже сохранённой иконки или один запрос к SW (при сохранении закладки, не при каждом открытии newtab) */
async function extractColorFromFaviconData(pageUrl, optionalCachedDataUrl) {
  const cached = clampFaviconDataUrl(optionalCachedDataUrl);
  if (cached) return extractColorFromImage(cached);
  const r = await getFaviconViaBackground(pageUrl);
  if (r.ok && r.dataUrl) return extractColorFromImage(r.dataUrl);
  return extractColorFromImage(fallbackIconUrl());
}

function screenshotThumb(url) {
  return 'https://s.wordpress.com/mshots/v1/' + encodeURIComponent(url) + '?w=400';
}

function resolveTileBackground(b) {
  if (b.backgroundColor === FAVICON_BG) return '#475569';
  if (b.backgroundColor == null || b.backgroundColor === '') return '#27272a';
  return sanitizeBookmarkBackgroundColor(b.backgroundColor, '#27272a');
}

function contrastColor(hex) {
  if (!hex || hex === FAVICON_BG || String(hex).startsWith('linear')) return '#ffffff';
  if (/^rgba?\s*\(/i.test(String(hex))) return '#ffffff';
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  else if (h.length === 4) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  else if (h.length === 8) h = h.slice(0, 6);
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/i.test(h)) return '#ffffff';
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return L > 0.55 ? '#000000' : '#ffffff';
}

const MAX_BOOKMARKS_LIMIT = 100;
const MIN_BOOKMARKS_LIMIT = 6;

function clampMaxBookmarksValue(n) {
  const v = typeof n === 'number' && !Number.isNaN(n) ? Math.round(n) : DEFAULT_SETTINGS.maxBookmarks;
  return Math.min(MAX_BOOKMARKS_LIMIT, Math.max(MIN_BOOKMARKS_LIMIT, v));
}

/** Лимит плиток / хранения; не доверяем сырому settings (null с сервера даёт «>= 0» и вечный disabled). */
function effectiveMaxBookmarks() {
  return clampMaxBookmarksValue(app.settings.maxBookmarks);
}

/** Если в хранилище закладок больше, чем лимит (синк, импорт), поднимаем лимит до min(100, count), иначе «Добавить» серое. */
function syncMaxBookmarksToStoredCount() {
  const len = app.bookmarks.length;
  const m = effectiveMaxBookmarks();
  if (len > m) {
    app.settings.maxBookmarks = Math.min(MAX_BOOKMARKS_LIMIT, Math.max(MIN_BOOKMARKS_LIMIT, len));
    touchUpdated();
  } else {
    app.settings.maxBookmarks = m;
  }
}

function mergeSettings(base, patch) {
  const out = { ...base, ...patch };
  delete out.language;
  const langAllowed = ['auto', 'ru', 'uk', 'en', 'hy'];
  if (!out.uiLanguage || !langAllowed.includes(out.uiLanguage)) {
    out.uiLanguage = DEFAULT_SETTINGS.uiLanguage;
  }
  let n = out.maxBookmarks;
  if (typeof n !== 'number' || Number.isNaN(n)) {
    n =
      typeof base.maxBookmarks === 'number' && !Number.isNaN(base.maxBookmarks)
        ? base.maxBookmarks
        : DEFAULT_SETTINGS.maxBookmarks;
  }
  out.maxBookmarks = clampMaxBookmarksValue(n);
  return out;
}

/** Макс. длина строки `background.value` для type=image при внешней передаче (синк / экспорт): иначе считаем встроенными данными. */
const MAX_EXPORT_BG_VALUE_LEN = 512;

/**
 * Для синка / API / экспорт: без data/blob URL и без огромных строк. Свой фон — маркер; пиксели только в IndexedDB на устройстве.
 */
function stripEmbeddedBackgroundForExternal(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  const out = { ...settings };
  const bg = out.background;
  if (bg && bg.type === 'image' && typeof bg.value === 'string') {
    const v = bg.value;
    if (v === CUSTOM_BG_MARKER) {
      out.background = { type: 'image', value: CUSTOM_BG_MARKER };
    } else if (v.startsWith('data:') || v.startsWith('blob:')) {
      out.background = { type: 'image', value: CUSTOM_BG_MARKER };
    } else if (!/^https?:\/\//i.test(v) && v.length > MAX_EXPORT_BG_VALUE_LEN) {
      out.background = { type: 'image', value: CUSTOM_BG_MARKER };
    }
  }
  return out;
}

/** После merge с сервером: маркер «свой фон» валиден только если в IndexedDB есть файл. */
async function hydrateCustomBackgroundIfNeeded() {
  if (!isCustomBackgroundMarker(app.settings?.background)) return;
  await migrateAndRemoveLegacyCustomBgFromChromeStorage();
  if (typeof VisualBookmarksCustomBg === 'undefined') {
    app.settings = mergeSettings(app.settings, { background: DEFAULT_SETTINGS.background });
    return;
  }
  const blob = await VisualBookmarksCustomBg.loadBlob();
  if (!blob) {
    app.settings = mergeSettings(app.settings, { background: DEFAULT_SETTINGS.background });
  }
}

function sortedBookmarks() {
  return [...app.bookmarks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** Локальная сетка совпадает с заводским набором (тот же набор URL) — типичный «новый ноут» до первого merge с сервером. */
function bookmarksLookLikeDefaultOnly(bookmarks) {
  if (!Array.isArray(bookmarks) || bookmarks.length !== DEFAULT_BOOKMARKS.length) return false;
  const urls = (arr) =>
    arr
      .map((b) => normalizeUrl(b.url))
      .filter(Boolean)
      .slice()
      .sort();
  const a = urls(bookmarks);
  const b = urls(DEFAULT_BOOKMARKS);
  return a.length === b.length && a.every((u, i) => u === b[i]);
}

function touchUpdated() {
  app.updatedAt = Date.now();
}

async function loadState() {
  await migrateAndRemoveLegacyCustomBgFromChromeStorage();
  const res = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v && typeof v === 'object' ? v : {});
    };
    const timer = setTimeout(() => {
      console.warn('[VB] loadState: chrome.storage.local.get не ответил за 12 с — продолжаем с пустым ответом');
      finish({});
    }, 12000);
    storageLocal.get([STORAGE_KEY, STORAGE_KEY_LEGACY], (r) => {
      clearTimeout(timer);
      finish(r);
    });
  });
  if (vbDebugStorage()) {
    console.info('[VB storage] loadState:', {
      keys: Object.keys(res),
      hasV2: !!res[STORAGE_KEY],
      hasLegacy: !!res[STORAGE_KEY_LEGACY],
    });
  }
  let raw = res[STORAGE_KEY];
  if (!raw && res[STORAGE_KEY_LEGACY]) {
    raw = migrateLegacy(res[STORAGE_KEY_LEGACY]);
  }

  if (raw && typeof raw === 'object') {
    app.settings = mergeSettings({ ...DEFAULT_SETTINGS }, raw.settings || {});
    app.bookmarks = Array.isArray(raw.bookmarks) ? raw.bookmarks.map(normalizeBookmark) : [];
    app.user = raw.user || null;
    app.updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : 0;
    app.lastServerSyncAt =
      typeof raw.lastServerSyncAt === 'number' && raw.lastServerSyncAt > 0 ? raw.lastServerSyncAt : null;

    const b = app.settings.background;
    if (b?.type === 'image' && typeof b.value === 'string' && b.value.startsWith('data:')) {
      if (typeof VisualBookmarksCustomBg !== 'undefined') {
        try {
          await Promise.race([
            VisualBookmarksCustomBg.saveFromDataUrl(b.value),
            new Promise((_, rej) => setTimeout(() => rej(new Error('state dataUrl→IDB timeout')), 25000)),
          ]);
        } catch (e) {
          console.warn('VB: перенос data URL фона из state в IDB', e);
        }
      }
      app.settings.background = { type: 'image', value: CUSTOM_BG_MARKER };
      await saveLocal();
    } else if (isCustomBackgroundMarker(b)) {
      if (typeof VisualBookmarksCustomBg !== 'undefined') {
        const blob = await Promise.race([
          VisualBookmarksCustomBg.loadBlob(),
          new Promise((r) => setTimeout(() => r(null), 10000)),
        ]);
        if (!blob) {
          app.settings = mergeSettings(app.settings, { background: DEFAULT_SETTINGS.background });
        }
      } else {
        app.settings = mergeSettings(app.settings, { background: DEFAULT_SETTINGS.background });
      }
    }

    if (!app.bookmarks.length) app.bookmarks = DEFAULT_BOOKMARKS.map((b) => ({ ...b, id: generateId() }));
  } else {
    app.bookmarks = DEFAULT_BOOKMARKS.map((b) => ({ ...b, id: generateId() }));
    app.settings = { ...DEFAULT_SETTINGS };
    app.updatedAt = 0;
    app.user = null;
    app.lastServerSyncAt = null;
  }
  syncMaxBookmarksToStoredCount();
}

/**
 * Сохраняет компактный снимок в localStorage после успешной записи в chrome.storage
 * (без data URL фона — в payload уже маркер). Чтение синхронное при следующем открытии вкладки.
 */
function writeBootCacheFromPayload(payload) {
  if (typeof localStorage === 'undefined' || !payload) return;
  const mirror = {
    v: BOOT_CACHE_VERSION,
    updatedAt: payload.updatedAt,
    bookmarks: payload.bookmarks,
    settings: payload.settings,
    user: payload.user ?? null,
    lastServerSyncAt:
      typeof payload.lastServerSyncAt === 'number' && payload.lastServerSyncAt > 0
        ? payload.lastServerSyncAt
        : null,
  };
  localStorage.setItem(LOCAL_BOOT_CACHE_KEY, JSON.stringify(mirror));
}

function clearBootCache() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(LOCAL_BOOT_CACHE_KEY);
      localStorage.removeItem(LOCAL_BOOT_BG_KEY);
    }
  } catch (_) {}
}

/** @returns {boolean} true если из кэша восстановили app (до async loadState) */
function tryApplyBootCache() {
  if (typeof localStorage === 'undefined') return false;
  let raw;
  try {
    raw = localStorage.getItem(LOCAL_BOOT_CACHE_KEY);
  } catch {
    return false;
  }
  if (!raw || raw.length < 12) return false;
  let o;
  try {
    o = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!o || o.v !== BOOT_CACHE_VERSION || typeof o.updatedAt !== 'number') return false;
  if (!Array.isArray(o.bookmarks) || !o.settings || typeof o.settings !== 'object') return false;

  app.settings = mergeSettings({ ...DEFAULT_SETTINGS }, o.settings);
  app.bookmarks = o.bookmarks.map(normalizeBookmark).filter(Boolean);
  if (!app.bookmarks.length) app.bookmarks = DEFAULT_BOOKMARKS.map((b) => ({ ...b, id: generateId() }));
  app.user = o.user || null;
  app.updatedAt = o.updatedAt;
  app.lastServerSyncAt =
    typeof o.lastServerSyncAt === 'number' && o.lastServerSyncAt > 0 ? o.lastServerSyncAt : null;
  syncMaxBookmarksToStoredCount();
  return true;
}

function migrateLegacy(leg) {
  const bms = (leg.bookmarks || []).map((b, i) => ({
    id: b.id || generateId(),
    title: b.title || hostFromUrl(b.url),
    url: normalizeUrl(b.url),
    backgroundColor: sanitizeBookmarkBackgroundColor(b.backgroundColor || b.color, DEFAULT_TILE_BG),
    description: b.description,
    order: i,
    clickCount: b.clickCount || 0,
  }));
  return {
    updatedAt: leg.updatedAt || Date.now(),
    bookmarks: bms,
    settings: { ...DEFAULT_SETTINGS },
    user: null,
  };
}

function normalizeBookmark(b) {
  if (!b || !b.url) return null;
  let backgroundColor = b.backgroundColor;
  if (backgroundColor === FAVICON_BG) {
    /* оставляем маркер — позже enrichFaviconBackgrounds */
  } else if (backgroundColor == null || backgroundColor === '') {
    backgroundColor = DEFAULT_TILE_BG;
  } else {
    backgroundColor = sanitizeBookmarkBackgroundColor(backgroundColor, DEFAULT_TILE_BG);
  }
  /* faviconDataUrl не храним: иконки подгружаются по URL (SW) при показе сетки */
  return {
    id: b.id || generateId(),
    title: b.title || hostFromUrl(b.url),
    url: normalizeUrl(b.url),
    backgroundColor,
    description: b.description || '',
    order: typeof b.order === 'number' ? b.order : 0,
    clickCount: b.clickCount || 0,
  };
}

/** Для синка / экспорта / chrome.storage — без data URL иконок */
function bookmarksWithoutFaviconPayload(bookmarks) {
  return bookmarks.map((b) => {
    const o = { ...b };
    delete o.faviconDataUrl;
    return o;
  });
}

/** Экспорт JSON: без data URL и без тяжёлых полей в закладках */
function bookmarksForExport(bookmarks) {
  return bookmarksWithoutFaviconPayload(bookmarks).map((b) => {
    const o = { ...b };
    if (typeof o.backgroundColor === 'string' && o.backgroundColor.startsWith('data:')) {
      o.backgroundColor = DEFAULT_TILE_BG;
    }
    if (typeof o.description === 'string' && o.description.startsWith('data:')) {
      o.description = '';
    }
    if (typeof o.title === 'string' && o.title.startsWith('data:')) {
      o.title = '';
    }
    if (typeof o.url === 'string' && o.url.startsWith('data:')) {
      o.url = '';
    }
    return o;
  });
}

async function saveLocal() {
  await flushTransientDataUrlBackgroundToIdbIfAny();
  const payload = {
    updatedAt: app.updatedAt,
    bookmarks: bookmarksWithoutFaviconPayload(app.bookmarks),
    settings: app.settings,
    user: app.user,
    lastServerSyncAt: typeof app.lastServerSyncAt === 'number' ? app.lastServerSyncAt : null,
  };

  const useChromeStorage =
    typeof chrome !== 'undefined' &&
    chrome.storage &&
    chrome.storage.local &&
    storageLocal === chrome.storage.local;

  return new Promise((resolve) => {
    const onStored = () => {
      resolve();
      scheduleWhenIdle(() => {
        try {
          writeBootCacheFromPayload(payload);
          if (typeof localStorage !== 'undefined') {
            localStorage.removeItem(LOCAL_BOOT_BG_KEY);
          }
        } catch (_) {
          try {
            clearBootCache();
          } catch (__) {}
        }
      }, 4000);
    };

    const attemptWrite = (purgedFavicon) => {
      const afterSet = () => {
        if (useChromeStorage && chrome.runtime.lastError) {
          const msg = String(chrome.runtime.lastError.message || '');
          if (!purgedFavicon && /quota|QUOTA_EXCEEDED/i.test(msg)) {
            console.warn(
              '[VB] Переполнение chrome.storage.local — удаляю кэш favicon (' +
                FAVICON_CACHE_STORAGE_KEY +
                ') и повторяю сохранение закладок'
            );
            chrome.storage.local.remove([FAVICON_CACHE_STORAGE_KEY], () => {
              void chrome.runtime.lastError;
              attemptWrite(true);
            });
            return;
          }
          console.error('[VB] Сохранение в storage не удалось:', msg);
          onStored();
          return;
        }
        if (vbDebugStorage()) {
          console.info('[VB storage] saveLocal ok', STORAGE_KEY, {
            updatedAt: payload.updatedAt,
            bookmarks: payload.bookmarks?.length,
          });
        }
        onStored();
      };

      const writeMain = () => storageLocal.set({ [STORAGE_KEY]: payload }, afterSet);
      if (typeof storageLocal.remove === 'function') {
        storageLocal.remove([LEGACY_CHROME_CUSTOM_BG_KEY], () => writeMain());
      } else {
        writeMain();
      }
    };

    attemptWrite(false);
  });
}

function exportJsonString() {
  const settingsCopy = stripEmbeddedBackgroundForExternal(JSON.parse(JSON.stringify(app.settings)));
  return JSON.stringify(
    {
      bookmarks: bookmarksForExport(app.bookmarks),
      settings: settingsCopy,
      updatedAt: app.updatedAt,
      version: 2,
    },
    null,
    2
  );
}

function importFromJson(text) {
  const data = JSON.parse(text);
  if (data.bookmarks) app.bookmarks = data.bookmarks.map(normalizeBookmark).filter(Boolean);
  if (data.settings) app.settings = mergeSettings({ ...DEFAULT_SETTINGS }, data.settings);
  if (data.user !== undefined) app.user = data.user;
  syncMaxBookmarksToStoredCount();
  touchUpdated();
}

function resetDefaults() {
  clearBootCache();
  void abandonCustomBackgroundBlobIfAny();
  pageBgApplySig = '';
  idbBgPaintGen++;
  idbBgPaintPromise = null;
  app.bookmarks = DEFAULT_BOOKMARKS.map((b) => ({ ...b, id: generateId() }));
  app.settings = { ...DEFAULT_SETTINGS };
  app.user = null;
  app.lastServerSyncAt = null;
  if (typeof storageLocal.remove === 'function') {
    storageLocal.remove([LEGACY_CHROME_CUSTOM_BG_KEY], () => {});
  }
  touchUpdated();
}

function normalizeServerUser(u) {
  if (!u) return null;
  const name = u.name || (u.email && u.email.split('@')[0]) || 'User';
  return {
    id: String(u.id || u.sub || u.email || ''),
    name,
    email: u.email || '',
    avatar:
      u.avatar ||
      u.picture ||
      'https://api.dicebear.com/7.x/initials/svg?seed=' + encodeURIComponent(name),
  };
}

async function pushServerState() {
  if (typeof VisualBookmarksApi === 'undefined') return;
  await VisualBookmarksApi.pushSyncState({
    version: 2,
    updatedAt: app.updatedAt,
    bookmarks: bookmarksWithoutFaviconPayload(app.bookmarks),
    settings: stripEmbeddedBackgroundForExternal(app.settings),
  });
}

/**
 * Выход из Crypt-Chain: закладки и настройки (кроме календаря) остаются локально.
 * Сбрасываются токен/пользователь сервера и привязка Google Календаря в расширении.
 */
/** Ключи сессии Crypt-Chain (дублируют api-client.js) — всегда снимаем при выходе, даже если API-скрипт недоступен. */
const CRYPT_CHAIN_SESSION_KEYS = ['vb_server_access_token', 'vb_server_user_json', 'vb_server_base_url'];

function clearCryptChainSessionStorage() {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local?.remove) {
      chrome.storage.local.remove(CRYPT_CHAIN_SESSION_KEYS, () => resolve());
    } else {
      resolve();
    }
  });
}

async function performCryptChainLogout() {
  stopServerPeriodicPull();
  let skipTouchAfterPush = false;
  try {
    if (app.settings.googleCalendarEnabled) {
      app.settings.googleCalendarEnabled = false;
      stopCalendarRotation();
      calendarEvents = [];
      calendarEventIndex = 0;
      await clearCalendarEventsCache();
      await revokeGoogleCalendarCachedAuth();
      touchUpdated();
      try {
        if (typeof VisualBookmarksApi !== 'undefined' && (await VisualBookmarksApi.hasToken())) {
          await pushServerState();
          app.lastServerSyncAt = Date.now();
        }
      } catch (e) {
        console.warn('Crypt-Chain: не удалось отправить отключение календаря перед выходом:', e);
      }
      skipTouchAfterPush = true;
    }
    if (typeof VisualBookmarksApi !== 'undefined' && VisualBookmarksApi.logout) {
      await VisualBookmarksApi.logout();
    }
  } catch (e) {
    console.warn('Crypt-Chain logout:', e);
  }
  await clearCryptChainSessionStorage();
  app.user = null;
  app.lastServerSyncAt = null;
  profileMenuOpen = false;
  await persist(false, { skipTouchUpdated: skipTouchAfterPush });
}

/** Сервер отклонил токен (401 / просрочен): без повторного push, только UI и локальный снимок. */
async function onCryptChainSessionInvalidatedByServer() {
  stopServerPeriodicPull();
  app.user = null;
  app.lastServerSyncAt = null;
  profileMenuOpen = false;
  try {
    await clearCryptChainSessionStorage();
  } catch (_) {}
  try {
    await saveLocal();
  } catch (_) {}
  try {
    renderAll();
    renderHeader();
    renderSettingsIfOpen();
  } catch (_) {}
  try {
    alert(tr('auth.sessionExpired'));
  } catch (_) {
    alert('Сессия недействительна. Войдите снова.');
  }
}

/**
 * После входа или регистрации Crypt-Chain.
 * Вход: подтягиваем сервер и сливаем с локальным по `updatedAt` (как ручная синхронизация).
 * Регистрация: на пустом сервере (204) оставляем локальные закладки/настройки и отправляем их на сервер.
 */
async function applyServerStateAfterAuth(opts = {}) {
  if (typeof VisualBookmarksApi === 'undefined') return;
  const isRegistration = !!opts.isRegistration;

  if (!isRegistration) {
    await pullServerMerge({ allowSeedPush: true });
    scheduleCalendarRefreshAfterServerPull();
    return;
  }

  const remote = await VisualBookmarksApi.pullSyncState();
  if (remote == null) {
    if (!app.bookmarks.length) {
      app.bookmarks = DEFAULT_BOOKMARKS.map((b) => ({ ...b, id: generateId() }));
    }
    syncMaxBookmarksToStoredCount();
    if (await enrichFaviconBackgrounds()) touchUpdated();
    await pushServerState();
    app.lastServerSyncAt = Date.now();
    await saveLocal();
    renderAll();
    scheduleCalendarRefreshAfterServerPull();
    return;
  }
  await pullServerMerge({ allowSeedPush: true });
  scheduleCalendarRefreshAfterServerPull();
}

/**
 * Серверный updatedAt → миллисекунды Unix (как Date.now()).
 * Часто на бэкенде: секунды, ISO-8601 в UTC («…Z»), строка-число — иначе сравнение с локальным временем ломается.
 */
function remoteUpdatedAtField(remote) {
  if (!remote || typeof remote !== 'object') return undefined;
  if (remote.updatedAt != null) return remote.updatedAt;
  if (remote.updated_at != null) return remote.updated_at;
  return undefined;
}

function normalizeServerUpdatedAt(raw) {
  if (raw == null || raw === '') return 0;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    let n = raw;
    if (n > 0 && n < 1e12) n *= 1000;
    return Math.round(n);
  }
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return 0;
    const parsed = Date.parse(t);
    if (Number.isFinite(parsed)) return parsed;
    const num = Number(t);
    if (Number.isFinite(num)) {
      let n = num;
      if (n > 0 && n < 1e12) n *= 1000;
      return Math.round(n);
    }
  }
  return 0;
}

/**
 * Слияние с сервером Crypt-Chain.
 * @param {{ allowSeedPush?: boolean; applyRemoteSettings?: boolean }} opts — allowSeedPush: при 204 один раз отправить локальное состояние (вход, ручная синхронизация); false для таймера, чтобы не дёргать PUT каждую минуту. applyRemoteSettings: подставлять ли с сервера объект settings (false — только закладки; так фоновый pull при открытии вкладки не затирает тему/язык с другого ноутбута).
 * @returns {Promise<boolean>} true если был полный renderAll (данные с сервера изменились)
 */
async function pullServerMerge(opts = {}) {
  const allowSeedPush = opts.allowSeedPush !== false;
  const applyRemoteSettings = opts.applyRemoteSettings !== false;
  let didFullRender = false;
  if (typeof VisualBookmarksApi === 'undefined') return false;
  const remote = await VisualBookmarksApi.pullSyncState();
  if (remote == null) {
    if (allowSeedPush && (app.bookmarks.length || app.updatedAt)) await pushServerState();
  } else {
    const ruNorm = normalizeServerUpdatedAt(remoteUpdatedAtField(remote));
    let ru = ruNorm;
    if (
      ru <= 0 &&
      (Array.isArray(remote.bookmarks) || (remote.settings && typeof remote.settings === 'object'))
    ) {
      ru = app.updatedAt;
    }

    const takeServerDespiteLocalNewer =
      Array.isArray(remote.bookmarks) &&
      remote.bookmarks.length > 0 &&
      bookmarksLookLikeDefaultOnly(app.bookmarks);

    if (!takeServerDespiteLocalNewer && app.updatedAt > ru) {
      await pushServerState();
    } else {
      const inSync = ruNorm > 0 && ruNorm === app.updatedAt;
      const serverNewer = ruNorm > app.updatedAt;
      const initialFromServer =
        ruNorm === 0 &&
        app.updatedAt === 0 &&
        ((Array.isArray(remote.bookmarks) && remote.bookmarks.length > 0) ||
          (remote.settings &&
            typeof remote.settings === 'object' &&
            Object.keys(remote.settings).length > 0));

      if (takeServerDespiteLocalNewer || (!inSync && (serverNewer || initialFromServer))) {
        if (Array.isArray(remote.bookmarks)) {
          const mapped = remote.bookmarks.map(normalizeBookmark).filter(Boolean);
          app.bookmarks =
            mapped.length > 0 ? mapped : DEFAULT_BOOKMARKS.map((b) => ({ ...b, id: generateId() }));
        }
        if (applyRemoteSettings && remote.settings && typeof remote.settings === 'object') {
          app.settings = mergeSettings(
            { ...DEFAULT_SETTINGS },
            stripEmbeddedBackgroundForExternal(remote.settings)
          );
        }
        if (ruNorm > 0) {
          app.updatedAt = ruNorm;
        } else if (takeServerDespiteLocalNewer) {
          touchUpdated();
        }
        syncMaxBookmarksToStoredCount();
        if (await enrichFaviconBackgrounds()) touchUpdated();
        renderAll();
        didFullRender = true;
      }
    }
  }
  await hydrateCustomBackgroundIfNeeded();
  if (!didFullRender) {
    applyBackground();
  }
  app.lastServerSyncAt = Date.now();
  await saveLocal();
  return didFullRender;
}

let serverPeriodicPullTimer = null;

function stopServerPeriodicPull() {
  if (serverPeriodicPullTimer != null) {
    clearTimeout(serverPeriodicPullTimer);
    serverPeriodicPullTimer = null;
  }
}

/** Сколько ждать до следующего фонового pull от последней успешной синхронизации Crypt-Chain */
function delayUntilNextServerPullMs() {
  const last = app.lastServerSyncAt;
  if (last == null || typeof last !== 'number' || last <= 0) {
    return SERVER_PULL_INTERVAL_MS;
  }
  return Math.max(0, SERVER_PULL_INTERVAL_MS - (Date.now() - last));
}

async function runServerPeriodicPullTick() {
  serverPeriodicPullTimer = null;
  try {
    if (typeof VisualBookmarksApi === 'undefined' || !(await VisualBookmarksApi.hasToken())) {
      stopServerPeriodicPull();
      return;
    }
    const merged = await pullServerMerge({ allowSeedPush: false, applyRemoteSettings: false });
    if (merged) scheduleCalendarRefreshAfterServerPull();
    await restartServerPeriodicPull();
  } catch (e) {
    console.warn('Periodic server sync:', e);
    stopServerPeriodicPull();
    serverPeriodicPullTimer = setTimeout(() => {
      void runServerPeriodicPullTick();
    }, SERVER_PULL_INTERVAL_MS);
  }
}

/** Раньше планировался периодический pull; синк только при открытии вкладки и по кнопке в настройках. */
async function restartServerPeriodicPull() {
  stopServerPeriodicPull();
}

/** После любого pull с сервера — перечитать флаг календаря и при необходимости события (другой ПК мог изменить настройки). */
function scheduleCalendarRefreshAfterServerPull() {
  setTimeout(() => void refreshCalendarEvents({ force: true }), 0);
}

/**
 * Фоновый pull при открытии новой вкладки: подтягиваем с сервера в основном закладки (если сервер новее).
 * Настройки с сервера не подмешиваем — иначе два ноутбука с разными темой/сеткой будут перетирать друг друга без ведома пользователя.
 * Полное слияние с settings — кнопка «Синхронизировать» и сценарий входа в аккаунт.
 */
async function pullRemoteMerge() {
  let merged = false;
  try {
    if (typeof VisualBookmarksApi !== 'undefined' && (await VisualBookmarksApi.hasToken())) {
      merged = await pullServerMerge({ applyRemoteSettings: false });
    }
  } catch (e) {
    console.warn('Server sync:', e);
  }
  scheduleCalendarRefreshAfterServerPull();
  return merged;
}

/** Один проход: Crypt-Chain при активной сессии. Без ожидания из UI. */
async function pushRemoteStateOnce() {
  try {
    if (typeof VisualBookmarksApi !== 'undefined' && (await VisualBookmarksApi.hasToken())) {
      await pushServerState();
      app.lastServerSyncAt = Date.now();
      await saveLocal();
    }
  } catch (e) {
    console.warn('Сервер синхронизации:', e);
  }
}

const debouncedPush = debounce(() => {
  void pushRemoteStateOnce();
}, SYNC_DEBOUNCE_MS);

function debounce(fn, ms) {
  let t;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

/**
 * Локально: сразу сохраняет и перерисовывает (закладки и настройки — мгновенно на этом устройстве).
 * На Crypt-Chain уходит полный снимок (bookmarks + settings) в фоне: debounce 2,5 с или сразу при immediateServerPush,
 * чтобы изменения настроек на этом ПК попали на сервер и потом подтянулись на другом после явной синхронизации.
 * @param {boolean} [immediateServerPush] — поставить фоновую отправку сразу (иначе debounce 2,5 с).
 * @param {{ skipTouchUpdated?: boolean }} [opts] — не вызывать touchUpdated (например после push с тем же updatedAt при выходе).
 */
async function persist(immediateServerPush = false, opts = {}) {
  if (!opts.skipTouchUpdated) touchUpdated();
  await saveLocal();
  renderAll();
  renderSettingsIfOpen();
  if (immediateServerPush) {
    void pushRemoteStateOnce();
  } else {
    debouncedPush();
  }
}

/* --- Theme & background --- */
function applyTheme() {
  const t = app.settings.theme || 'auto';
  let mode = t;
  if (t === 'auto') mode = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', mode);
}

function pickDailyPreset() {
  const day = new Date().toDateString();
  if (app.settings._lastBgDay === day && app.settings.changeBgDaily) return;
  if (isCustomBackgroundMarker(app.settings.background)) {
    void abandonCustomBackgroundBlobIfAny();
  }
  const idx = Math.floor(Date.now() / 86400000) % PRESET_BACKGROUNDS.length;
  app.settings.background = { type: 'preset', value: PRESET_BACKGROUNDS[idx].value };
  app.settings._lastBgDay = day;
}

function stopCalendarRotation() {
  if (calendarRotateTimer != null) {
    clearInterval(calendarRotateTimer);
    calendarRotateTimer = null;
  }
}

function startCalendarRotation() {
  stopCalendarRotation();
  if (!app.settings.googleCalendarEnabled || calendarEvents.length <= 1) return;
  calendarRotateTimer = setInterval(() => {
    calendarEventIndex = (calendarEventIndex + 1) % calendarEvents.length;
    renderCalendarWidget();
  }, 5000);
}

/** Отрисовка виджета календаря после await сети — в rAF, чтобы не блокировать ввод. */
function scheduleCalendarWidgetPaint() {
  requestAnimationFrame(() => {
    renderCalendarWidget();
    startCalendarRotation();
  });
}

function calendarDayKeyForCache() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function clearCalendarEventsCache() {
  return new Promise((resolve) => {
    if (typeof storageLocal.remove === 'function') {
      storageLocal.remove([STORAGE_KEY_CALENDAR_CACHE, STORAGE_KEY_CALENDAR_CACHE_LEGACY], () => resolve());
    } else {
      resolve();
    }
  });
}

/** Сбрасывает кэш OAuth Google в расширении — при следующем подключении календаря снова откроется выбор аккаунта. */
function revokeGoogleCalendarCachedAuth() {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.identity) {
      resolve();
      return;
    }
    if (typeof chrome.identity.clearAllCachedAuthTokens === 'function') {
      chrome.identity.clearAllCachedAuthTokens(() => {
        void chrome.runtime?.lastError;
        resolve();
      });
      return;
    }
    if (typeof chrome.identity.getAuthToken !== 'function') {
      resolve();
      return;
    }
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (chrome.runtime.lastError || !token) {
        resolve();
        return;
      }
      if (typeof chrome.identity.removeCachedAuthToken === 'function') {
        chrome.identity.removeCachedAuthToken({ token }, () => {
          void chrome.runtime?.lastError;
          resolve();
        });
      } else {
        resolve();
      }
    });
  });
}

function applyCalendarResult(events) {
  stopCalendarRotation();
  calendarEvents = Array.isArray(events) ? events : [];
  calendarEventIndex = 0;
  scheduleCalendarWidgetPaint();
}

/** Запрос календаря в контексте страницы (fallback без service worker). Кэш пишем только после успешного ответа API. */
async function refreshCalendarEventsInPage(dayKey, pageOpts = {}) {
  const force = !!pageOpts.force;
  if (typeof VisualBookmarksCalendar === 'undefined') {
    applyCalendarResult([]);
    return;
  }
  const VBC = VisualBookmarksCalendar;
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
  const persistAndApply = (events) =>
    new Promise((resolve) => {
      storageLocal.set(
        { [STORAGE_KEY_CALENDAR_CACHE]: { at: Date.now(), dayKey, events } },
        () => {
          applyCalendarResult(events);
          resolve();
        }
      );
    });
  try {
    let token = await VBC.getAuthToken(false);
    if (!token) {
      applyCalendarResult([]);
      return;
    }
    const load = async (t) => {
      const events = await VBC.fetchTodayEvents(t);
      await persistAndApply(Array.isArray(events) ? events : []);
    };
    try {
      await load(token);
    } catch (apiErr) {
      if (shouldRetryAuth(apiErr) && typeof VBC.removeCachedAuthToken === 'function') {
        await VBC.removeCachedAuthToken(token);
        token = await VBC.getAuthToken(true);
        if (token) await load(token);
        else throw apiErr;
      } else {
        throw apiErr;
      }
    }
  } catch (e) {
    console.warn('Google Calendar:', e);
    if (!force) {
      const stale = await new Promise((resolve) => {
        storageLocal.get([STORAGE_KEY_CALENDAR_CACHE], (res) => {
          resolve(res[STORAGE_KEY_CALENDAR_CACHE] || null);
        });
      });
      if (
        stale &&
        stale.dayKey === dayKey &&
        Array.isArray(stale.events) &&
        stale.events.length > 0
      ) {
        applyCalendarResult(stale.events);
        return;
      }
    }
    applyCalendarResult([]);
  }
}

/** Service worker ещё не поднял listener (сон MV3) — lastError от sendMessage */
function isServiceWorkerNotReceivingError(msg) {
  const m = String(msg || '');
  return (
    m.includes('Receiving end does not exist') ||
    m.includes('Could not establish connection') ||
    m.includes('The message port closed before a response was received')
  );
}

function pingCalendarServiceWorkerWake() {
  return new Promise((resolve) => {
    try {
      if (!chrome.runtime?.sendMessage) {
        resolve();
        return;
      }
      chrome.runtime.sendMessage({ type: 'VB_CALENDAR_SW_WAKE' }, () => {
        void chrome.runtime?.lastError;
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

function sendCalendarTodayToServiceWorkerOnce() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'VB_CALENDAR_TODAY' }, (r) => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            events: [],
            error: chrome.runtime.lastError.message,
          });
          return;
        }
        resolve(r && typeof r === 'object' ? r : { ok: false, events: [] });
      });
    } catch (e) {
      resolve({ ok: false, events: [], error: String(e) });
    }
  });
}

/** Несколько попыток: SW в MV3 часто не слушает сразу после открытия вкладки */
async function fetchCalendarTodayViaServiceWorker() {
  let resp = await sendCalendarTodayToServiceWorkerOnce();
  if (resp.ok) return resp;
  if (!isServiceWorkerNotReceivingError(resp.error)) return resp;
  await pingCalendarServiceWorkerWake();
  await new Promise((r) => setTimeout(r, 80));
  resp = await sendCalendarTodayToServiceWorkerOnce();
  if (resp.ok) return resp;
  if (!isServiceWorkerNotReceivingError(resp.error)) return resp;
  await new Promise((r) => setTimeout(r, 250));
  resp = await sendCalendarTodayToServiceWorkerOnce();
  return resp;
}

/**
 * До первого renderAll: подставить события из chrome.storage за текущий календарный день (без проверки TTL).
 */
async function hydrateCalendarEventsFromCacheIfPossible() {
  if (!app.settings.googleCalendarEnabled || app.settings.showCalendar === false) return;
  const dayKey = calendarDayKeyForCache();
  const cached = await new Promise((resolve) => {
    storageLocal.get([STORAGE_KEY_CALENDAR_CACHE], (res) => {
      resolve(res[STORAGE_KEY_CALENDAR_CACHE] || null);
    });
  });
  if (cached && cached.dayKey === dayKey && Array.isArray(cached.events) && cached.events.length > 0) {
    stopCalendarRotation();
    calendarEvents = cached.events;
    calendarEventIndex = 0;
  }
}

/**
 * Кэш 1 ч + тот же календарный день → без сети. Запрос в worker / сеть — stale-while-revalidate: не затирать виджет пустым «ожиданием».
 * @param {{ force?: boolean }} opts — force после подключения / pull: всё равно показываем кэш за сегодня, пока идёт запрос
 */
async function refreshCalendarEvents(opts = {}) {
  const force = !!opts.force;

  if (!app.settings.googleCalendarEnabled) {
    stopCalendarRotation();
    calendarEvents = [];
    calendarEventIndex = 0;
    await clearCalendarEventsCache();
    scheduleCalendarWidgetPaint();
    return;
  }

  const dayKey = calendarDayKeyForCache();
  const cached = await new Promise((resolve) => {
    storageLocal.get([STORAGE_KEY_CALENDAR_CACHE], (res) => {
      resolve(res[STORAGE_KEY_CALENDAR_CACHE] || null);
    });
  });

  if (!force && cached && typeof cached.at === 'number' && cached.dayKey === dayKey && Array.isArray(cached.events)) {
    const effTtl = cached.events.length > 0 ? CALENDAR_CACHE_TTL_MS : CALENDAR_EMPTY_CACHE_TTL_MS;
    if (Date.now() - cached.at < effTtl) {
      applyCalendarResult(cached.events);
      return;
    }
  }

  if (
    cached &&
    cached.dayKey === dayKey &&
    Array.isArray(cached.events) &&
    cached.events.length > 0 &&
    calendarEvents.length === 0
  ) {
    applyCalendarResult(cached.events);
  }

  await new Promise((r) => setTimeout(r, 0));

  if (isExtensionContext() && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
    const resp = await fetchCalendarTodayViaServiceWorker();
    if (resp.ok && Array.isArray(resp.events)) {
      await new Promise((resolve) => {
        storageLocal.set(
          { [STORAGE_KEY_CALENDAR_CACHE]: { at: Date.now(), dayKey, events: resp.events } },
          () => resolve()
        );
      });
      applyCalendarResult(resp.events);
      return;
    }
    if (!isServiceWorkerNotReceivingError(resp.error)) {
      console.warn('Google Calendar (фон):', resp.error || 'нет ответа');
    }
    if (
      cached &&
      cached.dayKey === dayKey &&
      Array.isArray(cached.events) &&
      cached.events.length > 0
    ) {
      applyCalendarResult(cached.events);
      return;
    }
    await refreshCalendarEventsInPage(dayKey, { force });
    return;
  }

  await refreshCalendarEventsInPage(dayKey, { force });
}

async function connectGoogleCalendar() {
  logCalendarConnect('connectGoogleCalendar() вызван');
  if (typeof VisualBookmarksCalendar === 'undefined') {
    console.warn('[VB Calendar] VisualBookmarksCalendar не определён (проверьте google-calendar.js в newtab.html)');
    alert(tr('alert.calModule'));
    return;
  }
  if (calendarConnectInFlight) {
    logCalendarConnect('пропуск: уже идёт подключение (calendarConnectInFlight)');
    return;
  }
  calendarConnectInFlight = true;
  setCalendarConnectButtonsLoading(true);

  const finishOk = async (events) => {
    app.settings.googleCalendarEnabled = true;
    hideModal('modalCalendarConnect');
    const list = Array.isArray(events) ? events : [];
    const dayKey = calendarDayKeyForCache();
    /** Сначала данные в памяти и кэше: иначе persist() → renderAll() рисует виджет с пустым calendarEvents. */
    applyCalendarResult(list);
    await new Promise((resolve) => {
      storageLocal.set(
        { [STORAGE_KEY_CALENDAR_CACHE]: { at: Date.now(), dayKey, events: list } },
        () => resolve()
      );
    });
    await yieldToPaint();
    await persist(true);
    renderSettingsIfOpen();
  };

  try {
    await yieldToPaint();
    await new Promise((r) => setTimeout(r, 0));
    if (isExtensionContext() && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
      logCalendarConnect('контекст расширения OK, ждём worker…');
      const resp = await sendCalendarConnectToWorker();
      if (resp.ok) {
        logCalendarConnect('успех, finishOk, событий:', Array.isArray(resp.events) ? resp.events.length : 0);
        await finishOk(resp.events);
        return;
      }
      console.warn('[VB Calendar] worker вернул ошибку:', resp.error);
      alert(resp.error || tr('alert.calConnectFail'));
      return;
    }

    logCalendarConnect('fallback: подключение на странице (нет sendMessage)');
    const token = await VisualBookmarksCalendar.getAuthToken(true);
    if (!token) throw new Error(tr('alert.calToken'));
    const events = await VisualBookmarksCalendar.fetchTodayEvents(token);
    await finishOk(events);
  } catch (e) {
    console.warn('[VB Calendar] connectGoogleCalendar catch:', e);
    alert((e && e.message) || String(e));
  } finally {
    calendarConnectInFlight = false;
    logCalendarConnect('finally: сняты loader / disabled с кнопок');
    setCalendarConnectButtonsLoading(false);
  }
}

function renderCalendarWidget() {
  const root = $('calendarWidgetRoot');
  if (!root) return;
  if (app.settings.showCalendar === false) {
    root.classList.add('is-hidden');
    stopCalendarRotation();
    return;
  }
  root.classList.remove('is-hidden');

  const extOk = typeof chrome !== 'undefined' && chrome.identity;

  if (!app.settings.googleCalendarEnabled) {
    root.innerHTML =
      '<button type="button" class="calendar-connect-pill" id="calendarWidgetConnect">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>' +
      '<span>' +
      escapeHtml(tr('cal.connect')) +
      '</span></button>';
    const w = document.getElementById('calendarWidgetConnect');
    if (w) w.addEventListener('click', () => showModal('modalCalendarConnect'));
    return;
  }

  if (!extOk) {
    root.innerHTML =
      '<div class="calendar-panel"><span class="calendar-panel__title">' +
      escapeHtml(tr('cal.extensionOnly')) +
      '</span></div>';
    return;
  }

  if (!calendarEvents.length) {
    root.innerHTML =
      '<div class="calendar-panel" style="gap:0.5rem">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>' +
      '<span class="calendar-panel__title" style="flex:1">' +
      escapeHtml(tr('cal.noEvents')) +
      '</span></div>';
    return;
  }

  const ev = calendarEvents[calendarEventIndex % calendarEvents.length];
  const many = calendarEvents.length > 1;
  root.innerHTML =
    '<div class="calendar-panel">' +
    '<div class="calendar-panel__bar" style="background-color:' +
    escapeAttr(ev.color) +
    '"></div>' +
    '<div class="calendar-panel__body">' +
    '<span class="calendar-panel__title">' +
    escapeHtml(ev.title) +
    '</span>' +
    '<div class="calendar-panel__meta">' +
    escapeHtml(ev.time) +
    (many
      ? ' <span>• ' + (calendarEventIndex + 1) + '/' + calendarEvents.length + '</span>'
      : '') +
    '</div></div>' +
    (many
      ? '<button type="button" class="calendar-panel__next" id="calendarWidgetNext" title="' +
        escapeAttr(tr('cal.nextTitle')) +
        '" aria-label="' +
        escapeAttr(tr('cal.nextAria')) +
        '"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg></button>'
      : '') +
    '</div>';

  const next = many ? document.getElementById('calendarWidgetNext') : null;
  if (next) {
    next.addEventListener('click', () => {
      calendarEventIndex = (calendarEventIndex + 1) % calendarEvents.length;
      renderCalendarWidget();
    });
  }
}

function computePageBgSignature(bg) {
  if (!bg || typeof bg !== 'object') return '';
  if (bg.type === 'color') return 'c:' + String(bg.value);
  if (isCustomBackgroundMarker(bg)) return 'idb';
  const v = String(bg.value || '');
  if (bg.type === 'image' && v.startsWith('data:')) return 'd:' + v.length;
  return 'i:' + v;
}

function applyBackground() {
  const el = $('pageBg');
  if (app.settings.changeBgDaily) pickDailyPreset();
  const bg = app.settings.background || DEFAULT_SETTINGS.background;
  const sig = computePageBgSignature(bg);

  if (sig === pageBgApplySig) {
    if (sig !== 'idb') return;
    if (pageBgObjectUrl && el.style.backgroundImage) return;
    if (idbBgPaintPromise) return;
  }

  if (sig !== 'idb') {
    idbBgPaintGen++;
    idbBgPaintPromise = null;
  }

  pageBgApplySig = sig;

  el.style.backgroundImage = '';
  el.style.backgroundColor = '';
  el.style.background = '';
  if (bg.type === 'color') {
    revokePageBgObjectUrl();
    if (String(bg.value).startsWith('linear')) el.style.background = bg.value;
    else el.style.backgroundColor = bg.value;
  } else if (bg.type === 'image' || bg.type === 'preset') {
    const v = String(bg.value || '');
    if (isCustomBackgroundMarker(bg)) {
      el.style.backgroundColor = PAGE_BG_GROUND_COLOR;
      const gen = idbBgPaintGen;
      idbBgPaintPromise = paintCustomBackgroundFromIdb(el, gen).finally(() => {
        idbBgPaintPromise = null;
      });
      return;
    }
    if (bg.type === 'image' && v.startsWith('data:')) {
      revokePageBgObjectUrl();
      el.style.backgroundImage = 'url("' + v.replace(/"/g, '\\"') + '")';
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      return;
    }
    revokePageBgObjectUrl();
    if (bg.type === 'image' && !v.startsWith('data:') && !/^https?:\/\//i.test(v)) {
      el.style.backgroundColor = PAGE_BG_GROUND_COLOR;
      return;
    }
    el.style.backgroundImage = 'url("' + v.replace(/"/g, '\\"') + '")';
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
  } else {
    revokePageBgObjectUrl();
    el.style.backgroundColor = PAGE_BG_GROUND_COLOR;
  }
}

/* --- Stability UI --- */
function formatLocaleTag() {
  const map = { ru: 'ru-RU', uk: 'uk-UA', en: 'en-US', hy: 'hy-AM' };
  const l =
    typeof VisualBookmarksI18n !== 'undefined'
      ? VisualBookmarksI18n.resolveEffectiveLocale(app.settings)
      : 'ru';
  return map[l] || 'ru-RU';
}

function formatNum(n, d = 2) {
  return Number(n).toLocaleString(formatLocaleTag(), { minimumFractionDigits: d, maximumFractionDigits: d });
}

function renderStability() {
  const panel = $('stabilityPanel');
  if (!app.settings.showStabilityInfo) {
    panel.classList.add('is-hidden');
    panel.hidden = true;
    return;
  }
  panel.classList.remove('is-hidden');
  panel.hidden = false;
  const set = (k, v) => {
    const n = panel.querySelector('[data-stab="' + k + '"]');
    if (n) n.textContent = v;
  };
  set('package', MOCK_STABILITY.packageType);
  set('rank', MOCK_STABILITY.rank);
  set('keyType', MOCK_STABILITY.keyType);
  set('sab', MOCK_STABILITY.sabStatus);
  set('stabRate', '$' + formatNum(MOCK_STABILITY.stabUsdtRate));
  set('usdt', formatNum(MOCK_STABILITY.usdt, 0));
  const up = MOCK_STABILITY.masterDepoProfitDirection === 'up';
  const wrap = panel.querySelector('[data-stab="profitWrap"]');
  if (wrap) {
    wrap.classList.toggle('is-up', up);
    wrap.classList.toggle('stability-chip--profit', !up);
  }
  const profitEl = panel.querySelector('[data-stab="profit"]');
  if (profitEl) profitEl.textContent = (up ? '+' : '-') + formatNum(MOCK_STABILITY.masterDepoProfit) + '%';

  const exp = $('stabilityExpanded');
  exp.innerHTML =
    '<div><span class="text-muted">' +
    escapeHtml(tr('stab.exp.package')) +
    '</span><span style="color:#fbbf24">' +
    escapeHtml(MOCK_STABILITY.packageType) +
    '</span></div>' +
    '<div><span class="text-muted">' +
    escapeHtml(tr('stab.exp.rank')) +
    '</span><span style="color:#c084fc">' +
    escapeHtml(MOCK_STABILITY.rank) +
    '</span></div>' +
    '<div><span class="text-muted">' +
    escapeHtml(tr('stab.exp.stab')) +
    '</span>' +
    formatNum(MOCK_STABILITY.stab) +
    '</div>' +
    '<div><span class="text-muted">' +
    escapeHtml(tr('stab.exp.total')) +
    '</span><span style="color:#4ade80">$' +
    formatNum(MOCK_STABILITY.totalBalance) +
    '</span></div>';

  const unread = notifications.filter((n) => !n.read).length;
  const badge = $('stabilityNotifBadge');
  if (unread > 0) {
    badge.textContent = String(unread);
    badge.classList.remove('is-hidden');
  } else badge.classList.add('is-hidden');
}

function renderStabilityDropdown() {
  const dd = $('stabilityNotifDropdown');
  if (!stabilityNotifOpen) {
    dd.classList.add('is-hidden');
    return;
  }
  dd.classList.remove('is-hidden');
  let html =
    '<div class="stability-dropdown__head"><span>' +
    escapeHtml(tr('stab.notifTitle')) +
    '</span>' +
    (notifications.some((n) => !n.read)
      ? '<button type="button" id="stabReadAll" style="background:none;border:none;color:#60a5fa;cursor:pointer;font-size:0.75rem">' +
        escapeHtml(tr('stab.markAllRead')) +
        '</button>'
      : '') +
    '</div>';
  if (!notifications.length) {
    html +=
      '<div style="padding:1rem;text-align:center;color:rgba(255,255,255,0.5);font-size:0.875rem">' +
      escapeHtml(tr('stab.noNotifications')) +
      '</div>';
  }
  else {
    notifications.forEach((n) => {
      html +=
        '<div class="stability-dropdown__item" style="' +
        (!n.read ? 'background:rgba(59,130,246,0.1)' : '') +
        '"><div style="flex:1"><div>' +
        escapeHtml(n.text) +
        '</div><span style="font-size:0.7rem;opacity:0.5">' +
        escapeHtml(n.time) +
        '</span></div><button type="button" data-notif-dismiss="' +
        n.id +
        '" style="border:none;background:transparent;color:#71717a;cursor:pointer">×</button></div>';
    });
  }
  dd.innerHTML = html;
  dd.querySelector('#stabReadAll')?.addEventListener('click', () => {
    notifications = notifications.map((x) => ({ ...x, read: true }));
    renderStability();
    renderStabilityDropdown();
  });
  dd.querySelectorAll('[data-notif-dismiss]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = +btn.getAttribute('data-notif-dismiss');
      notifications = notifications.filter((x) => x.id !== id);
      renderStability();
      renderStabilityDropdown();
    });
  });
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/* --- Header / search --- */
function renderHeader() {
  const login = $('btnLogin');
  const profWrap = $('headerProfile');
  if (app.user) {
    login.classList.add('is-hidden');
    profWrap.classList.remove('is-hidden');
    $('profileName').textContent = app.user.name;
    const av = $('profileAvatar');
    if (app.user.avatar) av.innerHTML = '<img src="' + escapeAttr(app.user.avatar) + '" alt="">';
    else av.textContent = (app.user.name || '?').charAt(0).toUpperCase();
    $('ddName').textContent = app.user.name;
    $('ddEmail').textContent = app.user.email || '';
  } else {
    login.classList.remove('is-hidden');
    profWrap.classList.add('is-hidden');
  }
  if (!profileMenuOpen) $('profileDropdown').classList.add('is-hidden');
  else $('profileDropdown').classList.remove('is-hidden');
}

function currentEngine() {
  return SEARCH_ENGINES.find((e) => e.id === app.settings.searchEngine) || SEARCH_ENGINES[0];
}

function renderSearch() {
  const wrap = $('searchWrap');
  if (!app.settings.showSearch) {
    wrap.classList.add('is-hidden');
    return;
  }
  wrap.classList.remove('is-hidden');
  const eng = currentEngine();
  const icon = $('engineIcon');
  icon.src = eng.icon;
  icon.alt = eng.name;
  $('searchInput').placeholder = tr('search.ph.' + eng.id);
  const menu = $('engineMenu');
  if (!engineMenuOpen) menu.classList.add('is-hidden');
  else {
    menu.classList.remove('is-hidden');
    menu.innerHTML = SEARCH_ENGINES.map(
      (e) =>
        '<button type="button" role="option" class="search-engine__item' +
        (e.id === eng.id ? ' is-selected' : '') +
        '" data-engine="' +
        e.id +
        '"><img src="' +
        e.icon +
        '" alt=""/>' +
        escapeHtml(e.name) +
        '</button>'
    ).join('');
    menu.querySelectorAll('[data-engine]').forEach((b) => {
      b.addEventListener('click', () => {
        app.settings.searchEngine = b.getAttribute('data-engine');
        engineMenuOpen = false;
        persist();
      });
    });
  }
}

function renderBookmarksBar() {
  const bar = $('bookmarksBar');
  if (!app.settings.showBookmarksBar) {
    bar.classList.add('is-hidden');
    return;
  }
  bar.classList.remove('is-hidden');
  const linkRel = app.settings.openLinksInNewTab ? ' target="_blank" rel="noopener noreferrer"' : ' rel="noopener noreferrer"';
  bar.innerHTML = sortedBookmarks()
    .slice(0, effectiveMaxBookmarks())
    .map(
      (b) =>
        '<a class="bookmarks-bar__link" href="' +
        escapeAttr(b.url) +
        '"' +
        linkRel +
        '>' +
        escapeHtml(b.title) +
        '</a>'
    )
    .join('');
}

function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;');
}

function openExternalUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return;
  if (app.settings.openLinksInNewTab) {
    window.open(raw, '_blank', 'noopener,noreferrer');
  } else {
    window.location.assign(raw);
  }
}

function renderInfoPanel() {
  const el = $('infoPanel');
  if (!app.settings.showInfoPanel) {
    el.classList.add('is-hidden');
    return;
  }
  el.classList.remove('is-hidden');
  el.textContent = tr('info.panelText');
}

const DELETE_RING_R = 28;
const DELETE_RING_C = 2 * Math.PI * DELETE_RING_R;

function clearPendingDeleteInterval() {
  if (pendingDeleteIntervalId != null) {
    clearInterval(pendingDeleteIntervalId);
    pendingDeleteIntervalId = null;
  }
}

function updateDeleteProgressRings() {
  const off = DELETE_RING_C * (1 - pendingDeleteProgress / 100);
  document.querySelectorAll('[data-delete-ring="1"]').forEach((el) => {
    el.setAttribute('stroke-dasharray', String(DELETE_RING_C));
    el.setAttribute('stroke-dashoffset', String(off));
  });
}

function cancelBookmarkDelete() {
  clearPendingDeleteInterval();
  pendingDeleteBookmarkId = null;
  pendingDeleteProgress = 0;
  const bar = document.getElementById('pendingDeleteBar');
  if (bar) {
    bar.classList.add('is-hidden');
    bar.hidden = true;
  }
  renderGrid();
}

function finishPendingBookmarkDelete() {
  const id = pendingDeleteBookmarkId;
  clearPendingDeleteInterval();
  pendingDeleteBookmarkId = null;
  pendingDeleteProgress = 0;
  const bar = document.getElementById('pendingDeleteBar');
  if (bar) {
    bar.classList.add('is-hidden');
    bar.hidden = true;
  }
  if (!id) {
    renderGrid();
    return;
  }
  app.bookmarks = app.bookmarks.filter((b) => b.id !== id).map((b, i) => ({ ...b, order: i }));
  void persist(true);
}

function startBookmarkDeleteCountdown(id) {
  clearPendingDeleteInterval();
  pendingDeleteBookmarkId = id;
  pendingDeleteProgress = 0;
  pendingDeleteStartMs = Date.now();
  renderGrid();
  renderPendingDeleteBar();
  updateDeleteProgressRings();
  pendingDeleteIntervalId = setInterval(() => {
    if (pendingDeleteBookmarkId !== id) {
      clearPendingDeleteInterval();
      return;
    }
    const elapsed = Date.now() - pendingDeleteStartMs;
    pendingDeleteProgress = Math.min((elapsed / BOOKMARK_DELETE_COUNTDOWN_MS) * 100, 100);
    updateDeleteProgressRings();
    if (elapsed >= BOOKMARK_DELETE_COUNTDOWN_MS) finishPendingBookmarkDelete();
  }, 50);
}

function isBookmarkVisibleInGrid(id) {
  const maxBm = effectiveMaxBookmarks();
  const list = sortedBookmarks().slice(0, maxBm);
  return list.some((b) => b.id === id);
}

function renderPendingDeleteBar() {
  const bar = document.getElementById('pendingDeleteBar');
  if (!bar) return;
  if (!pendingDeleteBookmarkId) {
    bar.classList.add('is-hidden');
    bar.hidden = true;
    return;
  }
  if (isBookmarkVisibleInGrid(pendingDeleteBookmarkId)) {
    bar.classList.add('is-hidden');
    bar.hidden = true;
    return;
  }
  bar.classList.remove('is-hidden');
  bar.hidden = false;
  updateDeleteProgressRings();
}

/* --- Grid --- */
function renderGrid() {
  const grid = $('bookmarksGrid');
  const cols = Math.min(6, Math.max(2, app.settings.gridColumns || 5));
  grid.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';

  const maxBm = effectiveMaxBookmarks();
  const list = sortedBookmarks().slice(0, maxBm);
  const atMax = app.bookmarks.length >= maxBm;
  let html = '';

  const ringOff = DELETE_RING_C * (1 - pendingDeleteProgress / 100);

  list.forEach((b, index) => {
    if (pendingDeleteBookmarkId === b.id) {
      html +=
        '<div class="bm-card-wrap' +
        (dragOverGridIndex === index && draggedGridIndex !== index ? ' is-drag-over' : '') +
        '" data-grid-index="' +
        index +
        '" draggable="false">' +
        '<div class="bm-card bm-card--delete-pending" tabindex="0" data-cancel-delete="1" role="button" aria-label="' +
        escapeAttr(tr('aria.cancelDelete')) +
        '">' +
        '<div class="bm-card-delete-overlay">' +
        '<div class="bm-card-delete-overlay__ring">' +
        '<svg class="bm-card-delete-overlay__svg" viewBox="0 0 64 64" aria-hidden="true">' +
        '<circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" stroke-width="4" class="bm-card-delete-overlay__track"/>' +
        '<circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" class="bm-card-delete-overlay__progress" data-delete-ring="1" transform="rotate(-90 32 32)" stroke-dasharray="' +
        DELETE_RING_C +
        '" stroke-dashoffset="' +
        ringOff +
        '"/>' +
        '</svg>' +
        '<span class="bm-card-delete-overlay__undo" aria-hidden="true">' +
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13"/></svg>' +
        '</span></div>' +
        '<span class="bm-card-delete-overlay__hint">' +
        escapeHtml(tr('del.cardHint')) +
        '</span>' +
        '</div></div></div>';
      return;
    }

    const tileBg = resolveTileBackground(b);
    const tc = contrastColor(tileBg);
    const bg = tileBg.startsWith('linear') ? 'background:' + tileBg : 'background-color:' + tileBg;
    const view = app.settings.bookmarkView || 'icons';
    const imgSrc = bookmarkTileIconSrc(b.url, view);
    const imgClass = view === 'screenshots' ? 'bm-card__img bm-card__img--shot' : 'bm-card__img bm-card__img--icon';
    const favLazyAttr = view !== 'screenshots' ? ' data-vb-favicon="' + escapeAttr(b.url) + '"' : '';
    html +=
      '<div class="bm-card-wrap' +
      (dragOverGridIndex === index && draggedGridIndex !== index ? ' is-drag-over' : '') +
      (draggedGridIndex === index ? ' is-dragging' : '') +
      '" data-grid-index="' +
      index +
      '" draggable="true">' +
      '<div class="bm-card" style="' +
      bg +
      '" data-open-url="' +
      escapeAttr(b.url) +
      '" data-bm-id="' +
      escapeAttr(b.id) +
      '">' +
      '<div class="bm-card__actions">' +
      '<button type="button" class="bm-card__action-btn bm-card__action-btn--edit" data-action="edit" data-id="' +
      escapeAttr(b.id) +
      '" aria-label="' +
      escapeAttr(tr('aria.editBm')) +
      '">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></button>' +
      '<button type="button" class="bm-card__action-btn bm-card__action-btn--del" data-action="del" data-id="' +
      escapeAttr(b.id) +
      '" aria-label="' +
      escapeAttr(tr('aria.delBm')) +
      '">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14zM10 11v6M14 11v6"/></svg></button>' +
      '</div>';
    if ((b.clickCount || 0) > 0) html += '<div class="bm-card__clicks" style="color:' + tc + '">' + b.clickCount + '</div>';
    html += '<div class="bm-card__body" data-open-url="' + escapeAttr(b.url) + '" data-bm-id="' + escapeAttr(b.id) + '">';
    html +=
      '<img class="' +
      imgClass +
      '"' +
      favLazyAttr +
      ' src="' +
      escapeAttr(imgSrc) +
      '" alt="" referrerpolicy="no-referrer"/>' +
      '<div class="bm-card__letter" style="display:none;background:rgba(255,255,255,0.2);color:' +
      tc +
      '">' +
      (b.title || '?').charAt(0).toUpperCase() +
      '</div>';
    html += '<span class="bm-card__title" style="color:' + tc + '">' + escapeHtml(b.title) + '</span>';
    if (b.description) html += '<span class="bm-card__desc" style="color:' + tc + '">' + escapeHtml(b.description) + '</span>';
    html += '</div></div></div>';
  });

  html +=
    '<button type="button" class="bm-add" id="gridAddBm"' +
    (atMax ? ' disabled' : '') +
    '><span class="bm-add__circle"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg></span><span class="bm-add__text">' +
    escapeHtml(tr('grid.addBookmark')) +
    '</span></button>';

  grid.innerHTML = html;

  wireGridImageFallbacks(grid);
  wireTileFaviconLazyLoad(grid);

  grid.querySelector('#gridAddBm')?.addEventListener('click', () => openBookmarkModal(null));

  grid.querySelectorAll('.bm-card-wrap').forEach((wrap) => {
    const idx = +wrap.getAttribute('data-grid-index');
    const delPending = wrap.querySelector('[data-cancel-delete="1"]');
    if (delPending) {
      wrap.addEventListener('dragstart', (e) => e.preventDefault());
      return;
    }
    wrap.addEventListener('dragstart', (e) => {
      draggedGridIndex = idx;
      e.dataTransfer.effectAllowed = 'move';
    });
    wrap.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (draggedGridIndex !== null && draggedGridIndex !== idx) dragOverGridIndex = idx;
    });
    wrap.addEventListener('dragleave', () => {
      dragOverGridIndex = null;
    });
    wrap.addEventListener('dragend', () => {
      if (draggedGridIndex !== null && dragOverGridIndex !== null && draggedGridIndex !== dragOverGridIndex) {
        reorderBookmarks(draggedGridIndex, dragOverGridIndex);
      }
      draggedGridIndex = null;
      dragOverGridIndex = null;
      renderGrid();
    });
  });

  grid.querySelectorAll('[data-cancel-delete="1"]').forEach((el) => {
    const cancel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      cancelBookmarkDelete();
    };
    el.addEventListener('click', cancel);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') cancel(e);
    });
  });

  grid.querySelectorAll('[data-action="edit"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      const bm = app.bookmarks.find((x) => x.id === id);
      if (bm) openBookmarkModal(bm);
    });
  });
  grid.querySelectorAll('[data-action="del"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      startBookmarkDeleteCountdown(btn.getAttribute('data-id'));
    });
  });

  grid.querySelectorAll('.bm-card').forEach((card) => {
    if (card.classList.contains('bm-card--delete-pending')) return;
    card.addEventListener('click', (e) => {
      const el = e.target instanceof Element ? e.target : null;
      if (!el || el.closest('.bm-card__action-btn')) return;
      const url = card.getAttribute('data-open-url');
      const id = card.getAttribute('data-bm-id');
      const go = async () => {
        if (app.settings.openLinksInNewTab) {
          void incClicks(id);
          openExternalUrl(url);
          renderGrid();
        } else {
          await incClicks(id);
          openExternalUrl(url);
        }
      };
      void go();
    });
  });

  if (pendingDeleteBookmarkId) updateDeleteProgressRings();
}

function incClicks(id) {
  app.bookmarks = app.bookmarks.map((b) => (b.id === id ? { ...b, clickCount: (b.clickCount || 0) + 1 } : b));
  return saveLocal();
}

function reorderBookmarks(from, to) {
  const list = sortedBookmarks();
  const [m] = list.splice(from, 1);
  list.splice(to, 0, m);
  list.forEach((b, i) => {
    const x = app.bookmarks.find((y) => y.id === b.id);
    if (x) x.order = i;
  });
  void persist(true);
}

function openBookmarkModal(bm) {
  editingBookmarkId = bm ? bm.id : null;
  bmAutoColor = false;
  bmColorUserTouched = false;
  bmDescUserEdited = false;
  bmDescAutofillGen++;
  clearTimeout(bmDescAutofillTimer);
  bmDescAutofillTimer = null;
  $('bookmarkModalTitle').textContent = bm ? tr('bm.titleEdit') : tr('bm.titleAdd');
  $('bmSubmit').textContent = bm ? tr('bm.save') : tr('bm.add');
  $('bmTitle').value = bm?.title || '';
  $('bmUrl').value = bm?.url || '';
  $('bmDesc').value = bm?.description || '';
  $('bmDesc').removeAttribute('data-vb-desc-source');
  $('bmDesc').removeAttribute('title');
  const rawCol = bm?.backgroundColor;
  let col = DEFAULT_TILE_BG;
  if (rawCol === FAVICON_BG) {
    bmAutoColor = true;
    $('bmAutoColor').classList.add('is-active');
    $('bmAutoHint').classList.remove('is-hidden');
    void (async () => {
      try {
        let u = bm.url;
        if (!/^https?:/i.test(u)) u = 'https://' + u;
        const fr = await getFaviconViaBackground(u);
        const fd = fr.ok && fr.dataUrl ? clampFaviconDataUrl(fr.dataUrl) : undefined;
        const sampled = await extractColorFromFaviconData(u, fd);
        col = sampled;
        $('bmColorPicker').value = col;
        renderColorPresets(col);
        updateBmPreview();
      } catch (_) {}
    })();
  } else if (rawCol && /^#[0-9a-fA-F]{6}$/.test(rawCol)) {
    col = rawCol;
    bmColorUserTouched = !!bm;
    $('bmAutoHint').classList.add('is-hidden');
    $('bmAutoColor').classList.remove('is-active');
  } else {
    bmColorUserTouched = !!bm;
    $('bmAutoHint').classList.add('is-hidden');
    $('bmAutoColor').classList.remove('is-active');
  }
  $('bmColorPicker').value = col;
  renderColorPresets(col);
  updateBmPreview();
  syncBookmarkAutoButtonState();
  const recentSec = $('bmRecentTabsSection');
  if (bm) {
    recentSec.classList.add('is-hidden');
    recentSec.setAttribute('aria-hidden', 'true');
  } else {
    recentSec.classList.remove('is-hidden');
    recentSec.setAttribute('aria-hidden', 'false');
    loadRecentTabsForBookmarkModal();
    scheduleBookmarkDescAutofill();
  }
  showModal('modalBookmark');
}

function applyRecentTabToBookmarkForm(title, url) {
  const t = (title || '').split(' - ')[0].trim() || hostFromUrl(url);
  $('bmTitle').value = t;
  $('bmUrl').value = url || '';
  bmAutoColor = true;
  bmColorUserTouched = false;
  $('bmAutoColor').classList.add('is-active');
  $('bmAutoHint').classList.remove('is-hidden');
  void (async () => {
    try {
      let u = normalizeUrl(String(url || '').trim());
      const fr = await getFaviconViaBackground(u);
      const fd = fr.ok && fr.dataUrl ? clampFaviconDataUrl(fr.dataUrl) : undefined;
      const sampled = await extractColorFromFaviconData(u, fd);
      $('bmColorPicker').value = sampled;
      renderColorPresets(sampled);
      updateBmPreview();
    } catch (_) {}
  })();
  syncBookmarkAutoButtonState();
  updateBmPreview();
}

function loadRecentTabsForBookmarkModal() {
  const listEl = $('bmRecentTabsList');
  listEl.innerHTML = '<span class="bm-recent-tabs__loading">' + escapeHtml(tr('bm.recent.loading')) + '</span>';
  if (!isExtensionContext() || typeof chrome === 'undefined' || !chrome.tabs?.query) {
    listEl.innerHTML = '<span class="bm-recent-tabs__empty">' + escapeHtml(tr('bm.recent.unavailable')) + '</span>';
    return;
  }
  try {
    chrome.tabs.getCurrent((selfTab) => {
      if (chrome.runtime.lastError) {
        listEl.innerHTML = '<span class="bm-recent-tabs__empty">' + escapeHtml(tr('bm.recent.unavailable')) + '</span>';
        return;
      }
      const selfId = selfTab?.id;
      chrome.tabs.query({ currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) {
          listEl.innerHTML = '<span class="bm-recent-tabs__empty">' + escapeHtml(tr('bm.recent.unavailable')) + '</span>';
          return;
        }
        const sorted = (tabs || [])
          .filter(
            (t) =>
              t.id !== selfId &&
              t.url &&
              !t.url.startsWith('chrome://') &&
              !t.url.startsWith('chrome-extension://') &&
              !t.url.startsWith('edge://') &&
              !t.url.startsWith('about:')
          )
          .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
          .slice(0, 6);
        if (!sorted.length) {
          listEl.innerHTML = '<span class="bm-recent-tabs__empty">' + escapeHtml(tr('bm.recent.emptyTabs')) + '</span>';
          return;
        }
        listEl.innerHTML = sorted
          .map((t) => {
            const shortTitle = escapeHtml((t.title || '').split(' - ')[0].trim() || hostFromUrl(t.url));
            let host = '';
            try {
              host = new URL(t.url).hostname;
            } catch {
              host = '';
            }
            const fav = host
              ? 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(host) + '&sz=32'
              : '';
            return (
              '<button type="button" class="bm-recent-tab" data-recent-url="' +
              escapeAttr(t.url) +
              '" data-recent-title="' +
              escapeAttr(t.title || '') +
              '">' +
              (fav ? '<img src="' + escapeAttr(fav) + '" width="16" height="16" alt="" referrerpolicy="no-referrer"/>' : '') +
              '<span class="bm-recent-tab__title">' +
              shortTitle +
              '</span></button>'
            );
          })
          .join('');
        listEl.querySelectorAll('.bm-recent-tab').forEach((btn) => {
          btn.addEventListener('click', () => {
            applyRecentTabToBookmarkForm(btn.getAttribute('data-recent-title'), btn.getAttribute('data-recent-url'));
          });
        });
      });
    });
  } catch (_) {
    listEl.innerHTML = '<span class="bm-recent-tabs__empty">' + escapeHtml(tr('bm.recent.unavailable')) + '</span>';
  }
}

function renderColorPresets(selected) {
  const el = $('bmColorPresets');
  el.innerHTML = PRESET_COLORS.map(
    (c) =>
      '<button type="button" class="color-dot' +
      (c === selected ? ' is-selected' : '') +
      '" style="background:' +
      c +
      '" data-color="' +
      c +
      '"></button>'
  ).join('');
  el.querySelectorAll('.color-dot').forEach((dot) => {
    dot.addEventListener('click', () => {
      bmColorUserTouched = true;
      bmAutoColor = false;
      $('bmColorPicker').value = dot.getAttribute('data-color');
      $('bmAutoColor').classList.remove('is-active');
      $('bmAutoHint').classList.add('is-hidden');
      renderColorPresets(dot.getAttribute('data-color'));
      updateBmPreview();
    });
  });
}

function updateBmPreview() {
  const bg = $('bmColorPicker').value;
  const title = $('bmTitle').value || tr('bm.previewDefault');
  const url = $('bmUrl').value;
  const tc = contrastColor(bg);
  let pageBase = '';
  let previewIconSrc = fallbackIconUrl();
  try {
    let u = url.trim();
    if (u && !/^https?:/i.test(u)) u = 'https://' + u;
    if (u) pageBase = u;
  } catch (_) {}
  $('bmPreview').style.backgroundColor = bg;
  $('bmPreview').innerHTML =
    (pageBase
      ? '<img src="' +
        escapeAttr(previewIconSrc) +
        '" width="32" height="32" alt="" referrerpolicy="no-referrer" class="bm-preview-favicon" data-vb-favicon="' +
        escapeAttr(normalizeUrl(url.trim())) +
        '"/>'
      : '') +
    '<span class="bm-preview__title" style="color:' +
    tc +
    '">' +
    escapeHtml(title) +
    '</span>';
  const prevImg = $('bmPreview').querySelector('img.bm-preview-favicon');
  if (prevImg) {
    wireTileImageFallback(prevImg);
    const pu = prevImg.getAttribute('data-vb-favicon');
    if (pu) {
      getFaviconCached(pu).then((fr) => {
        if (fr.ok && fr.dataUrl && prevImg.isConnected) prevImg.src = fr.dataUrl;
      });
    }
  }
  syncBookmarkAutoButtonState();
}

/** Включить «Авто», только если в поле URL можно разобрать адрес */
function syncBookmarkAutoButtonState() {
  const btn = $('bmAutoColor');
  if (!btn) return;
  let ok = false;
  try {
    let u = $('bmUrl').value.trim();
    if (!u) ok = false;
    else {
      if (!/^https?:/i.test(u)) u = 'https://' + u;
      ok = !!new URL(u).hostname;
    }
  } catch (_) {
    ok = false;
  }
  btn.disabled = !ok;
}

function sampleDominantColorHexFromImageData(data) {
  const counts = {};
  for (let i = 0; i < data.length; i += 16) {
    const r = data[i],
      g = data[i + 1],
      b = data[i + 2],
      a = data[i + 3];
    if (a < 128) continue;
    const br = (r + g + b) / 3;
    if (br > 240 || br < 15) continue;
    const qr = Math.round(r / 32) * 32,
      qg = Math.round(g / 32) * 32,
      qb = Math.round(b / 32) * 32;
    const k = qr + ',' + qg + ',' + qb;
    counts[k] = (counts[k] || 0) + 1;
  }
  let best = '#3b82f6',
    max = 0;
  Object.entries(counts).forEach(([k, n]) => {
    if (n > max) {
      max = n;
      const [rv, gv, bv] = k.split(',').map(Number);
      best = '#' + [rv, gv, bv].map((x) => x.toString(16).padStart(2, '0')).join('');
    }
  });
  return best;
}

function dominantColorHexFromImageElement(img) {
  try {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return null;
    c.width = w;
    c.height = h;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    return sampleDominantColorHexFromImageData(data);
  } catch (_) {
    return null;
  }
}

/**
 * Доминирующий цвет favicon / картинки (blob через fetch обходит часть ограничений canvas + CORS).
 */
async function extractColorFromImage(url) {
  if (typeof url === 'string' && url.startsWith('data:')) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(dominantColorHexFromImageElement(img) || '#3b82f6');
      img.onerror = () => resolve('#3b82f6');
      img.src = url;
    });
  }
  let objectUrl = null;
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'force-cache' });
    if (res.ok) {
      const blob = await res.blob();
      if (blob && blob.size > 0) {
        objectUrl = URL.createObjectURL(blob);
        const hex = await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(dominantColorHexFromImageElement(img));
          img.onerror = () => resolve(null);
          img.src = objectUrl;
        });
        if (hex) return hex;
      }
    }
  } catch (_) {
    /* сеть / CORS — ниже пробуем обычную загрузку */
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(dominantColorHexFromImageElement(img) || '#3b82f6');
    img.onerror = () => resolve('#3b82f6');
    img.src = url;
  });
}

/** Подставляет hex цвета для закладок с маркером FAVICON_BG (стартовый набор и т.п.) */
async function enrichFaviconBackgrounds() {
  const targets = app.bookmarks.filter((b) => b.backgroundColor === FAVICON_BG);
  if (!targets.length) return false;
  await Promise.all(
    targets.map(async (b) => {
      try {
        const fr = await getFaviconViaBackground(b.url);
        const fd = fr.ok && fr.dataUrl ? clampFaviconDataUrl(fr.dataUrl) : undefined;
        b.backgroundColor = await extractColorFromFaviconData(b.url, fd);
      } catch {
        b.backgroundColor = DEFAULT_TILE_BG;
      }
    })
  );
  return true;
}

/** После мгновенного добавления с авто-цветом — в фоне подставляет цвет по favicon. */
async function refineBookmarkTileColor(bookmarkId, pageUrl) {
  const u0 = normalizeUrl(pageUrl);
  try {
    const bg = await Promise.race([
      extractColorFromFaviconData(pageUrl),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
    ]);
    const sanitized = sanitizeBookmarkBackgroundColor(bg, DEFAULT_TILE_BG);
    const b = app.bookmarks.find((x) => x.id === bookmarkId);
    if (!b || normalizeUrl(b.url) !== u0) return;
    b.backgroundColor = sanitized;
    touchUpdated();
    await saveLocal();
    renderAll();
    void pushRemoteStateOnce();
  } catch (_) {
    /* офлайн / таймаут — плитка уже с дефолтным фоном */
  }
}

/* --- Settings panels --- */
const BACKGROUNDS_PER_PAGE = 5;

function renderSettingsPanels() {
  const totalPages = Math.ceil(PRESET_BACKGROUNDS.length / BACKGROUNDS_PER_PAGE);
  const slice = PRESET_BACKGROUNDS.slice(bgPage * BACKGROUNDS_PER_PAGE, (bgPage + 1) * BACKGROUNDS_PER_PAGE);
  const s = app.settings;

  $('settingsPanelAppearance').innerHTML =
    '<section class="mb-6">' +
    '<h2 class="settings-section-title">' +
    escapeHtml(tr('set.langTitle')) +
    '</h2>' +
    '<select class="settings-select" id="selUiLanguage">' +
    ['auto', 'ru', 'uk', 'en', 'hy']
      .map((code) => {
        const label =
          code === 'auto'
            ? tr('set.langAuto')
            : code === 'ru'
              ? tr('set.langRu')
              : code === 'uk'
                ? tr('set.langUk')
                : code === 'en'
                  ? tr('set.langEn')
                  : tr('set.langHy');
        return (
          '<option value="' +
          code +
          '"' +
          ((s.uiLanguage || 'auto') === code ? ' selected' : '') +
          '>' +
          escapeHtml(label) +
          '</option>'
        );
      })
      .join('') +
    '</select></section>' +
    '<section class="mb-6">' +
    '<h2 class="settings-section-title">' +
    escapeHtml(tr('set.themeTitle')) +
    '</h2>' +
    '<div class="theme-btns">' +
    ['auto', 'light', 'dark']
      .map(
        (t) =>
          '<button type="button" class="theme-btn' +
          ((s.theme || 'auto') === t ? ' is-active' : '') +
          '" data-theme-set="' +
          t +
          '">' +
          (t === 'auto' ? '🖥' : t === 'light' ? '☀' : '🌙') +
          '<span>' +
          escapeHtml(t === 'auto' ? tr('set.themeAuto') : t === 'light' ? tr('set.themeLight') : tr('set.themeDark')) +
          '</span></button>'
      )
      .join('') +
    '</div></section>' +
    '<section class="mb-6">' +
    '<h2 class="settings-section-title">' +
    escapeHtml(tr('set.bgTitle')) +
    '</h2>' +
    '<div style="display:flex;justify-content:flex-end;margin-bottom:0.5rem">' +
    '<button type="button" class="backup-btn" id="btnUploadBg">' +
    escapeHtml(tr('set.uploadBg')) +
    '</button></div>' +
    '<div class="bg-gallery-wrap">' +
    '<button type="button" class="bg-gallery-nav bg-gallery-nav--prev" id="bgPrev"' +
    (bgPage === 0 ? ' disabled' : '') +
    '>‹</button>' +
    '<button type="button" class="bg-gallery-nav bg-gallery-nav--next" id="bgNext"' +
    (bgPage >= totalPages - 1 ? ' disabled' : '') +
    '>›</button>' +
    '<div class="bg-grid">' +
    slice
      .map(
        (bg) =>
          '<button type="button" class="bg-thumb' +
          (s.background?.type === 'preset' && s.background?.value === bg.value ? ' is-selected' : '') +
          '" data-bg-preset="' +
          escapeAttr(bg.value) +
          '"><img src="' +
          escapeAttr(bg.value) +
          '" alt=""/>' +
          (s.background?.type === 'preset' && s.background?.value === bg.value ? '<span class="check">✓</span>' : '') +
          '</button>'
      )
      .join('') +
    '</div></div>' +
    '<label class="settings-check" style="margin-top:0.75rem"><input type="checkbox" id="chkDailyBg"' +
    (s.changeBgDaily ? ' checked' : '') +
    '/><span>' +
    escapeHtml(tr('set.dailyBg')) +
    '</span></label>' +
    '</section>' +
    '<section class="mb-6">' +
    '<h2 class="settings-section-title">' +
    escapeHtml(tr('set.extraTitle')) +
    '</h2>' +
    '<label class="settings-check"><input type="checkbox" id="chkBar"' +
    (s.showBookmarksBar ? ' checked' : '') +
    '/><span>' +
    escapeHtml(tr('set.bookmarksBar')) +
    '</span></label>' +
    '<label class="settings-check"><input type="checkbox" id="chkSearch"' +
    (s.showSearch !== false ? ' checked' : '') +
    '/><span>' +
    escapeHtml(tr('set.searchBar')) +
    '</span></label>' +
    '<label class="settings-check"><input type="checkbox" id="chkInfo"' +
    (s.showInfoPanel ? ' checked' : '') +
    '/><span>' +
    escapeHtml(tr('set.infoPanel')) +
    '</span></label>' +
    '<label class="settings-check"><input type="checkbox" id="chkStab"' +
    (s.showStabilityInfo ? ' checked' : '') +
    '/><span>' +
    escapeHtml(tr('set.stability')) +
    '</span></label>' +
    '<label class="settings-check"><input type="checkbox" id="chkNewTab"' +
    (s.openLinksInNewTab ? ' checked' : '') +
    '/><span>' +
    escapeHtml(tr('set.openNewTab')) +
    '</span></label>' +
    '<label class="settings-check"><input type="checkbox" id="chkCalendar"' +
    (s.showCalendar !== false ? ' checked' : '') +
    '/><span>' +
    escapeHtml(tr('set.showCalendar')) +
    '</span></label>' +
    '</section>' +
    (s.showCalendar !== false
      ? '<section class="mb-6">' +
        '<h2 class="settings-section-title">' +
        escapeHtml(tr('set.calendarTitle')) +
        '</h2>' +
        '<p style="font-size:0.8rem;color:#6b7280;margin:0 0 0.75rem">' +
        escapeHtml(tr('set.calendarHelp')) +
        '</p>' +
        '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:0.75rem">' +
        (s.googleCalendarEnabled
          ? '<span class="settings-calendar-status settings-calendar-status--ok">' +
            escapeHtml(tr('set.calendarConnected')) +
            '</span>' +
            '<button type="button" class="backup-btn" id="btnCalendarSettingsDisconnect">' +
            escapeHtml(tr('set.disconnect')) +
            '</button>'
          : '<span class="settings-calendar-status">' +
            escapeHtml(tr('set.calendarDisconnected')) +
            '</span>' +
            '<button type="button" class="backup-btn" id="btnCalendarSettingsConnect">' +
            escapeHtml(tr('set.connect')) +
            '</button>') +
        '</div></section>'
      : '') +
    (s.showSearch !== false
      ? '<section class="mb-6"><h2 class="settings-section-title">' +
        escapeHtml(tr('set.searchEngineTitle')) +
        '</h2><div class="engine-grid">' +
        SEARCH_ENGINES.map(
          (e) =>
            '<button type="button" class="engine-btn' +
            ((s.searchEngine || 'google') === e.id ? ' is-active' : '') +
            '" data-engine-pick="' +
            e.id +
            '"><img src="' +
            e.icon +
            '" width="16" height="16" alt=""/>' +
            e.name +
            '</button>'
        ).join('') +
        '</div></section>'
      : '') +
    '<section class="mb-6"><h2 class="settings-section-title">' +
    escapeHtml(tr('set.gridCols')) +
    '</h2>' +
    '<div class="settings-row"><input type="range" class="settings-range" min="2" max="6" id="rangeCols" value="' +
    (s.gridColumns || 5) +
    '"/><span style="width:2rem;text-align:center;font-size:0.875rem">' +
    (s.gridColumns || 5) +
    '</span></div></section>';

  $('settingsPanelBookmarks').innerHTML =
    '<section class="mb-6">' +
    '<h2 class="settings-section-title">' +
    escapeHtml(tr('set.bookmarksTitle')) +
    '</h2>' +
    '<div class="settings-row"><label class="settings-label-inline">' +
    escapeHtml(tr('set.count')) +
    '</label>' +
    '<input type="range" class="settings-range" min="' +
    MIN_BOOKMARKS_LIMIT +
    '" max="' +
    MAX_BOOKMARKS_LIMIT +
    '" id="rangeMaxBm" value="' +
    (s.maxBookmarks ?? DEFAULT_SETTINGS.maxBookmarks) +
    '"/><span style="width:2rem;text-align:center;font-size:0.875rem" id="maxBmLabel">' +
    (s.maxBookmarks ?? DEFAULT_SETTINGS.maxBookmarks) +
    '</span></div>' +
    '<div class="settings-row" style="margin-top:0.75rem"><label class="settings-label-inline">' +
    escapeHtml(tr('set.view')) +
    '</label>' +
    '<select class="settings-select" id="selView">' +
    '<option value="icons"' +
    (s.bookmarkView === 'icons' ? ' selected' : '') +
    '>' +
    escapeHtml(tr('set.viewIcons')) +
    '</option>' +
    '<option value="screenshots"' +
    (s.bookmarkView === 'screenshots' ? ' selected' : '') +
    '>' +
    escapeHtml(tr('set.viewScreenshots')) +
    '</option></select></div>' +
    '<div style="margin-top:1rem;display:flex;gap:0.5rem">' +
    '<button type="button" class="backup-btn" id="setAddBm">' +
    escapeHtml(tr('set.addBm')) +
    '</button></div>' +
    '<div class="bm-settings-list" style="margin-top:0.75rem">' +
    sortedBookmarks()
      .map(
        (b) =>
          '<div class="bm-settings-row"><div class="bm-settings-row__meta"><div class="bm-settings-row__title">' +
          escapeHtml(b.title) +
          '</div><div class="bm-settings-row__url">' +
          escapeHtml(b.url) +
          '</div></div><div class="bm-settings-row__actions">' +
          '<button type="button" class="icon-btn" data-set-edit="' +
          escapeAttr(b.id) +
          '">' +
          escapeHtml(tr('set.editBm')) +
          '</button>' +
          '<button type="button" class="icon-btn icon-btn--danger" data-set-del="' +
          escapeAttr(b.id) +
          '">' +
          escapeHtml(tr('set.delBm')) +
          '</button></div></div>'
      )
      .join('') +
    '</div></section>';

  $('settingsPanelSystem').innerHTML =
    '<section class="mb-6"><h2 class="settings-section-title">' +
    escapeHtml(tr('set.accountTitle')) +
    '</h2>' +
    '<p style="font-size:0.8rem;color:#6b7280;margin:0 0 0.75rem">' +
    escapeHtml(tr('set.accountHelp')) +
    '</p>' +
    '<div class="settings-row" style="flex-direction:column;align-items:stretch;gap:0.5rem">' +
    '<p style="font-size:0.8rem;margin:0"><a href="#" id="linkCryptChainLogin" style="color:#2563eb;text-decoration:underline">' +
    escapeHtml(tr('set.openLoginPage')) +
    '</a></p>' +
    '<div style="display:flex;flex-wrap:wrap;gap:0.5rem">' +
    '<button type="button" class="backup-btn" id="btnServerSync">' +
    escapeHtml(tr('set.sync')) +
    '</button>' +
    '<button type="button" class="backup-btn" id="btnServerLogout">' +
    escapeHtml(tr('set.logoutAccount')) +
    '</button></div>' +
    '<p id="serverApiStatus" style="font-size:0.75rem;color:#6b7280;margin:0"></p></div></section>' +
    '<section class="mb-6"><h2 class="settings-section-title">' +
    escapeHtml(tr('set.backupTitle')) +
    '</h2>' +
    '<div class="backup-btns">' +
    '<button type="button" class="backup-btn" id="backupSave">' +
    escapeHtml(tr('set.saveFile')) +
    '</button>' +
    '<button type="button" class="backup-btn" id="backupLoad">' +
    escapeHtml(tr('set.loadFile')) +
    '</button>' +
    '<button type="button" class="backup-btn" id="backupReset" style="border-color:#fecaca;color:#b91c1c">' +
    escapeHtml(tr('set.reset')) +
    '</button></div></section>' +
    '<footer class="settings-footer"><p>' +
    escapeHtml(tr('set.footerVersion')) +
    '</p></footer>';

  wireSettingsAppearance(totalPages);
  wireSettingsBookmarks();
  wireSettingsSystem();
}

function wireSettingsAppearance(totalPages) {
  document.querySelectorAll('[data-theme-set]').forEach((b) => {
    b.addEventListener('click', () => {
      app.settings.theme = b.getAttribute('data-theme-set');
      persist();
      renderSettingsIfOpen();
    });
  });
  $('btnUploadBg').addEventListener('click', () => $('hiddenBgFile').click());
  $('bgPrev').addEventListener('click', () => {
    if (bgPage > 0) {
      bgPage--;
      renderSettingsIfOpen();
    }
  });
  $('bgNext').addEventListener('click', () => {
    if (bgPage < totalPages - 1) {
      bgPage++;
      renderSettingsIfOpen();
    }
  });
  document.querySelectorAll('[data-bg-preset]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (isCustomBackgroundMarker(app.settings.background)) {
        await abandonCustomBackgroundBlobIfAny();
      }
      app.settings.background = { type: 'preset', value: b.getAttribute('data-bg-preset') };
      persist();
      renderSettingsIfOpen();
    });
  });
  $('chkDailyBg').addEventListener('change', () => {
    app.settings.changeBgDaily = $('chkDailyBg').checked;
    persist();
    renderSettingsIfOpen();
  });
  ['chkBar', 'chkSearch', 'chkInfo', 'chkStab', 'chkNewTab', 'chkCalendar'].forEach((id, i) => {
    const keys = [
      'showBookmarksBar',
      'showSearch',
      'showInfoPanel',
      'showStabilityInfo',
      'openLinksInNewTab',
      'showCalendar',
    ];
    $(id).addEventListener('change', () => {
      app.settings[keys[i]] = $(id).checked;
      persist();
      renderSettingsIfOpen();
      if (keys[i] === 'openLinksInNewTab') {
        renderBookmarksBar();
      }
      if (keys[i] === 'showCalendar') {
        renderCalendarWidget();
      }
    });
  });
  const btnCalConn = document.getElementById('btnCalendarSettingsConnect');
  if (btnCalConn) {
    btnCalConn.addEventListener('click', () => {
      hideModal('modalSettings');
      showModal('modalCalendarConnect');
    });
  }
  const btnCalDis = document.getElementById('btnCalendarSettingsDisconnect');
  if (btnCalDis) {
    btnCalDis.addEventListener('click', () => {
      app.settings.googleCalendarEnabled = false;
      stopCalendarRotation();
      calendarEvents = [];
      void (async () => {
        await clearCalendarEventsCache();
        await revokeGoogleCalendarCachedAuth();
        await persist(true);
        renderSettingsIfOpen();
        renderCalendarWidget();
      })();
    });
  }
  document.querySelectorAll('[data-engine-pick]').forEach((b) => {
    b.addEventListener('click', () => {
      app.settings.searchEngine = b.getAttribute('data-engine-pick');
      persist();
      renderSettingsIfOpen();
    });
  });
  $('rangeCols').addEventListener('input', () => {
    app.settings.gridColumns = +$('rangeCols').value;
    const sp = $('rangeCols').parentElement?.querySelector('span');
    if (sp) sp.textContent = String(app.settings.gridColumns);
    persist();
  });
  const selLang = $('selUiLanguage');
  if (selLang) {
    selLang.addEventListener('change', async () => {
      app.settings.uiLanguage = selLang.value;
      persist();
      await syncI18n();
      renderAll();
      renderSettingsIfOpen();
    });
  }
}

function wireSettingsBookmarks() {
  $('rangeMaxBm').addEventListener('input', () => {
    app.settings.maxBookmarks = clampMaxBookmarksValue(+$('rangeMaxBm').value);
    $('maxBmLabel').textContent = String(app.settings.maxBookmarks);
    persist();
    renderGrid();
  });
  $('selView').addEventListener('change', () => {
    app.settings.bookmarkView = $('selView').value;
    persist();
  });
  $('setAddBm').addEventListener('click', () => {
    hideModal('modalSettings');
    openBookmarkModal(null);
  });
  document.querySelectorAll('[data-set-edit]').forEach((b) => {
    b.addEventListener('click', () => {
      const bm = app.bookmarks.find((x) => x.id === b.getAttribute('data-set-edit'));
      hideModal('modalSettings');
      if (bm) openBookmarkModal(bm);
    });
  });
  document.querySelectorAll('[data-set-del]').forEach((b) => {
    b.addEventListener('click', () => {
      hideModal('modalSettings');
      startBookmarkDeleteCountdown(b.getAttribute('data-set-del'));
    });
  });
}

function wireSettingsSystem() {
  const st = $('serverApiStatus');
  $('linkCryptChainLogin').addEventListener('click', (e) => {
    e.preventDefault();
    const url =
      typeof VisualBookmarksApi !== 'undefined' && VisualBookmarksApi.getLoginPageUrl
        ? VisualBookmarksApi.getLoginPageUrl()
        : 'https://crypt-chain.com/browser-extension/login';
    window.open(url, '_blank', 'noopener,noreferrer');
  });

  $('btnServerSync').addEventListener('click', async () => {
    if (typeof VisualBookmarksApi === 'undefined') {
      st.textContent = tr('set.syncApiMissing');
      return;
    }
    if (!(await VisualBookmarksApi.hasToken())) {
      st.textContent = tr('set.syncNeedLogin');
      return;
    }
    st.textContent = tr('set.syncing');
    try {
      await pullServerMerge({ allowSeedPush: true });
      scheduleCalendarRefreshAfterServerPull();
      st.textContent = tr('set.syncDonePrefix') + new Date().toLocaleTimeString();
    } catch (e) {
      st.textContent = e.message || String(e);
    }
    renderAll();
    renderHeader();
    renderSettingsIfOpen();
  });

  $('btnServerLogout').addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const stEl = $('serverApiStatus');
    stEl.textContent = tr('set.logoutWorking');
    try {
      await performCryptChainLogout();
      stEl.textContent = tr('set.logoutDone');
    } catch (err) {
      console.warn('Выход из аккаунта:', err);
      stEl.textContent = err.message || String(err);
    } finally {
      renderHeader();
      renderAll();
    }
  });

  $('backupSave').addEventListener('click', () => {
    const blob = new Blob([exportJsonString()], { type: 'application/json' });
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = 'visual-bookmarks-backup.json';
    a.click();
    URL.revokeObjectURL(u);
  });
  $('backupLoad').addEventListener('click', () => $('hiddenImportFile').click());
  $('backupReset').addEventListener('click', async () => {
    if (!confirm(tr('confirm.reset'))) return;
    resetDefaults();
    await persist();
    hideModal('modalSettings');
    void (async () => {
      try {
        if (await enrichFaviconBackgrounds()) {
          touchUpdated();
          await saveLocal();
          renderAll();
          debouncedPush();
        }
      } catch (_) {}
    })();
  });
}

function renderSettingsIfOpen() {
  if (!$('modalSettings').classList.contains('is-hidden')) renderSettingsPanels();
}

function switchSettingsTab(tab) {
  settingsTab = tab;
  document.querySelectorAll('.settings-tab').forEach((b) => {
    b.classList.toggle('is-active', b.getAttribute('data-settings-tab') === tab);
  });
  $('settingsPanelAppearance').classList.toggle('is-hidden', tab !== 'appearance');
  $('settingsPanelBookmarks').classList.toggle('is-hidden', tab !== 'bookmarks');
  $('settingsPanelSystem').classList.toggle('is-hidden', tab !== 'system');
}

/* --- Modals --- */
function showModal(id) {
  const m = $(id);
  m.classList.remove('is-hidden');
  m.hidden = false;
  if (id === 'modalCalendarConnect') {
    calendarConnectInFlight = false;
    const b = document.getElementById('btnCalendarModalConnect');
    if (b) {
      b.disabled = false;
      b.removeAttribute('aria-busy');
      b.classList.remove('vb-btn-loader');
    }
    logCalendarConnect('модалка календаря открыта: сброшены inFlight и кнопка (на случай зависшего прошлого запуска)');
  }
}

function hideModal(id) {
  const m = $(id);
  m.classList.add('is-hidden');
  m.hidden = true;
}

function renderAll() {
  applyTheme();
  applyBackground();
  renderStability();
  renderStabilityDropdown();
  renderHeader();
  renderSearch();
  renderBookmarksBar();
  renderInfoPanel();
  renderGrid();
  renderPendingDeleteBar();
  renderCalendarWidget();
}

/** Встроенные страницы браузера в новой вкладке (без модалки и без API bookmarks/history/…). */
function browserToolkitUrl(kind) {
  const edge = typeof navigator !== 'undefined' && /Edg\//.test(navigator.userAgent || '');
  const map = edge
    ? {
        sessions: 'edge://history/',
        downloads: 'edge://downloads/',
        bookmarks: 'edge://favorites/',
        history: 'edge://history/',
      }
    : {
        sessions: 'chrome://history/',
        downloads: 'chrome://downloads/',
        bookmarks: 'chrome://bookmarks/',
        history: 'chrome://history/',
      };
  return map[kind] || '';
}

function openBrowserToolkitPage(kind) {
  const url = browserToolkitUrl(kind);
  if (!url) return;
  if (!isExtensionContext() || typeof chrome.tabs?.create !== 'function') {
    alert(tr('alert.extensionOnly'));
    return;
  }
  chrome.tabs.create({ url }, () => {
    const err = chrome.runtime.lastError;
    if (err) console.warn('tabs.create:', err.message);
  });
}

/* --- Init wire --- */
function onGlobalClick(e) {
  const t = e.target;
  if (t.closest('#btnEngine')) return;
  if (!t.closest('.search-engine')) engineMenuOpen = false;
  if (!t.closest('#headerProfile')) {
    profileMenuOpen = false;
    $('profileDropdown')?.classList.add('is-hidden');
  }
  renderSearch();
  renderHeader();
}

function scheduleWhenIdle(fn, timeoutMs = 2500) {
  if (typeof requestIdleCallback !== 'undefined') {
    requestIdleCallback(() => fn(), { timeout: timeoutMs });
  } else {
    setTimeout(fn, 0);
  }
}

/** Два rAF подряд — даём браузеру отрисовать кадр до тяжёлой работы (OAuth / persist). */
function yieldToPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

/** VB_CALENDAR_CONNECT с таймаутом: иначе callback иногда не вызывается и кнопка остаётся disabled. */
function sendCalendarConnectToWorker(timeoutMs = 180000) {
  return new Promise((resolve) => {
    logCalendarConnect('отправка VB_CALENDAR_CONNECT в service worker (таймаут', timeoutMs / 1000, 'с)…');
    const t = setTimeout(() => {
      console.warn(
        '[VB Calendar]',
        'таймаут: нет ответа worker за',
        timeoutMs / 1000,
        'с. Откройте chrome://extensions → «Проверить вид» у service worker и смотрите консоль [VB Calendar SW]'
      );
      resolve({
        ok: false,
        events: [],
        error:
          'Нет ответа от service worker. Откройте chrome://extensions, нажмите «service worker» → Inspect, повторите подключение.',
      });
    }, timeoutMs);
    try {
      chrome.runtime.sendMessage({ type: 'VB_CALENDAR_CONNECT' }, (r) => {
        clearTimeout(t);
        if (chrome.runtime.lastError) {
          console.warn('[VB Calendar] chrome.runtime.lastError:', chrome.runtime.lastError.message);
          resolve({
            ok: false,
            events: [],
            error: chrome.runtime.lastError.message,
          });
          return;
        }
        logCalendarConnect(
          'ответ worker:',
          r && typeof r === 'object' ? { ok: r.ok, error: r.error, eventsCount: Array.isArray(r.events) ? r.events.length : '—' } : r
        );
        resolve(r && typeof r === 'object' ? r : { ok: false, events: [], error: 'нет ответа' });
      });
    } catch (err) {
      clearTimeout(t);
      console.warn('[VB Calendar] sendMessage throw:', err);
      resolve({ ok: false, events: [], error: String(err) });
    }
  });
}

async function init() {
  try {
    if (typeof VisualBookmarksI18n !== 'undefined') {
      await VisualBookmarksI18n.loadPacks(peekSettingsForI18n());
    }
  } catch (e) {
    console.warn('VB i18n (boot peek):', e);
  }

  if (vbDebugStorage()) {
    console.info(
      '[VB storage] chrome.storage.local не создаёт записей во вкладке Network. Смотрите Application → extension URL → Storage, либо service worker → Storage.'
    );
  }

  let shownFromBoot = false;
  try {
    if (tryApplyBootCache()) {
      shownFromBoot = true;
      $('loader').classList.add('is-hidden');
      await Promise.race([
        hydrateCalendarEventsFromCacheIfPossible(),
        new Promise((r) => setTimeout(r, 8000)),
      ]);
      await syncI18n();
      $('authTitle').textContent = tr('auth.titleLogin');
      $('authSubmit').textContent = tr('auth.submitLogin');
      renderAll();
    }
  } catch (_) {}

  let cryptSession = { hasToken: false, user: null };
  const sessionPromise =
    typeof VisualBookmarksApi !== 'undefined' ? VisualBookmarksApi.getSessionForNewTab() : Promise.resolve(null);
  await Promise.all([
    loadState(),
    Promise.race([
      sessionPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
    ]).then((s) => {
      if (s) cryptSession = s;
    }),
  ]);
  await Promise.race([
    hydrateCustomBackgroundIfNeeded(),
    new Promise((r) => setTimeout(r, 12000)),
  ]);
  await Promise.race([
    hydrateCalendarEventsFromCacheIfPossible(),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
  if (cryptSession.hasToken && cryptSession.user) {
    if (app.user == null) {
      app.user = normalizeServerUser(cryptSession.user);
    }
  }

  if (!shownFromBoot) {
    $('loader').classList.add('is-hidden');
  }
  await syncI18n();
  $('authTitle').textContent = tr(authMode === 'login' ? 'auth.titleLogin' : 'auth.titleRegister');
  $('authSubmit').textContent = tr(authMode === 'login' ? 'auth.submitLogin' : 'auth.submitRegister');
  renderAll();

  document.addEventListener('click', onGlobalClick);

  $('btnLogin').addEventListener('click', () => {
    authMode = 'login';
    document.querySelectorAll('.auth-tab').forEach((x) => x.classList.toggle('is-active', x.getAttribute('data-auth-mode') === 'login'));
    $('authTitle').textContent = tr('auth.titleLogin');
    $('authSubmit').textContent = tr('auth.submitLogin');
    $('authNameRow').classList.add('is-hidden');
    showModal('modalAuth');
  });

  $('btnProfileMenu').addEventListener('click', (e) => {
    e.stopPropagation();
    profileMenuOpen = !profileMenuOpen;
    renderHeader();
  });

  $('btnLogout').addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await performCryptChainLogout();
    } catch (err) {
      console.warn('Выход из аккаунта:', err);
    } finally {
      renderHeader();
      renderSettingsIfOpen();
    }
  });

  $('btnEngine').addEventListener('click', (e) => {
    e.stopPropagation();
    engineMenuOpen = !engineMenuOpen;
    renderSearch();
  });

  $('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('searchInput').value.trim();
    if (!q) return;
    const eng = currentEngine();
    openExternalUrl(eng.url + encodeURIComponent(q));
  });

  document.querySelectorAll('[data-browser-action]').forEach((b) => {
    b.addEventListener('click', () => openBrowserToolkitPage(b.getAttribute('data-browser-action')));
  });

  $('btnBottomExport').addEventListener('click', () => {
    const blob = new Blob([exportJsonString()], { type: 'application/json' });
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = 'visual-bookmarks-backup.json';
    a.click();
    URL.revokeObjectURL(u);
  });
  $('btnBottomAdd').addEventListener('click', () => openBookmarkModal(null));
  $('btnBottomSettings').addEventListener('click', () => {
    bgPage = 0;
    renderSettingsPanels();
    switchSettingsTab('appearance');
    showModal('modalSettings');
  });

  document.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', () => hideModal(el.getAttribute('data-close')));
  });

  document.querySelectorAll('.settings-tab').forEach((b) => {
    b.addEventListener('click', () => {
      switchSettingsTab(b.getAttribute('data-settings-tab'));
      if (b.getAttribute('data-settings-tab') === 'bookmarks') renderSettingsPanels();
    });
  });

  document.querySelectorAll('.auth-tab').forEach((b) => {
    b.addEventListener('click', () => {
      authMode = b.getAttribute('data-auth-mode');
      document.querySelectorAll('.auth-tab').forEach((x) => x.classList.toggle('is-active', x === b));
      $('authTitle').textContent = authMode === 'login' ? tr('auth.titleLogin') : tr('auth.titleRegister');
      $('authSubmit').textContent = authMode === 'login' ? tr('auth.submitLogin') : tr('auth.submitRegister');
      $('authNameRow').classList.toggle('is-hidden', authMode === 'login');
    });
  });

  $('formAuth').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('authEmail').value.trim();
    const name = $('authName').value.trim();
    const pwd = $('authPassword').value;
    if (!email || !pwd) return;

    if (typeof VisualBookmarksApi !== 'undefined') {
      try {
        if (authMode === 'login') await VisualBookmarksApi.login(email, pwd);
        else await VisualBookmarksApi.register({ email, password: pwd, name });
        const su = await VisualBookmarksApi.getStoredUser();
        app.user = normalizeServerUser(su);
        hideModal('modalAuth');
        await applyServerStateAfterAuth({ isRegistration: authMode === 'register' });
        renderHeader();
      } catch (err) {
        alert(err.message || String(err));
      }
      return;
    }

    app.user = {
      id: Math.random().toString(36).slice(2, 11),
      name: name || email.split('@')[0],
      email,
      avatar: 'https://api.dicebear.com/7.x/initials/svg?seed=' + encodeURIComponent(name || email),
    };
    hideModal('modalAuth');
    persist();
  });

  $('formBookmark').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('bmSubmit');
    if (btn.disabled) return;

    const url = tryNormalizeBookmarkUrl($('bmUrl').value);
    if (!url) {
      alert(tr('alert.bmUrlInvalid'));
      $('bmUrl').focus();
      return;
    }
    let title = $('bmTitle').value.trim();
    if (!title) {
      title = defaultBookmarkTitleFromUrl(url);
    }
    const desc = $('bmDesc').value.trim();

    const fromFavicon = bmAutoColor || (!editingBookmarkId && !bmColorUserTouched);
    let bg = sanitizeBookmarkBackgroundColor($('bmColorPicker').value, DEFAULT_TILE_BG);
    if (fromFavicon) {
      bg = DEFAULT_TILE_BG;
    }

    let targetId = editingBookmarkId;
    let newId = null;

    if (editingBookmarkId) {
      const b = app.bookmarks.find((x) => x.id === editingBookmarkId);
      if (b) {
        b.title = title;
        b.url = url;
        b.description = desc;
        b.backgroundColor = bg;
        delete b.faviconDataUrl;
      }
    } else {
      const cap = effectiveMaxBookmarks();
      if (app.bookmarks.length >= cap) {
        alert(trR('alert.bmLimit', { n: cap }));
        return;
      }
      newId = generateId();
      targetId = newId;
      const maxO = Math.max(0, ...app.bookmarks.map((x) => x.order || 0));
      app.bookmarks.push({
        id: newId,
        title,
        url,
        description: desc,
        backgroundColor: bg,
        order: maxO + 1,
        clickCount: 0,
      });
    }

    try {
      await persist(true);
      hideModal('modalBookmark');
      if (fromFavicon && targetId) void refineBookmarkTileColor(targetId, url);
    } catch (err) {
      console.error(err);
      alert(tr('alert.bmSaveFail') + (err.message || String(err)));
    }
  });

  $('bmColorPicker').addEventListener('input', () => {
    bmColorUserTouched = true;
    bmAutoColor = false;
    $('bmAutoColor').classList.remove('is-active');
    $('bmAutoHint').classList.add('is-hidden');
    renderColorPresets($('bmColorPicker').value);
    updateBmPreview();
  });
  $('bmTitle').addEventListener('input', updateBmPreview);
  $('bmDesc').addEventListener('input', () => {
    bmDescUserEdited = true;
    $('bmDesc').removeAttribute('title');
    $('bmDesc').removeAttribute('data-vb-desc-source');
    updateBmPreview();
  });
  $('bmUrl').addEventListener('input', () => {
    updateBmPreview();
    scheduleBookmarkDescAutofill();
  });

  $('bmAutoColor').addEventListener('click', async () => {
    const url = $('bmUrl').value.trim();
    if (!url) return;
    bmAutoColor = true;
    bmColorUserTouched = false;
    $('bmAutoColor').classList.add('is-active');
    $('bmAutoHint').classList.remove('is-hidden');
    $('bmAutoSpinner').classList.remove('is-hidden');
    $('bmAutoLabel').classList.add('is-hidden');
    let u = url;
    if (!/^https?:/i.test(u)) u = 'https://' + u;
    const fr = await getFaviconViaBackground(u);
    const fd = fr.ok && fr.dataUrl ? clampFaviconDataUrl(fr.dataUrl) : undefined;
    const col = await extractColorFromFaviconData(u, fd);
    $('bmColorPicker').value = col;
    renderColorPresets(col);
    updateBmPreview();
    $('bmAutoSpinner').classList.add('is-hidden');
    $('bmAutoLabel').classList.remove('is-hidden');
  });

  const pendingBar = document.getElementById('pendingDeleteBar');
  const pendingBarInner = pendingBar?.querySelector('[data-pending-delete-cancel]');
  if (pendingBarInner) {
    pendingBarInner.addEventListener('click', (e) => {
      e.preventDefault();
      cancelBookmarkDelete();
    });
    pendingBarInner.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        cancelBookmarkDelete();
      }
    });
  }

  $('hiddenBgFile').addEventListener('change', async () => {
    const f = $('hiddenBgFile').files?.[0];
    $('hiddenBgFile').value = '';
    if (!f) return;
    if (typeof VisualBookmarksCustomBg === 'undefined') {
      alert(tr('alert.bgIdb'));
      return;
    }
    try {
      await VisualBookmarksCustomBg.saveBlob(f);
      app.settings.background = { type: 'image', value: CUSTOM_BG_MARKER };
      revokePageBgObjectUrl();
      pageBgObjectUrl = URL.createObjectURL(f);
      const el = $('pageBg');
      el.style.backgroundImage = 'url("' + pageBgObjectUrl.replace(/"/g, '\\"') + '")';
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      await persist();
      renderSettingsIfOpen();
    } catch (e) {
      alert((e && e.message) || String(e));
    }
  });

  $('hiddenImportFile').addEventListener('change', () => {
    const f = $('hiddenImportFile').files?.[0];
    $('hiddenImportFile').value = '';
    if (!f) return;
    f.text().then(async (text) => {
      try {
        importFromJson(text);
        const ibg = app.settings.background;
        if (
          ibg?.type === 'image' &&
          typeof ibg.value === 'string' &&
          ibg.value.startsWith('data:') &&
          typeof VisualBookmarksCustomBg !== 'undefined'
        ) {
          await VisualBookmarksCustomBg.saveFromDataUrl(ibg.value);
          app.settings.background = { type: 'image', value: CUSTOM_BG_MARKER };
        }
        await hydrateCustomBackgroundIfNeeded();
        await persist(true);
        hideModal('modalSettings');
        void (async () => {
          try {
            if (await enrichFaviconBackgrounds()) {
              touchUpdated();
              await saveLocal();
              renderAll();
              debouncedPush();
            }
          } catch (_) {}
        })();
      } catch (err) {
        alert(tr('alert.importErr') + err.message);
      }
    });
  });

  $('stabilityToggle').addEventListener('click', () => {
    stabilityExpanded = !stabilityExpanded;
    $('stabilityExpanded').classList.toggle('is-hidden', !stabilityExpanded);
    document.querySelector('.stability-chev--down').classList.toggle('is-hidden', stabilityExpanded);
    document.querySelector('.stability-chev--up').classList.toggle('is-hidden', !stabilityExpanded);
  });

  $('stabilityNotifBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    stabilityNotifOpen = !stabilityNotifOpen;
    renderStabilityDropdown();
  });

  document.addEventListener('click', (ev) => {
    if (
      stabilityNotifOpen &&
      !$('stabilityNotifDropdown').contains(ev.target) &&
      !ev.target.closest('#stabilityNotifBtn')
    ) {
      stabilityNotifOpen = false;
      renderStabilityDropdown();
    }
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (app.settings.theme === 'auto') renderAll();
  });

  {
    const calBtn = document.getElementById('btnCalendarModalConnect');
    if (calBtn) {
      calBtn.addEventListener('click', () => {
        logCalendarConnect('клик #btnCalendarModalConnect');
        void connectGoogleCalendar();
      });
    } else {
      console.warn('[VB Calendar] при init не найден #btnCalendarModalConnect — обработчик не навешан');
    }
  }

  scheduleWhenIdle(() => {
    try {
      if (isExtensionContext() && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: 'VB_CALENDAR_SW_WAKE' }, () => {
          void chrome.runtime?.lastError;
        });
      }
    } catch (_) {}
  });

  scheduleWhenIdle(() => {
    void (async () => {
      try {
        await pullRemoteMerge();
      } catch (_) {}
      scheduleWhenIdle(() => {
        void (async () => {
          try {
            if (await enrichFaviconBackgrounds()) {
              touchUpdated();
              await saveLocal();
              renderAll();
              debouncedPush();
            }
          } catch (_) {}
        })();
      }, 4000);
    })();
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('vb-session-invalid', () => {
    void onCryptChainSessionInvalidatedByServer();
  });
}

init();
