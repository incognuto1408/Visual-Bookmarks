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
