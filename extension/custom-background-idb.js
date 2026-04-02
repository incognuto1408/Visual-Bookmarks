/**
 * Пользовательский фон: бинарь в IndexedDB + blob: URL в CSS (MV3).
 * Не используем data URL в chrome.storage и не filesystem:… из устаревших Chrome Apps.
 */
(function (global) {
  const DB_NAME = 'VisualBookmarks_customBg_v1';
  const STORE = 'image';
  const KEY = 'custom';

  function openDb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB недоступен'));
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
    });
  }

  async function saveBlob(blob) {
    if (!blob || typeof blob.arrayBuffer !== 'function') throw new Error('Некорректный blob');
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(STORE).put(blob, KEY);
    });
  }

  async function saveFromDataUrl(dataUrl) {
    const res = await fetch(String(dataUrl));
    const blob = await res.blob();
    await saveBlob(blob);
  }

  async function loadBlob() {
    if (typeof indexedDB === 'undefined') return null;
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const r = tx.objectStore(STORE).get(KEY);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => reject(r.error);
      });
    } catch {
      return null;
    }
  }

  async function clear() {
    if (typeof indexedDB === 'undefined') return;
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.objectStore(STORE).delete(KEY);
      });
    } catch (_) {}
  }

  global.VisualBookmarksCustomBg = {
    saveBlob,
    saveFromDataUrl,
    loadBlob,
    clear,
  };
})(typeof self !== 'undefined' ? self : window);
