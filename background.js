importScripts("lib/capturador-cookie.js");

const {
  DEFAULT_INTERVAL_HOURS,
  TARGET_REQUEST_URL,
  defaultCaptureConfig,
  parseCaptureTarget,
  isTargetUrl,
  isCaptureUrl,
  isAuthOrLoginPath,
  isCompleteCookieHeader,
  shouldSend,
  buildPayload,
} = CapturadorCookie;

const EXTENSION_VERSION = "1.9.2";

const DEBOUNCE_MS = 2000;
const CAPTURE_FRESH_MS = 10 * 60 * 1000;
const NAV_CAPTURE_TIMEOUT_MS = 25000;
const AUTO_SEND_COOLDOWN_MS = 60 * 1000;

let debounceTimer = null;
let sending = false;
let navigatingForCapture = false;
let lastAutoSendAt = 0;

/** @type {{ cookieHeader: string, url: string, method: string, capturedAt: number } | null} */
let lastNetworkCapture = null;
let pendingCookieWaiters = [];
/** @type {ReturnType<typeof defaultCaptureConfig>} */
let liveConfig = defaultCaptureConfig();

async function loadCaptureConfig() {
  const data = await chrome.storage.local.get({
    captureUrl: TARGET_REQUEST_URL,
    domainMode: "subdominio",
    lastNetworkCapture: null,
  });
  const parsed = parseCaptureTarget(data.captureUrl, data.domainMode);
  if (!parsed.ok) {
    liveConfig = defaultCaptureConfig();
  } else {
    liveConfig = {
      captureUrl: parsed.captureUrl,
      domainMode: parsed.domainMode,
      targetHost: parsed.targetHost,
      cookieDomain: parsed.cookieDomain,
      originPattern: parsed.originPattern,
    };
  }
  if (
    data.lastNetworkCapture &&
    data.lastNetworkCapture.cookieHeader &&
    data.lastNetworkCapture.url &&
    !isAuthOrLoginPath(new URL(data.lastNetworkCapture.url).pathname)
  ) {
    lastNetworkCapture = data.lastNetworkCapture;
  }
  return liveConfig;
}

function rememberNetworkCapture(cap) {
  if (!cap || !cap.cookieHeader || !cap.url) return;
  if (isAuthOrLoginPath(new URL(cap.url).pathname)) return;

  lastNetworkCapture = {
    cookieHeader: cap.cookieHeader,
    url: cap.url,
    method: cap.method || "GET",
    capturedAt: Date.now(),
  };
  chrome.storage.local.set({ lastNetworkCapture }).catch(() => {});
  const waiters = pendingCookieWaiters.splice(0, pendingCookieWaiters.length);
  for (const w of waiters) {
    try {
      w(lastNetworkCapture);
    } catch (_) {
      /* ignore */
    }
  }
}

function isFreshNetworkCapture(cap) {
  if (!cap || !cap.cookieHeader || !cap.url) return false;
  if (isAuthOrLoginPath(new URL(cap.url).pathname)) return false;
  if (!isCaptureUrl(cap.url, liveConfig)) return false;
  if (!isCompleteCookieHeader(cap.cookieHeader)) return false;
  const age = Date.now() - (Number(cap.capturedAt) || 0);
  return age <= CAPTURE_FRESH_MS;
}

async function ensureCaptureHostPermission() {
  const origin = liveConfig.originPattern;
  if (!origin) return false;
  try {
    const have = await chrome.permissions.contains({ origins: [origin] });
    if (have) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch (e) {
    console.warn("capturador-cookie permission:", e);
    return false;
  }
}

/** requestId -> cookie sent WITH the request (before Set-Cookie of the response). */
const inflightDoc = new Map();

function cookieHeaderFromJar(cookies) {
  return (cookies || [])
    .filter((c) => c && c.name)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

function onBeforeSendHeaders(details) {
  if (details.method !== "GET") return;
  if (!isCaptureUrl(details.url, liveConfig)) return;
  if (isAuthOrLoginPath(new URL(details.url).pathname)) return;

  const headers = details.requestHeaders || [];
  const cookieHdr = headers.find((h) => h.name.toLowerCase() === "cookie");
  const sent = cookieHdr && cookieHdr.value ? cookieHdr.value : "";
  inflightDoc.set(details.requestId, {
    url: details.url,
    sentCookie: sent,
    gotSetCookie: false,
  });
  // Do not send yet. The response may Set-Cookie a new session.
  // F12 on the next view shows the cookies AFTER that Set-Cookie.
}

function onHeadersReceived(details) {
  const row = inflightDoc.get(details.requestId);
  if (!row) return;
  const headers = details.responseHeaders || [];
  const setCookie = headers.some((h) => h.name && h.name.toLowerCase() === "set-cookie");
  if (setCookie) row.gotSetCookie = true;
}

async function onCompleted(details) {
  const row = inflightDoc.get(details.requestId);
  inflightDoc.delete(details.requestId);
  if (!row) return;
  if (details.method && details.method !== "GET") return;
  if (!isCaptureUrl(details.url, liveConfig)) return;
  if (isAuthOrLoginPath(new URL(details.url).pathname)) return;
  if (navigatingForCapture || pendingCookieWaiters.length > 0) return;

  // Let the browser store Set-Cookie before we read the jar.
  await new Promise((r) => setTimeout(r, row.gotSetCookie ? 700 : 200));

  let header = row.sentCookie;
  if (row.gotSetCookie) {
    try {
      const jar = await chrome.cookies.getAll({ url: details.url });
      const built = cookieHeaderFromJar(jar);
      if (built) header = built;
    } catch (e) {
      console.warn("capturador-cookie jar after Set-Cookie:", e);
    }
  }
  if (!isCompleteCookieHeader(header)) return;

  rememberNetworkCapture({
    cookieHeader: header,
    url: details.url,
    method: "GET",
  });
  scheduleSend("network-capture", false);
}

function bindWebRequest() {
  try {
    if (chrome.webRequest.onBeforeSendHeaders.hasListener(onBeforeSendHeaders)) {
      chrome.webRequest.onBeforeSendHeaders.removeListener(onBeforeSendHeaders);
    }
    if (chrome.webRequest.onHeadersReceived.hasListener(onHeadersReceived)) {
      chrome.webRequest.onHeadersReceived.removeListener(onHeadersReceived);
    }
    if (chrome.webRequest.onCompleted.hasListener(onCompleted)) {
      chrome.webRequest.onCompleted.removeListener(onCompleted);
    }
  } catch (_) {
    /* ignore */
  }
  const pattern = liveConfig && liveConfig.originPattern;
  if (!pattern) return;
  const filter = { urls: [pattern], types: ["main_frame"] };
  try {
    chrome.webRequest.onBeforeSendHeaders.addListener(
      onBeforeSendHeaders,
      filter,
      ["requestHeaders", "extraHeaders"]
    );
    chrome.webRequest.onHeadersReceived.addListener(
      onHeadersReceived,
      filter,
      ["responseHeaders", "extraHeaders"]
    );
    chrome.webRequest.onCompleted.addListener(onCompleted, filter);
  } catch (e) {
    console.warn("capturador-cookie webRequest bind failed:", e);
  }
}

async function refreshConfigAndBindings() {
  await loadCaptureConfig();
  bindWebRequest();
}

async function getSettings() {
  const data = await chrome.storage.local.get({
    webhookUrl: "",
    intervalHours: DEFAULT_INTERVAL_HOURS,
    lastSentAt: 0,
    lastCookieHeader: "",
    captureUrl: TARGET_REQUEST_URL,
    domainMode: "subdominio",
    webhookAuthType: "none",
    webhookBearerToken: "",
    webhookHeaderName: "",
    webhookHeaderValue: "",
  });
  await loadCaptureConfig();
  return { ...data, ...liveConfig };
}

async function readCookiesForCaptureUrl() {
  const url = liveConfig.captureUrl || TARGET_REQUEST_URL;
  const byUrl = await chrome.cookies.getAll({ url });
  let byDomain = [];
  try {
    if (liveConfig.cookieDomain) {
      byDomain = await chrome.cookies.getAll({ domain: liveConfig.cookieDomain });
    }
  } catch (_) {
    byDomain = [];
  }
  const map = new Map();
  for (const c of byDomain) map.set(c.name, c);
  for (const c of byUrl) map.set(c.name, c);
  return Array.from(map.values());
}

async function findTabForCapture() {
  const tabs = await chrome.tabs.query({});
  const preferred = liveConfig.captureUrl || TARGET_REQUEST_URL;
  for (const tab of tabs) {
    if (!tab.id || !tab.url || !isTargetUrl(tab.url, liveConfig)) continue;
    if (isAuthOrLoginPath(new URL(tab.url).pathname)) continue;
    if (isCaptureUrl(tab.url, liveConfig)) return tab;
  }
  for (const tab of tabs) {
    if (!tab.id || !tab.url || !isTargetUrl(tab.url, liveConfig)) continue;
    if (isAuthOrLoginPath(new URL(tab.url).pathname)) continue;
    return tab;
  }
  const exact = tabs.find(
    (t) => t.url && t.url.startsWith(String(preferred).split("?")[0])
  );
  return exact || null;
}

/**
 * Enviar agora only: one navigation to capture URL, wait for real Cookie header.
 */
async function captureCookieHeaderByNavigation() {
  if (isFreshNetworkCapture(lastNetworkCapture)) {
    return lastNetworkCapture;
  }

  const captureUrl = liveConfig.captureUrl || TARGET_REQUEST_URL;
  if (isAuthOrLoginPath(new URL(captureUrl).pathname)) {
    return null;
  }

  navigatingForCapture = true;

  const waitPromise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCookieWaiters = pendingCookieWaiters.filter((w) => w !== wrap);
      resolve(null);
    }, NAV_CAPTURE_TIMEOUT_MS);
    function wrap(cap) {
      clearTimeout(timer);
      resolve(cap);
    }
    pendingCookieWaiters.push(wrap);
  });

  try {
    let tab = await findTabForCapture();
    if (tab && tab.id) {
      await chrome.tabs.update(tab.id, { url: captureUrl, active: true });
    } else {
      await chrome.tabs.create({ url: captureUrl, active: true });
    }
  } catch (e) {
    console.warn("capturador-cookie navigate:", e);
  }

  try {
    const cap = await waitPromise;
    if (isFreshNetworkCapture(cap)) return cap;
    if (isFreshNetworkCapture(lastNetworkCapture)) return lastNetworkCapture;
    return null;
  } finally {
    navigatingForCapture = false;
  }
}

function dumpWebStorageInPage() {
  function dump(store) {
    const out = {};
    try {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k != null) out[k] = store.getItem(k);
      }
    } catch (_) {
      /* ignore */
    }
    return out;
  }
  return {
    localStorage: dump(localStorage),
    sessionStorage: dump(sessionStorage),
    pageUrl: location.href,
  };
}

async function readWebStorageFromTab(preferredUrl) {
  const empty = {
    localStorage: {},
    sessionStorage: {},
    pageUrl: null,
    storageSource: "none",
  };
  try {
    let tab = null;
    if (preferredUrl) {
      const tabs = await chrome.tabs.query({});
      tab = tabs.find((t) => t.id && t.url && t.url.split("#")[0] === preferredUrl.split("#")[0]) || null;
      if (!tab) {
        tab =
          tabs.find(
            (t) =>
              t.id &&
              t.url &&
              isCaptureUrl(t.url, liveConfig) &&
              !isAuthOrLoginPath(new URL(t.url).pathname)
          ) || null;
      }
    }
    if (!tab) tab = await findTabForCapture();
    if (!tab || !tab.id) return empty;
    if (tab.url && isAuthOrLoginPath(new URL(tab.url).pathname)) {
      return { ...empty, storageSource: "skipped-login-page", pageUrl: tab.url };
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: dumpWebStorageInPage,
    });
    const result = results && results[0] && results[0].result;
    if (!result) return empty;
    return {
      localStorage: result.localStorage || {},
      sessionStorage: result.sessionStorage || {},
      pageUrl: result.pageUrl || tab.url || null,
      storageSource: "tab",
    };
  } catch (e) {
    console.warn("capturador-cookie webStorage:", e);
    return {
      localStorage: {},
      sessionStorage: {},
      pageUrl: null,
      storageSource: "error",
      storageError: String(e && e.message ? e.message : e),
    };
  }
}

async function postWebhook(webhookUrl, payload, settings) {
  const auth = CapturadorCookie.buildWebhookAuthHeaders(
    settings.webhookAuthType,
    settings.webhookBearerToken,
    settings.webhookHeaderName,
    settings.webhookHeaderValue
  );
  if (!auth.ok) {
    const err = new Error(auth.error);
    err.authConfig = true;
    throw err;
  }
  return fetch(webhookUrl, {
    method: "POST",
    headers: auth.headers,
    body: JSON.stringify(payload),
  });
}

async function sendCookies({ tabUrl, force, reason, networkCapture }) {
  if (sending) {
    return { ok: false, error: "Envio em andamento", busy: true };
  }
  sending = true;
  try {
    const settings = await getSettings();
    const webhookUrl = (settings.webhookUrl || "").trim();
    if (!webhookUrl) return { ok: false, error: "Webhook não configurado" };
    if (!(settings.captureUrl || "").trim()) {
      return { ok: false, error: "URL de captura não configurada" };
    }

    const captureConfigured = liveConfig.captureUrl || settings.captureUrl;
    if (isAuthOrLoginPath(new URL(captureConfigured).pathname)) {
      return {
        ok: false,
        error:
          "URL de captura não pode ser /login. Use a página logada (ex.: /orcamentos).",
      };
    }

    const now = Date.now();
    const isManual = reason === "send-now";
    // Re-login: Cookie line changed. Do not wait 12h. Do not reload the page.
    const isSessionRefresh = reason === "network-capture" || reason === "tab-capture";

    if (!isManual && now - lastAutoSendAt < AUTO_SEND_COOLDOWN_MS) {
      return { ok: false, error: "Auto-send cooldown", throttled: true };
    }
    if (
      !isManual &&
      !isSessionRefresh &&
      !shouldSend(now, settings.lastSentAt, settings.intervalHours)
    ) {
      return { ok: false, error: "Throttle ativo", throttled: true };
    }

    let capture = networkCapture || null;
    if (capture && (!capture.url || isAuthOrLoginPath(new URL(capture.url).pathname))) {
      capture = null;
    }

    if (isManual) {
      const permitted = await ensureCaptureHostPermission();
      if (!permitted) {
        return {
          ok: false,
          error:
            "Sem permissão do site de captura. Clique Salvar e aceite o host (ex.: obraprimaweb.com.br).",
        };
      }
      // Re-bind listener after permission grant.
      bindWebRequest();
      // MUST get Cookie line from real GET on capture URL (Network).
      capture = await captureCookieHeaderByNavigation();
      if (!isFreshNetworkCapture(capture)) {
        return {
          ok: false,
          error:
            "Não peguei o Cookie completo do Network em " +
            captureConfigured +
            ". Fique LOGADA em /orcamentos (não /login), Salvar, Enviar agora. Extensão deve ser v" +
            EXTENSION_VERSION +
            ".",
        };
      }
    } else {
      if (!capture) capture = lastNetworkCapture;
      if (!isFreshNetworkCapture(capture)) {
        return {
          ok: false,
          error: "Sem Cookie Network fresco — abra a URL de captura logada",
          skipped: true,
        };
      }
    }

    // Absolute rule: never ship a login-page capture.
    if (!capture.url || isAuthOrLoginPath(new URL(capture.url).pathname)) {
      return { ok: false, error: "Captura em /login bloqueada" };
    }
    if (!isCaptureUrl(capture.url, liveConfig)) {
      return {
        ok: false,
        error: "Cookie não é da URL de captura configurada: " + capture.url,
      };
    }
    if (!capture.cookieHeader) {
      return { ok: false, error: "cookieHeader vazio" };
    }

    // Webhook body is ONLY the Cookie line from the Network GET (same as F12).
    const payload = {
      cookieHeader: capture.cookieHeader,
    };

    if (
      !isManual &&
      settings.lastCookieHeader &&
      payload.cookieHeader === settings.lastCookieHeader
    ) {
      return { ok: false, error: "Cookies iguais ao último envio", skipped: true };
    }

    let res;
    try {
      res = await postWebhook(webhookUrl, payload, settings);
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }

    if (res.status >= 200 && res.status < 300) {
      if (!isManual) lastAutoSendAt = Date.now();
      await chrome.storage.local.set({
        lastSentAt: Date.now(),
        lastCookieHeader: payload.cookieHeader,
      });
      return {
        ok: true,
        status: res.status,
        cookieCount: (payload.cookieHeader || "").split(";").filter((s) => s.trim()).length,
        captureSource: "webRequest",
        requestUrl: capture.url,
        cookieHeaderLength: payload.cookieHeader.length,
      };
    }
    return { ok: false, error: `HTTP ${res.status}`, status: res.status };
  } finally {
    sending = false;
  }
}

function scheduleSend(reason, force) {
  if (navigatingForCapture) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    debounceTimer = null;
    if (navigatingForCapture) return;
    try {
      const result = await sendCookies({
        tabUrl: liveConfig.captureUrl,
        force: !!force,
        reason,
        networkCapture: lastNetworkCapture,
      });
      if (!result.ok && !result.skipped && !result.busy && !result.throttled) {
        console.warn("capturador-cookie send:", reason, result.error);
      } else if (result.ok) {
        console.log(
          "capturador-cookie send ok:",
          reason,
          result.status,
          result.requestUrl,
          "cookieHeaderLen=",
          result.cookieHeaderLength
        );
      }
    } catch (e) {
      console.warn("capturador-cookie send exception:", e);
    }
  }, DEBOUNCE_MS);
}

// REMOVED cookies.onChanged auto-send — that was firing on /login with garbage.

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (navigatingForCapture) return;
  if (changeInfo.status !== "complete") return;
  const url = tab && tab.url;
  if (!url || !isTargetUrl(url, liveConfig)) return;
  if (isAuthOrLoginPath(new URL(url).pathname)) return;
  if (!isCaptureUrl(url, liveConfig)) return;
  // Soft auto: only if we already saw Network Cookie for this navigation.
  if (!isFreshNetworkCapture(lastNetworkCapture)) return;
  try {
    await sendCookies({
      tabUrl: url,
      force: false,
      reason: "tab-capture",
      networkCapture: lastNetworkCapture,
    });
  } catch (e) {
    console.warn("capturador-cookie auto-send:", e);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.captureUrl || changes.domainMode) {
    refreshConfigAndBindings();
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg && msg.type === "SEND_NOW") {
      sendResponse(
        await sendCookies({
          tabUrl: msg.url || liveConfig.captureUrl,
          force: true,
          reason: "send-now",
          networkCapture: lastNetworkCapture,
        })
      );
      return;
    }
    if (msg && msg.type === "GET_STATUS") {
      const status = await getSettings();
      status.extensionVersion = EXTENSION_VERSION;
      sendResponse(status);
      return;
    }
    if (msg && msg.type === "CONFIG_UPDATED") {
      await refreshConfigAndBindings();
      sendResponse({ ok: true, config: liveConfig });
      return;
    }
    sendResponse({ ok: false, error: "Mensagem desconhecida" });
  })();
  return true;
});

refreshConfigAndBindings();
