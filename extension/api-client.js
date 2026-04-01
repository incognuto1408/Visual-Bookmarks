/**
 * Клиент вашего бэкенда: регистрация, вход, синхронизация состояния.
 * Контракт API описан в SERVER_API.md
 */
(function (global) {
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
    const x = await storageGet([K.BASE]);
    return String(x[K.BASE] || '')
      .trim()
      .replace(/\/$/, '');
  }

  async function setServerUrl(url) {
    const u = String(url || '')
      .trim()
      .replace(/\/$/, '');
    await storageSet({ [K.BASE]: u });
    return u;
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

  async function login(email, password) {
    const base = await getServerUrl();
    if (!base) throw new Error('Сначала укажите URL API в Настройки → Система');
    const ok = await requestHostPermissionForBase(base);
    if (!ok) throw new Error('Нет доступа к домену API (разрешите запрос Chrome)');
    const res = await fetch(base + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(await parseErrorResponse(res));
    const data = await res.json();
    const token = data.accessToken || data.token || data.access_token;
    if (!token) throw new Error('Сервер не вернул токен (ожидается accessToken)');
    const user = data.user || { id: data.sub, email, name: data.name || email.split('@')[0] };
    await setSession(token, user);
    return { accessToken: token, user };
  }

  async function register(payload) {
    const base = await getServerUrl();
    if (!base) throw new Error('Сначала укажите URL API в Настройки → Система');
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
    const data = await res.json();
    const token = data.accessToken || data.token || data.access_token;
    if (!token) throw new Error('Сервер не вернул токен после регистрации');
    const user = data.user || { email: payload.email, name: payload.name };
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
    return res.json();
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
