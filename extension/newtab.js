/** Плитка ждёт цвет из favicon (после загрузки подставляется hex) */
const FAVICON_BG = '__favicon__';

const STORAGE_KEY = 'visualBookmarks_state_v2';
const STORAGE_KEY_LEGACY = 'visualBookmarks_state_v1';
const SYNC_FILENAME = 'visual-bookmarks-sync.json';
const SYNC_DEBOUNCE_MS = 2500;
const MIME_JSON = 'application/json; charset=UTF-8';

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
  maxBookmarks: 18,
  bookmarkView: 'icons',
  showBookmarksBar: false,
  showContextSuggestions: true,
  showInfoPanel: false,
  showStabilityInfo: false,
  /** false — поиск и закладки открываются в этой же вкладке */
  openLinksInNewTab: false,
  changeBgDaily: false,
  theme: 'auto',
  language: 'ru',
  _lastBgDay: null,
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

/** @type {{ updatedAt: number; driveFileId: string | null; bookmarks: any[]; settings: typeof DEFAULT_SETTINGS; user: any | null }} */
let app = {
  updatedAt: 0,
  driveFileId: null,
  bookmarks: [],
  settings: { ...DEFAULT_SETTINGS },
  user: null,
};

let editingBookmarkId = null;
let deletingBookmarkId = null;
let authMode = 'login';
let settingsTab = 'appearance';
let bgPage = 0;
let engineMenuOpen = false;
let profileMenuOpen = false;
let draggedGridIndex = null;
let dragOverGridIndex = null;
let openCardMenuId = null;
let stabilityExpanded = false;
let stabilityNotifOpen = false;
let notifications = MOCK_NOTIFICATIONS.map((n) => ({ ...n }));
let bmAutoColor = false;
/** Пользователь вручную менял цвет в модалке (иначе при «Добавить» цвет берётся с favicon) */
let bmColorUserTouched = false;

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

function getFaviconViaBackground(pageUrl) {
  return new Promise((resolve) => {
    if (!isExtensionContext() || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      resolve({ ok: false });
      return;
    }
    chrome.runtime.sendMessage({ type: 'VB_GET_FAVICON', pageUrl }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false });
        return;
      }
      resolve(response && response.ok && response.dataUrl ? response : { ok: false });
    });
  });
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
  return b.backgroundColor === FAVICON_BG ? '#475569' : b.backgroundColor || '#27272a';
}

function contrastColor(hex) {
  if (!hex || hex === FAVICON_BG || String(hex).startsWith('linear')) return '#ffffff';
  const h = String(hex).replace('#', '');
  if (h.length !== 6) return '#ffffff';
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return L > 0.55 ? '#000000' : '#ffffff';
}

function mergeSettings(base, patch) {
  return { ...base, ...patch };
}

function sortedBookmarks() {
  return [...app.bookmarks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function touchUpdated() {
  app.updatedAt = Date.now();
}

async function loadState() {
  return new Promise((resolve) => {
    storageLocal.get([STORAGE_KEY, STORAGE_KEY_LEGACY], (res) => {
      let raw = res[STORAGE_KEY];
      if (!raw && res[STORAGE_KEY_LEGACY]) {
        const leg = res[STORAGE_KEY_LEGACY];
        raw = migrateLegacy(leg);
      }
      if (raw && typeof raw === 'object') {
        app.settings = mergeSettings({ ...DEFAULT_SETTINGS }, raw.settings || {});
        app.bookmarks = Array.isArray(raw.bookmarks) ? raw.bookmarks.map(normalizeBookmark) : [];
        app.user = raw.user || null;
        app.driveFileId = raw.driveFileId ?? null;
        app.updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : 0;
        if (!app.bookmarks.length) app.bookmarks = DEFAULT_BOOKMARKS.map((b) => ({ ...b, id: generateId() }));
      } else {
        app.bookmarks = DEFAULT_BOOKMARKS.map((b) => ({ ...b, id: generateId() }));
        app.settings = { ...DEFAULT_SETTINGS };
      }
      resolve();
    });
  });
}

function migrateLegacy(leg) {
  const bms = (leg.bookmarks || []).map((b, i) => ({
    id: b.id || generateId(),
    title: b.title || hostFromUrl(b.url),
    url: normalizeUrl(b.url),
    backgroundColor: b.backgroundColor || b.color || '#3b82f6',
    description: b.description,
    order: i,
    clickCount: b.clickCount || 0,
  }));
  return {
    updatedAt: leg.updatedAt || Date.now(),
    driveFileId: leg.driveFileId ?? null,
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
    backgroundColor = '#3b82f6';
  }
  const fav = clampFaviconDataUrl(b.faviconDataUrl);
  const out = {
    id: b.id || generateId(),
    title: b.title || hostFromUrl(b.url),
    url: normalizeUrl(b.url),
    backgroundColor,
    description: b.description || '',
    order: typeof b.order === 'number' ? b.order : 0,
    clickCount: b.clickCount || 0,
  };
  if (fav) out.faviconDataUrl = fav;
  return out;
}

function saveLocal() {
  const payload = {
    updatedAt: app.updatedAt,
    driveFileId: app.driveFileId,
    bookmarks: app.bookmarks,
    settings: app.settings,
    user: app.user,
  };
  return new Promise((r) => storageLocal.set({ [STORAGE_KEY]: payload }, r));
}

function exportJsonString() {
  return JSON.stringify({ bookmarks: app.bookmarks, settings: app.settings, user: app.user, updatedAt: app.updatedAt, version: 2 }, null, 2);
}

function importFromJson(text) {
  const data = JSON.parse(text);
  if (data.bookmarks) app.bookmarks = data.bookmarks.map(normalizeBookmark).filter(Boolean);
  if (data.settings) app.settings = mergeSettings({ ...DEFAULT_SETTINGS }, data.settings);
  if (data.user !== undefined) app.user = data.user;
  touchUpdated();
}

function resetDefaults() {
  app.bookmarks = DEFAULT_BOOKMARKS.map((b) => ({ ...b, id: generateId() }));
  app.settings = { ...DEFAULT_SETTINGS };
  app.user = null;
  touchUpdated();
}

/* --- Google Drive --- */
function getToken(interactive) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.identity || typeof chrome.identity.getAuthToken !== 'function') {
      reject(new Error('Google OAuth доступен только внутри расширения Chrome'));
      return;
    }
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(token);
    });
  });
}

async function driveListFile(token) {
  const q = encodeURIComponent("name='" + SYNC_FILENAME + "' and trashed=false");
  const url = 'https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=' + q + '&fields=files(id,modifiedTime)';
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error(await r.text());
  const j = await r.json();
  return j.files || [];
}

async function driveCreateFile(token, bodyStr) {
  const boundary = 'vb_' + Date.now();
  const meta = JSON.stringify({ name: SYNC_FILENAME, parents: ['appDataFolder'] });
  const body = ['--' + boundary, 'Content-Type: ' + MIME_JSON, '', meta, '--' + boundary, 'Content-Type: ' + MIME_JSON, '', bodyStr, '--' + boundary + '--', ''].join('\r\n');
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + boundary },
    body,
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function drivePatchContent(token, fileId, bodyStr) {
  const url = 'https://www.googleapis.com/upload/drive/v3/files/' + encodeURIComponent(fileId) + '?uploadType=media';
  const r = await fetch(url, { method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': MIME_JSON }, body: bodyStr });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function driveDownload(token, fileId) {
  const url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media';
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error(await r.text());
  return r.text();
}

function drivePayload() {
  return JSON.stringify({ version: 2, updatedAt: app.updatedAt, bookmarks: app.bookmarks, settings: app.settings }, null, 2);
}

async function pushDrive(token) {
  const body = drivePayload();
  if (app.driveFileId) {
    await drivePatchContent(token, app.driveFileId, body);
    return;
  }
  const files = await driveListFile(token);
  if (files.length) {
    app.driveFileId = files[0].id;
    await drivePatchContent(token, app.driveFileId, body);
    await saveLocal();
    return;
  }
  const c = await driveCreateFile(token, body);
  app.driveFileId = c.id;
  await saveLocal();
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
    bookmarks: app.bookmarks,
    settings: app.settings,
  });
}

async function pullServerMerge() {
  if (typeof VisualBookmarksApi === 'undefined') return;
  const remote = await VisualBookmarksApi.pullSyncState();
  if (remote == null) {
    if (app.bookmarks.length || app.updatedAt) await pushServerState();
    return;
  }
  const ru = typeof remote.updatedAt === 'number' ? remote.updatedAt : 0;
  if (ru > app.updatedAt) {
    if (remote.bookmarks) app.bookmarks = remote.bookmarks.map(normalizeBookmark).filter(Boolean);
    if (remote.settings) app.settings = mergeSettings({ ...DEFAULT_SETTINGS }, remote.settings);
    app.updatedAt = ru;
    if (await enrichFaviconBackgrounds()) touchUpdated();
    await saveLocal();
    renderAll();
  } else if (app.updatedAt > ru) {
    await pushServerState();
  }
}

async function pullRemoteMerge() {
  try {
    if (typeof VisualBookmarksApi !== 'undefined' && (await VisualBookmarksApi.hasToken())) {
      await pullServerMerge();
      return;
    }
  } catch (e) {
    console.warn('Server sync:', e);
  }
  try {
    const t = await getToken(false);
    await pullDriveMerge(t);
  } catch (_) {}
}

const debouncedPush = debounce(async () => {
  try {
    if (typeof VisualBookmarksApi !== 'undefined' && (await VisualBookmarksApi.hasToken())) {
      await pushServerState();
      return;
    }
  } catch (_) {}
  try {
    const t = await getToken(false);
    await pushDrive(t);
  } catch (_) {}
}, SYNC_DEBOUNCE_MS);

function debounce(fn, ms) {
  let t;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

async function pullDriveMerge(token) {
  const files = await driveListFile(token);
  if (!files.length) {
    if (app.bookmarks.length) await pushDrive(token);
    return;
  }
  app.driveFileId = files[0].id;
  const text = await driveDownload(token, app.driveFileId);
  const remote = JSON.parse(text);
  const ru = remote.updatedAt || 0;
  if (ru > app.updatedAt) {
    if (remote.bookmarks) app.bookmarks = remote.bookmarks.map(normalizeBookmark).filter(Boolean);
    if (remote.settings) app.settings = mergeSettings({ ...DEFAULT_SETTINGS }, remote.settings);
    app.updatedAt = ru;
    if (await enrichFaviconBackgrounds()) touchUpdated();
    await saveLocal();
    renderAll();
  } else if (app.updatedAt > ru) await pushDrive(token);
}

async function persist() {
  touchUpdated();
  await saveLocal();
  renderAll();
  renderSettingsIfOpen();
  debouncedPush();
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
  const idx = Math.floor(Date.now() / 86400000) % PRESET_BACKGROUNDS.length;
  app.settings.background = { type: 'preset', value: PRESET_BACKGROUNDS[idx].value };
  app.settings._lastBgDay = day;
}

function applyBackground() {
  const el = $('pageBg');
  if (app.settings.changeBgDaily) pickDailyPreset();
  const bg = app.settings.background || DEFAULT_SETTINGS.background;
  el.style.backgroundImage = '';
  el.style.backgroundColor = '';
  el.style.background = '';
  if (bg.type === 'color') {
    if (String(bg.value).startsWith('linear')) el.style.background = bg.value;
    else el.style.backgroundColor = bg.value;
  } else if (bg.type === 'image' || bg.type === 'preset') {
    el.style.backgroundImage = 'url("' + bg.value.replace(/"/g, '\\"') + '")';
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
  } else {
    el.style.backgroundColor = '#0a0a0a';
  }
}

/* --- Stability UI --- */
function formatNum(n, d = 2) {
  return Number(n).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
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
    '<div><span class="text-muted">Пакет: </span><span style="color:#fbbf24">' +
    MOCK_STABILITY.packageType +
    '</span></div>' +
    '<div><span class="text-muted">Ранг: </span><span style="color:#c084fc">' +
    MOCK_STABILITY.rank +
    '</span></div>' +
    '<div><span class="text-muted">STAB: </span>' +
    formatNum(MOCK_STABILITY.stab) +
    '</div>' +
    '<div><span class="text-muted">Total: </span><span style="color:#4ade80">$' +
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
    '<div class="stability-dropdown__head"><span>Уведомления</span>' +
    (notifications.some((n) => !n.read) ? '<button type="button" id="stabReadAll" style="background:none;border:none;color:#60a5fa;cursor:pointer;font-size:0.75rem">Прочитать все</button>' : '') +
    '</div>';
  if (!notifications.length) html += '<div style="padding:1rem;text-align:center;color:rgba(255,255,255,0.5);font-size:0.875rem">Нет уведомлений</div>';
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
  $('searchInput').placeholder = eng.placeholder;
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
    .slice(0, app.settings.maxBookmarks)
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

function renderContextSuggestions() {
  const el = $('contextSuggestions');
  if (!app.settings.showContextSuggestions) {
    el.classList.add('is-hidden');
    return;
  }
  el.classList.remove('is-hidden');
  el.textContent = 'Контекстные предложения: откройте настройки, чтобы скрыть эту строку.';
}

function renderInfoPanel() {
  const el = $('infoPanel');
  if (!app.settings.showInfoPanel) {
    el.classList.add('is-hidden');
    return;
  }
  el.classList.remove('is-hidden');
  el.textContent = 'Информационная панель. Данные можно подключить к API позже.';
}

/* --- Grid --- */
function renderGrid() {
  const grid = $('bookmarksGrid');
  const cols = Math.min(6, Math.max(2, app.settings.gridColumns || 5));
  grid.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';

  const list = sortedBookmarks().slice(0, app.settings.maxBookmarks);
  const atMax = app.bookmarks.length >= app.settings.maxBookmarks;
  let html = '';

  list.forEach((b, index) => {
    const tileBg = resolveTileBackground(b);
    const tc = contrastColor(tileBg);
    const bg = tileBg.startsWith('linear') ? 'background:' + tileBg : 'background-color:' + tileBg;
    const view = app.settings.bookmarkView || 'icons';
    const imgSrc =
      view === 'screenshots'
        ? screenshotThumb(b.url)
        : b.faviconDataUrl && String(b.faviconDataUrl).startsWith('data:')
          ? b.faviconDataUrl
          : fallbackIconUrl();
    const imgClass = view === 'screenshots' ? 'bm-card__img bm-card__img--shot' : 'bm-card__img bm-card__img--icon';
    const menuOpen = openCardMenuId === b.id;
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
      '<button type="button" class="bm-card__menu-btn' +
      (menuOpen ? ' is-open' : '') +
      '" data-menu-bm="' +
      escapeAttr(b.id) +
      '" aria-label="Меню"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="6" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="18" r="1.5"/></svg></button>';
    if (menuOpen) {
      html +=
        '<div class="bm-card__dropdown" data-stop-prop="1">' +
        '<button type="button" data-action="edit" data-id="' +
        escapeAttr(b.id) +
        '">✎ Редактировать</button>' +
        '<button type="button" data-action="open" data-url="' +
        escapeAttr(b.url) +
        '" data-id="' +
        escapeAttr(b.id) +
        '">↗ Открыть</button>' +
        '<button type="button" class="is-danger" data-action="del" data-id="' +
        escapeAttr(b.id) +
        '">🗑 Удалить</button></div>';
    }
    if ((b.clickCount || 0) > 0) html += '<div class="bm-card__clicks" style="color:' + tc + '">' + b.clickCount + '</div>';
    html += '<div class="bm-card__body" data-open-url="' + escapeAttr(b.url) + '" data-bm-id="' + escapeAttr(b.id) + '">';
    html +=
      '<img class="' +
      imgClass +
      '" src="' +
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
    '><span class="bm-add__circle"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg></span><span class="bm-add__text">Добавить закладку</span></button>';

  grid.innerHTML = html;

  wireGridImageFallbacks(grid);

  grid.querySelector('#gridAddBm')?.addEventListener('click', () => openBookmarkModal(null));

  grid.querySelectorAll('.bm-card-wrap').forEach((wrap) => {
    const idx = +wrap.getAttribute('data-grid-index');
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

  grid.querySelectorAll('.bm-card__menu-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-menu-bm');
      openCardMenuId = openCardMenuId === id ? null : id;
      renderGrid();
    });
  });

  grid.querySelectorAll('[data-action="edit"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      const bm = app.bookmarks.find((x) => x.id === id);
      openCardMenuId = null;
      if (bm) openBookmarkModal(bm);
    });
  });
  grid.querySelectorAll('[data-action="open"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      const url = btn.getAttribute('data-url');
      openCardMenuId = null;
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
  grid.querySelectorAll('[data-action="del"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deletingBookmarkId = btn.getAttribute('data-id');
      openCardMenuId = null;
      showModal('modalDelete');
    });
  });

  grid.querySelectorAll('.bm-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      const el = e.target instanceof Element ? e.target : null;
      if (!el || el.closest('.bm-card__menu-btn') || el.closest('.bm-card__dropdown')) return;
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
  persist();
}

function openBookmarkModal(bm) {
  editingBookmarkId = bm ? bm.id : null;
  bmAutoColor = false;
  bmColorUserTouched = false;
  $('bookmarkModalTitle').textContent = bm ? 'Редактировать закладку' : 'Добавить закладку';
  $('bmSubmit').textContent = bm ? 'Сохранить' : 'Добавить';
  $('bmTitle').value = bm?.title || '';
  $('bmUrl').value = bm?.url || '';
  $('bmDesc').value = bm?.description || '';
  const rawCol = bm?.backgroundColor;
  let col = '#3b82f6';
  if (rawCol === FAVICON_BG) {
    bmAutoColor = true;
    $('bmAutoColor').classList.add('is-active');
    $('bmAutoHint').classList.remove('is-hidden');
    void (async () => {
      try {
        let u = bm.url;
        if (!/^https?:/i.test(u)) u = 'https://' + u;
        const sampled = await extractColorFromFaviconData(u, bm.faviconDataUrl);
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
  showModal('modalBookmark');
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
  const title = $('bmTitle').value || 'Название';
  const url = $('bmUrl').value;
  const tc = contrastColor(bg);
  let pageBase = '';
  let previewIconSrc = fallbackIconUrl();
  try {
    let u = url.trim();
    if (u && !/^https?:/i.test(u)) u = 'https://' + u;
    if (u) pageBase = u;
    if (pageBase && editingBookmarkId) {
      const eb = app.bookmarks.find((x) => x.id === editingBookmarkId);
      const norm = normalizeUrl(url.trim());
      if (eb && eb.url === norm && eb.faviconDataUrl) previewIconSrc = eb.faviconDataUrl;
    }
  } catch (_) {}
  $('bmPreview').style.backgroundColor = bg;
  $('bmPreview').innerHTML =
    (pageBase
      ? '<img src="' +
        escapeAttr(previewIconSrc) +
        '" width="32" height="32" alt="" referrerpolicy="no-referrer" class="bm-preview-favicon"/>'
      : '') + '<span style="font-size:0.75rem;font-weight:500;color:' + tc + '">' + escapeHtml(title) + '</span>';
  const prevImg = $('bmPreview').querySelector('img.bm-preview-favicon');
  if (prevImg) wireTileImageFallback(prevImg);
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
        if (fd) b.faviconDataUrl = fd;
        else delete b.faviconDataUrl;
        b.backgroundColor = await extractColorFromFaviconData(b.url, fd);
      } catch {
        b.backgroundColor = '#3b82f6';
      }
    })
  );
  return true;
}

/* --- Settings panels --- */
const BACKGROUNDS_PER_PAGE = 5;

function renderSettingsPanels() {
  const totalPages = Math.ceil(PRESET_BACKGROUNDS.length / BACKGROUNDS_PER_PAGE);
  const slice = PRESET_BACKGROUNDS.slice(bgPage * BACKGROUNDS_PER_PAGE, (bgPage + 1) * BACKGROUNDS_PER_PAGE);
  const s = app.settings;

  $('settingsPanelAppearance').innerHTML =
    '<section class="mb-6">' +
    '<h2 class="settings-section-title">Тема оформления</h2>' +
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
          (t === 'auto' ? 'Авто' : t === 'light' ? 'Светлая' : 'Тёмная') +
          '</span></button>'
      )
      .join('') +
    '</div></section>' +
    '<section class="mb-6">' +
    '<h2 class="settings-section-title">Фон</h2>' +
    '<div style="display:flex;justify-content:flex-end;margin-bottom:0.5rem">' +
    '<button type="button" class="backup-btn" id="btnUploadBg">Загрузить свой фон</button></div>' +
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
          (s.background?.value === bg.value ? ' is-selected' : '') +
          '" data-bg-preset="' +
          escapeAttr(bg.value) +
          '"><img src="' +
          escapeAttr(bg.value) +
          '" alt=""/>' +
          (s.background?.value === bg.value ? '<span class="check">✓</span>' : '') +
          '</button>'
      )
      .join('') +
    '</div></div>' +
    '<label class="settings-check" style="margin-top:0.75rem"><input type="checkbox" id="chkDailyBg"' +
    (s.changeBgDaily ? ' checked' : '') +
    '/><span>Менять фон каждый день</span></label>' +
    '</section>' +
    '<section class="mb-6">' +
    '<h2 class="settings-section-title">Дополнительные параметры</h2>' +
    '<label class="settings-check"><input type="checkbox" id="chkBar"' +
    (s.showBookmarksBar ? ' checked' : '') +
    '/><span>Панель закладок</span></label>' +
    '<label class="settings-check"><input type="checkbox" id="chkSearch"' +
    (s.showSearch !== false ? ' checked' : '') +
    '/><span>Поисковая строка</span></label>' +
    '<label class="settings-check"><input type="checkbox" id="chkCtx"' +
    (s.showContextSuggestions !== false ? ' checked' : '') +
    '/><span>Контекстные предложения</span></label>' +
    '<label class="settings-check"><input type="checkbox" id="chkInfo"' +
    (s.showInfoPanel ? ' checked' : '') +
    '/><span>Показывать информационную панель</span></label>' +
    '<label class="settings-check"><input type="checkbox" id="chkStab"' +
    (s.showStabilityInfo ? ' checked' : '') +
    '/><span>Отображать настройки Stability</span></label>' +
    '<label class="settings-check"><input type="checkbox" id="chkNewTab"' +
    (s.openLinksInNewTab ? ' checked' : '') +
    '/><span>Открывать ссылки в новой вкладке</span></label>' +
    '</section>' +
    (s.showSearch !== false
      ? '<section class="mb-6"><h2 class="settings-section-title">Поисковая система</h2><div class="engine-grid">' +
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
    '<section class="mb-6"><h2 class="settings-section-title">Колонки сетки</h2>' +
    '<div class="settings-row"><input type="range" class="settings-range" min="2" max="6" id="rangeCols" value="' +
    (s.gridColumns || 5) +
    '"/><span style="width:2rem;text-align:center;font-size:0.875rem">' +
    (s.gridColumns || 5) +
    '</span></div></section>';

  $('settingsPanelBookmarks').innerHTML =
    '<section class="mb-6">' +
    '<h2 class="settings-section-title">Закладки</h2>' +
    '<div class="settings-row"><label class="settings-label-inline">Количество</label>' +
    '<input type="range" class="settings-range" min="6" max="30" id="rangeMaxBm" value="' +
    (s.maxBookmarks ?? 18) +
    '"/><span style="width:2rem;text-align:center;font-size:0.875rem" id="maxBmLabel">' +
    (s.maxBookmarks ?? 18) +
    '</span></div>' +
    '<div class="settings-row" style="margin-top:0.75rem"><label class="settings-label-inline">Вид</label>' +
    '<select class="settings-select" id="selView">' +
    '<option value="icons"' +
    (s.bookmarkView === 'icons' ? ' selected' : '') +
    '>Иконки сайтов</option>' +
    '<option value="screenshots"' +
    (s.bookmarkView === 'screenshots' ? ' selected' : '') +
    '>Скриншоты сайтов</option></select></div>' +
    '<div style="margin-top:1rem;display:flex;gap:0.5rem">' +
    '<button type="button" class="backup-btn" id="setAddBm">Добавить закладку</button></div>' +
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
          '">Изм.</button>' +
          '<button type="button" class="icon-btn icon-btn--danger" data-set-del="' +
          escapeAttr(b.id) +
          '">Удал.</button></div></div>'
      )
      .join('') +
    '</div></section>';

  $('settingsPanelSystem').innerHTML =
    '<section class="mb-6"><h2 class="settings-section-title">Ваш сервер</h2>' +
    '<p style="font-size:0.8rem;color:#6b7280;margin:0 0 0.75rem">URL API для входа, регистрации и синхронизации. Контракт — файл SERVER_API.md в папке расширения.</p>' +
    '<div class="settings-row" style="flex-direction:column;align-items:stretch;gap:0.5rem">' +
    '<input type="url" class="settings-select" style="max-width:100%;box-sizing:border-box" id="inputServerApiUrl" placeholder="https://api.example.com"/>' +
    '<div style="display:flex;flex-wrap:wrap;gap:0.5rem">' +
    '<button type="button" class="backup-btn" id="btnSaveServerUrl">Сохранить URL</button>' +
    '<button type="button" class="backup-btn" id="btnServerLogout">Выйти с сервера</button></div>' +
    '<p id="serverApiStatus" style="font-size:0.75rem;color:#6b7280;margin:0"></p></div></section>' +
    '<section class="mb-6"><h2 class="settings-section-title">Google Drive</h2>' +
    '<p style="font-size:0.8rem;color:#6b7280;margin:0 0 0.75rem">Синхронизация, если не используете сервер (при активной сессии сервера Drive не вызывается).</p>' +
    '<div style="display:flex;flex-wrap:wrap;gap:0.5rem">' +
    '<button type="button" class="backup-btn" id="btnDriveLogin">Войти и синхронизировать</button>' +
    '<button type="button" class="backup-btn" id="btnDriveLogout">Выйти из Google</button></div>' +
    '<p id="driveStatus" style="font-size:0.75rem;color:#6b7280;margin-top:0.5rem"></p></section>' +
    '<section class="mb-6"><h2 class="settings-section-title">Резервное копирование</h2>' +
    '<div class="backup-btns">' +
    '<button type="button" class="backup-btn" id="backupSave">Сохранить в файл</button>' +
    '<button type="button" class="backup-btn" id="backupLoad">Загрузить из файла</button>' +
    '<button type="button" class="backup-btn" id="backupReset" style="border-color:#fecaca;color:#b91c1c">Сбросить</button></div></section>' +
    '<footer class="settings-footer"><p>Visual Bookmarks StabilityInternational 2.2.0</p></footer>';

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
    b.addEventListener('click', () => {
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
  ['chkBar', 'chkSearch', 'chkCtx', 'chkInfo', 'chkStab', 'chkNewTab'].forEach((id, i) => {
    const keys = ['showBookmarksBar', 'showSearch', 'showContextSuggestions', 'showInfoPanel', 'showStabilityInfo', 'openLinksInNewTab'];
    $(id).addEventListener('change', () => {
      app.settings[keys[i]] = $(id).checked;
      persist();
      renderSettingsIfOpen();
      if (keys[i] === 'openLinksInNewTab') {
        renderBookmarksBar();
      }
    });
  });
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
}

function wireSettingsBookmarks() {
  $('rangeMaxBm').addEventListener('input', () => {
    app.settings.maxBookmarks = +$('rangeMaxBm').value;
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
      deletingBookmarkId = b.getAttribute('data-set-del');
      hideModal('modalSettings');
      showModal('modalDelete');
    });
  });
}

function wireSettingsSystem() {
  (async () => {
    if (typeof VisualBookmarksApi !== 'undefined') {
      try {
        $('inputServerApiUrl').value = await VisualBookmarksApi.getServerUrl();
      } catch (_) {}
    }
  })();

  $('btnSaveServerUrl').addEventListener('click', async () => {
    const st = $('serverApiStatus');
    if (typeof VisualBookmarksApi === 'undefined') {
      st.textContent = 'Клиент API не загружен';
      return;
    }
    try {
      const v = $('inputServerApiUrl').value.trim();
      await VisualBookmarksApi.setServerUrl(v);
      if (v) {
        const ok = await VisualBookmarksApi.requestHostPermissionForBase(v);
        st.textContent = ok ? 'URL сохранён, доступ к домену разрешён' : 'URL сохранён — разрешите доступ при запросе Chrome';
      } else {
        st.textContent = 'URL очищен';
      }
    } catch (e) {
      st.textContent = e.message || String(e);
    }
  });

  $('btnServerLogout').addEventListener('click', async () => {
    const st = $('serverApiStatus');
    if (typeof VisualBookmarksApi !== 'undefined') await VisualBookmarksApi.logout();
    app.user = null;
    await saveLocal();
    st.textContent = 'Сессия сервера сброшена';
    renderAll();
    renderHeader();
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
    if (!confirm('Сбросить все закладки и настройки?')) return;
    resetDefaults();
    if (await enrichFaviconBackgrounds()) touchUpdated();
    await persist();
    hideModal('modalSettings');
  });
  const status = $('driveStatus');
  getToken(false)
    .then(() => {
      status.textContent = 'Google: активна сессия';
    })
    .catch(() => {
      status.textContent = '';
    });
  $('btnDriveLogin').addEventListener('click', async () => {
    const cid = getExtensionManifest().oauth2?.client_id ?? '';
    if (cid.includes('REPLACE_WITH_YOUR')) {
      status.textContent = 'Укажите oauth2.client_id в manifest.json (см. README)';
      return;
    }
    try {
      const t = await getToken(true);
      await pullDriveMerge(t);
      status.textContent = 'Синхронизация выполнена';
      renderAll();
    } catch (e) {
      status.textContent = e.message || String(e);
    }
  });
  $('btnDriveLogout').addEventListener('click', () => {
    if (chrome?.identity?.clearAllCachedAuthTokens) {
      chrome.identity.clearAllCachedAuthTokens(() => {
        status.textContent = 'Вы вышли из Google';
      });
    } else {
      status.textContent = 'Доступно только в расширении';
    }
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
  renderContextSuggestions();
  renderInfoPanel();
  renderGrid();
}

/* --- Browser chrome modals --- */
async function openBrowserModal(kind) {
  const title = $('browserModalTitle');
  const body = $('browserModalBody');
  body.innerHTML = '<div style="padding:1rem;color:#a1a1aa">Загрузка…</div>';
  showModal('modalBrowser');

  if (!isExtensionContext()) {
    body.innerHTML =
      '<div class="browser-item">Эти списки работают только когда новая вкладка открыта как страница расширения. Загрузите папку через chrome://extensions → «Загрузить распакованное».</div>';
    return;
  }

  try {
    const linkRel = app.settings.openLinksInNewTab ? ' target="_blank" rel="noopener noreferrer"' : ' rel="noopener noreferrer"';
    if (kind === 'sessions') {
      title.textContent = 'Закрытые вкладки';
      if (!chrome.sessions || !chrome.sessions.getRecentlyClosed) {
        body.innerHTML = '<div class="browser-item">API sessions недоступен</div>';
        return;
      }
      const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
      if (!sessions.length) body.innerHTML = '<div class="browser-item">Нет недавно закрытых</div>';
      else {
        body.innerHTML = sessions
          .map((s) => {
            if (s.tab) {
              return (
                '<button type="button" class="browser-item" data-restore-session="' +
                escapeAttr(s.tab.sessionId) +
                '"><span>' +
                escapeHtml(s.tab.title || s.tab.url || 'Вкладка') +
                '</span><span class="browser-item__sub">' +
                escapeHtml(s.tab.url || '') +
                '</span></button>'
              );
            }
            if (s.window && s.window.tabs?.length) {
              return (
                '<button type="button" class="browser-item" data-restore-window="' +
                escapeAttr(s.window.sessionId) +
                '"><span>Окно (' +
                s.window.tabs.length +
                ' вкладок)</span></button>'
              );
            }
            return '';
          })
          .join('');
      }
    } else if (kind === 'downloads') {
      title.textContent = 'Загрузки';
      if (!chrome.downloads || !chrome.downloads.search) {
        body.innerHTML = '<div class="browser-item">API downloads недоступен</div>';
        return;
      }
      const items = await chrome.downloads.search({ limit: 30, orderBy: ['-startTime'] });
      if (!items.length) body.innerHTML = '<div class="browser-item">Нет загрузок</div>';
      else {
        body.innerHTML = items
          .map(
            (d) =>
              '<button type="button" class="browser-item" data-open-download="' +
              escapeAttr(d.id) +
              '"><span>' +
              escapeHtml(d.filename?.split(/[/\\]/).pop() || d.url || 'Файл') +
              '</span><span class="browser-item__sub">' +
              escapeHtml(d.state || '') +
              '</span></button>'
          )
          .join('');
      }
    } else if (kind === 'bookmarks') {
      title.textContent = 'Закладки браузера';
      if (!chrome.bookmarks || !chrome.bookmarks.getTree) {
        body.innerHTML = '<div class="browser-item">API bookmarks недоступен</div>';
        return;
      }
      const tree = await chrome.bookmarks.getTree();
      const links = [];
      function walk(nodes) {
        nodes.forEach((n) => {
          if (n.url) links.push({ title: n.title, url: n.url });
          if (n.children) walk(n.children);
        });
      }
      walk(tree);
      const slice = links.slice(0, 80);
      if (!slice.length) body.innerHTML = '<div class="browser-item">Пусто</div>';
      else
        body.innerHTML = slice
          .map(
            (l) =>
              '<a class="browser-item" href="' +
              escapeAttr(l.url) +
              '"' +
              linkRel +
              '><span>' +
              escapeHtml(l.title || l.url) +
              '</span><span class="browser-item__sub">' +
              escapeHtml(l.url) +
              '</span></a>'
          )
          .join('');
    } else if (kind === 'history') {
      title.textContent = 'История';
      if (!chrome.history || !chrome.history.search) {
        body.innerHTML = '<div class="browser-item">API history недоступен</div>';
        return;
      }
      const h = await chrome.history.search({ text: '', maxResults: 50 });
      if (!h.length) body.innerHTML = '<div class="browser-item">Пусто</div>';
      else
        body.innerHTML = h
          .map(
            (x) =>
              '<a class="browser-item" href="' +
              escapeAttr(x.url) +
              '"' +
              linkRel +
              '><span>' +
              escapeHtml(x.title || x.url) +
              '</span><span class="browser-item__sub">' +
              escapeHtml(x.url || '') +
              '</span></a>'
          )
          .join('');
    }
  } catch (e) {
    body.innerHTML = '<div class="browser-item">' + escapeHtml(e.message || String(e)) + '</div>';
  }

  body.querySelectorAll('[data-restore-session]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sid = btn.getAttribute('data-restore-session');
      if (chrome?.sessions?.restore) chrome.sessions.restore(sid);
      hideModal('modalBrowser');
    });
  });
  body.querySelectorAll('[data-restore-window]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sid = btn.getAttribute('data-restore-window');
      if (chrome?.sessions?.restore) chrome.sessions.restore(sid);
      hideModal('modalBrowser');
    });
  });
  body.querySelectorAll('[data-open-download]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = +btn.getAttribute('data-open-download');
      if (chrome?.downloads?.open) chrome.downloads.open(id);
      hideModal('modalBrowser');
    });
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

async function init() {
  await loadState();
  if (typeof VisualBookmarksApi !== 'undefined' && (await VisualBookmarksApi.hasToken())) {
    const su = await VisualBookmarksApi.getStoredUser();
    if (su) app.user = normalizeServerUser(su);
  }

  $('loader').classList.add('is-hidden');

  if (await enrichFaviconBackgrounds()) {
    touchUpdated();
    await saveLocal();
  }

  document.addEventListener('click', onGlobalClick);

  $('btnLogin').addEventListener('click', () => {
    authMode = 'login';
    document.querySelectorAll('.auth-tab').forEach((x) => x.classList.toggle('is-active', x.getAttribute('data-auth-mode') === 'login'));
    $('authTitle').textContent = 'Вход';
    $('authSubmit').textContent = 'Войти';
    $('authNameRow').classList.add('is-hidden');
    showModal('modalAuth');
  });

  $('btnProfileMenu').addEventListener('click', (e) => {
    e.stopPropagation();
    profileMenuOpen = !profileMenuOpen;
    renderHeader();
  });

  $('btnLogout').addEventListener('click', async () => {
    if (typeof VisualBookmarksApi !== 'undefined' && (await VisualBookmarksApi.hasToken())) {
      await VisualBookmarksApi.logout();
    }
    app.user = null;
    profileMenuOpen = false;
    persist();
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
    b.addEventListener('click', () => openBrowserModal(b.getAttribute('data-browser-action')));
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
      $('authTitle').textContent = authMode === 'login' ? 'Вход' : 'Регистрация';
      $('authSubmit').textContent = authMode === 'login' ? 'Войти' : 'Зарегистрироваться';
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
      const base = await VisualBookmarksApi.getServerUrl();
      if (base) {
        try {
          if (authMode === 'login') await VisualBookmarksApi.login(email, pwd);
          else await VisualBookmarksApi.register({ email, password: pwd, name });
          const su = await VisualBookmarksApi.getStoredUser();
          app.user = normalizeServerUser(su);
          hideModal('modalAuth');
          await pullServerMerge();
          await saveLocal();
          renderAll();
          renderHeader();
        } catch (err) {
          alert(err.message || String(err));
        }
        return;
      }
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
    const title = $('bmTitle').value.trim();
    const url = normalizeUrl($('bmUrl').value);
    const desc = $('bmDesc').value.trim();
    if (!title || !url) return;
    const bExisting = editingBookmarkId ? app.bookmarks.find((x) => x.id === editingBookmarkId) : null;
    const urlUnchanged = !!(bExisting && bExisting.url === url);

    let favData;
    if (urlUnchanged && bExisting) {
      favData = bExisting.faviconDataUrl;
    } else {
      const fr = await getFaviconViaBackground(url);
      favData = fr.ok && fr.dataUrl ? clampFaviconDataUrl(fr.dataUrl) : undefined;
    }

    let bg = $('bmColorPicker').value;
    const fromFavicon = bmAutoColor || (!editingBookmarkId && !bmColorUserTouched);
    if (fromFavicon) {
      try {
        bg = await extractColorFromFaviconData(url, favData);
      } catch {
        bg = '#3b82f6';
      }
    }

    if (editingBookmarkId) {
      const b = app.bookmarks.find((x) => x.id === editingBookmarkId);
      if (b) {
        b.title = title;
        b.url = url;
        b.description = desc;
        b.backgroundColor = bg;
        if (favData) b.faviconDataUrl = favData;
        else delete b.faviconDataUrl;
      }
    } else {
      if (app.bookmarks.length >= app.settings.maxBookmarks) return;
      const maxO = Math.max(0, ...app.bookmarks.map((x) => x.order || 0));
      const row = { id: generateId(), title, url, description: desc, backgroundColor: bg, order: maxO + 1, clickCount: 0 };
      if (favData) row.faviconDataUrl = favData;
      app.bookmarks.push(row);
    }
    hideModal('modalBookmark');
    persist();
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
  $('bmUrl').addEventListener('input', updateBmPreview);

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
    const eb = editingBookmarkId ? app.bookmarks.find((x) => x.id === editingBookmarkId) : null;
    const nu = normalizeUrl(url);
    const cached = eb && eb.url === nu ? eb.faviconDataUrl : undefined;
    const col = await extractColorFromFaviconData(u, cached);
    $('bmColorPicker').value = col;
    renderColorPresets(col);
    updateBmPreview();
    $('bmAutoSpinner').classList.add('is-hidden');
    $('bmAutoLabel').classList.remove('is-hidden');
  });

  $('btnDeleteCancel').addEventListener('click', () => {
    deletingBookmarkId = null;
    hideModal('modalDelete');
  });
  $('btnDeleteConfirm').addEventListener('click', () => {
    if (deletingBookmarkId) {
      app.bookmarks = app.bookmarks.filter((b) => b.id !== deletingBookmarkId);
      deletingBookmarkId = null;
      hideModal('modalDelete');
      persist();
    }
  });

  $('hiddenBgFile').addEventListener('change', () => {
    const f = $('hiddenBgFile').files?.[0];
    $('hiddenBgFile').value = '';
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      app.settings.background = { type: 'image', value: r.result };
      persist();
      renderSettingsIfOpen();
    };
    r.readAsDataURL(f);
  });

  $('hiddenImportFile').addEventListener('change', () => {
    const f = $('hiddenImportFile').files?.[0];
    $('hiddenImportFile').value = '';
    if (!f) return;
    f.text().then(async (text) => {
      try {
        importFromJson(text);
        if (await enrichFaviconBackgrounds()) touchUpdated();
        await persist();
        hideModal('modalSettings');
      } catch (err) {
        alert('Ошибка импорта: ' + err.message);
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

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      pullRemoteMerge()
        .catch(() => {})
        .finally(() => renderAll());
    }
  });

  try {
    await pullRemoteMerge();
  } catch (_) {}

  renderAll();
}

init();
