/**
 * Клиент бэкенда Crypt-Chain: регистрация, вход, синхронизация состояния.
 * Контракт API описан в SERVER_API.md
 */
(function (global) {
  const API_BASE = 'https://crypt-chain.com/browser-extension';
  const LOGIN_PAGE_URL = 'https://crypt-chain.com/browser-extension/login';

  const K = {
    TOKEN: 'vb_server_access_token',
    USER: 'vb_server_user_json',
    BASE: 'vb_server_base_url',
  };

  function storageGet(keys) {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(keys, resolve);
        return;
      }
      const out = {};
      keys.forEach((key) => {
        try {
          const raw = localStorage.getItem(key);
          if (raw != null) out[key] = JSON.parse(raw);
        } catch (_) {}
      });
      resolve(out);
    });
  }

  function storageSet(obj) {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set(obj, resolve);
        return;
      }
      Object.keys(obj).forEach((key) => {
        try {
          localStorage.setItem(key, JSON.stringify(obj[key]));
        } catch (_) {}
      });
      resolve();
    });
  }

  function storageRemove(keys) {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.remove(keys, resolve);
        return;
      }
      keys.forEach((k) => localStorage.removeItem(k));
      resolve();
    });
  }

  async function getServerUrl() {
    return API_BASE;
  }

  function getLoginPageUrl() {
    return LOGIN_PAGE_URL;
  }

  /** Ранее сохранённый пользовательский URL больше не используется; очищаем при сохранении настроек. */
  async function setServerUrl() {
    await storageRemove([K.BASE]);
    return API_BASE;
  }

  async function getAccessToken() {
    const x = await storageGet([K.TOKEN]);
    return x[K.TOKEN] || '';
  }

  async function setSession(token, userObj) {
    await storageSet({
      [K.TOKEN]: token || '',
      [K.USER]: userObj || '',
    });
  }

  async function getStoredUser() {
    const x = await storageGet([K.USER]);
    const raw = x[K.USER];
    if (!raw) return null;
    try {
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return null;
    }
  }

  async function hasToken() {
    const t = await getAccessToken();
    return !!t;
  }

  async function requestHostPermissionForBase(baseUrl) {
    if (!baseUrl || typeof chrome === 'undefined' || !chrome.permissions) return true;
    let origin;
    try {
      origin = new URL(baseUrl).origin + '/*';
    } catch {
      return false;
    }
    return new Promise((resolve) => {
      chrome.permissions.contains({ origins: [origin] }, (already) => {
        if (already) {
          resolve(true);
          return;
        }
        chrome.permissions.request({ origins: [origin] }, (granted) => {
          resolve(!!granted);
        });
      });
    });
  }

  async function parseErrorResponse(res) {
    let msg = res.statusText || 'Ошибка ' + res.status;
    try {
      const j = await res.json();
      if (j.status === false && j.data) {
        if (typeof j.data === 'string') msg = j.data;
        else if (j.data && typeof j.data === 'object' && j.data.message) msg = String(j.data.message);
      }
      if (j.message) msg = j.message;
      else if (j.error) msg = typeof j.error === 'string' ? j.error : JSON.stringify(j.error);
    } catch {
      try {
        const t = await res.text();
        if (t) msg = t.slice(0, 200);
      } catch (_) {}
    }
    return msg;
  }

  /**
   * Ответы Laravel в стиле BrowserExtensionController: { status: boolean, data?: object }.
   * При status === false — ошибка; иначе полезная нагрузка в data или в корне.
   */
  function normalizeCryptChainBody(body) {
    if (!body || typeof body !== 'object') return body;
    if (Object.prototype.hasOwnProperty.call(body, 'status')) {
      const ok = body.status === true || body.status === 1 || body.status === 'ok';
      if (!ok) {
        let m = body.message;
        if (m == null && body.data != null) {
          if (typeof body.data === 'string') m = body.data;
          else if (typeof body.data === 'object' && body.data.message != null) m = String(body.data.message);
        }
        throw new Error(m != null && m !== '' ? String(m) : 'Запрос отклонён сервером');
      }
    }
    if (
      Object.prototype.hasOwnProperty.call(body, 'data') &&
      body.data != null &&
      typeof body.data === 'object' &&
      !Array.isArray(body.data)
    ) {
      return body.data;
    }
    return body;
  }

  function extractAuthPayload(payload, emailFallback) {
    const p = normalizeCryptChainBody(payload);
    const token = p.accessToken || p.token || p.access_token;
    let user = p.user;
    if (!user && (p.email || p.id || p.name)) {
      const em = p.email || emailFallback;
      user = {
        id: p.id || p.user_id || em,
        email: em,
        name: p.name || (em ? em.split('@')[0] : ''),
        avatar: p.avatar,
      };
    }
    if (!user && emailFallback) {
      user = { id: emailFallback, email: emailFallback, name: emailFallback.split('@')[0] };
    }
    return { token, user };
  }

  async function login(email, password) {
    const base = await getServerUrl();
    const ok = await requestHostPermissionForBase(base);
    if (!ok) throw new Error('Нет доступа к домену API (разрешите запрос Chrome)');
    const res = await fetch(base + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(await parseErrorResponse(res));
    const raw = await res.json();
    const { token, user } = extractAuthPayload(raw, email);
    if (!token) throw new Error('Сервер не вернул токен (в data ожидается accessToken, token или access_token)');
    await setSession(token, user);
    return { accessToken: token, user };
  }

  async function register(payload) {
    const base = await getServerUrl();
    const ok = await requestHostPermissionForBase(base);
    if (!ok) throw new Error('Нет доступа к домену API (разрешите запрос Chrome)');
    const res = await fetch(base + '/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        email: payload.email,
        password: payload.password,
        name: payload.name || payload.email.split('@')[0],
      }),
    });
    if (!res.ok) throw new Error(await parseErrorResponse(res));
    const raw = await res.json();
    const { token, user } = extractAuthPayload(raw, payload.email);
    if (!token) throw new Error('Сервер не вернул токен (в data ожидается accessToken, token или access_token)');
    await setSession(token, user);
    return { accessToken: token, user };
  }

  async function logout() {
    await storageRemove([K.TOKEN, K.USER]);
  }

  async function pullSyncState() {
    const base = await getServerUrl();
    const token = await getAccessToken();
    if (!base || !token) return null;
    const ok = await requestHostPermissionForBase(base);
    if (!ok) throw new Error('Нет разрешения на доступ к API');
    const res = await fetch(base + '/sync/state', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    });
    if (res.status === 404 || res.status === 204) return null;
    if (res.status === 401) {
      await logout();
      throw new Error('Сессия истекла — войдите снова');
    }
    if (!res.ok) throw new Error(await parseErrorResponse(res));
    const raw = await res.json();
    try {
      return normalizeCryptChainBody(raw);
    } catch (e) {
      if (e instanceof Error && e.message) throw e;
      throw new Error(String(e));
    }
  }

  async function pushSyncState(body) {
    const base = await getServerUrl();
    const token = await getAccessToken();
    if (!base || !token) return;
    const ok = await requestHostPermissionForBase(base);
    if (!ok) return;
    const res = await fetch(base + '/sync/state', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      await logout();
      throw new Error('Сессия истекла — войдите снова');
    }
    if (!res.ok) throw new Error(await parseErrorResponse(res));
  }

  global.VisualBookmarksApi = {
    getServerUrl,
    getLoginPageUrl,
    setServerUrl,
    hasToken,
    getAccessToken,
    getStoredUser,
    login,
    register,
    logout,
    pullSyncState,
    pushSyncState,
    requestHostPermissionForBase,
  };
})(typeof self !== 'undefined' ? self : window);
