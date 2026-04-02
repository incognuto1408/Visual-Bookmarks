/**
 * Локализация новой вкладки: строки в locales/<код>.json.
 * В память подгружаются только активный язык и ru (как запасной, если активный не ru).
 * Редактирование переводов — файлы locales/ru.json, uk.json, en.json, hy.json.
 */
(function (global) {
  const SUPPORTED = ['ru', 'uk', 'en', 'hy'];
  /** @type {Record<string, Record<string, string>>} */
  const MESSAGES = Object.create(null);

  function flattenCalNested(lang) {
    const o = MESSAGES[lang];
    if (!o || !o.cal) return;
    o['cal.connect'] = o.cal.connect;
    o['cal.extensionOnly'] = o.cal.extensionOnly;
    o['cal.noEvents'] = o.cal.noEvents;
    o['cal.nextTitle'] = o.cal.nextTitle;
    o['cal.nextAria'] = o.cal.nextAria;
    delete o.cal;
  }

  function localeFileUrl(code) {
    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function') {
      return chrome.runtime.getURL('locales/' + code + '.json');
    }
    return 'locales/' + code + '.json';
  }

  /**
   * Подгружает JSON одного языка (с кэшем в MESSAGES на время жизни страницы).
   * @param {string} code
   */
  async function ensureLocaleLoaded(code) {
    if (!SUPPORTED.includes(code)) code = 'ru';
    const existing = MESSAGES[code];
    if (existing && typeof existing === 'object' && Object.keys(existing).length > 0) return;

    const res = await fetch(localeFileUrl(code), { cache: 'force-cache' });
    if (!res.ok) {
      throw new Error('VisualBookmarksI18n: cannot load locales/' + code + '.json (' + res.status + ')');
    }
    const data = await res.json();
    MESSAGES[code] = data;
    flattenCalNested(code);
  }

  /**
   * Оставить в памяти только нужные пакеты; подгрузить недостающие.
   * @param {object} [settings] — для uiLanguage / auto
   */
  async function loadPacks(settings) {
    const target = resolveEffectiveLocale(settings);
    const keep = target === 'ru' ? ['ru'] : [target, 'ru'];
    await Promise.all(keep.map((c) => ensureLocaleLoaded(c)));
    for (let i = 0; i < SUPPORTED.length; i++) {
      const c = SUPPORTED[i];
      if (!keep.includes(c)) delete MESSAGES[c];
    }
  }

  let activeLocale = 'ru';

  function detectBrowserLocale() {
    try {
      if (typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getUILanguage === 'function') {
        return normalizeLocale(chrome.i18n.getUILanguage());
      }
    } catch (_) {}
    return normalizeLocale(typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'ru');
  }

  function normalizeLocale(raw) {
    if (!raw) return 'ru';
    const p = String(raw).toLowerCase().split(/[-_]/)[0];
    if (p === 'uk' || p === 'ua') return 'uk';
    if (p === 'en') return 'en';
    if (p === 'hy' || p === 'am') return 'hy';
    if (p === 'ru') return 'ru';
    return 'ru';
  }

  function resolveEffectiveLocale(settings) {
    const pref = settings && settings.uiLanguage;
    if (pref && pref !== 'auto' && SUPPORTED.includes(pref)) return pref;
    return detectBrowserLocale();
  }

  function syncFromSettings(settings) {
    activeLocale = resolveEffectiveLocale(settings);
    if (typeof document !== 'undefined' && document.documentElement) {
      const map = { ru: 'ru', uk: 'uk', en: 'en', hy: 'hy' };
      document.documentElement.lang = map[activeLocale] || 'ru';
    }
  }

  function t(key) {
    const pack = MESSAGES[activeLocale] || {};
    const base = MESSAGES.ru || {};
    const v = pack[key];
    if (v != null && v !== '') return v;
    const b = base[key];
    if (b != null && b !== '') return b;
    return key;
  }

  function tReplace(key, vars) {
    let s = t(key);
    if (vars && typeof vars === 'object') {
      Object.keys(vars).forEach((k) => {
        s = s.split('{' + k + '}').join(String(vars[k]));
      });
    }
    return s;
  }

  function applyDom(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (!key) return;
      const val = t(key);
      if (el.hasAttribute('data-i18n-placeholder')) {
        if ('placeholder' in el) el.placeholder = val;
      } else if (el.hasAttribute('data-i18n-attr')) {
        el.setAttribute(el.getAttribute('data-i18n-attr'), val);
      } else {
        el.textContent = val;
      }
    });
  }

  global.VisualBookmarksI18n = {
    SUPPORTED,
    detectBrowserLocale,
    resolveEffectiveLocale,
    loadPacks,
    syncFromSettings,
    t,
    tReplace,
    applyDom,
  };
})(typeof self !== 'undefined' ? self : window);
