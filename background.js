importScripts("lib/capturador-cookie.js");

const {
  DEFAULT_INTERVAL_HOURS,
  TARGET_REQUEST_URL,
  defaultCaptureConfig,
  parseCaptureTarget,
  isTargetUrl,
  isCaptureUrl,
  cookieBelongsToTarget,
  shouldSend,
  buildPayload,
} = CapturadorCookie;

const DEBOUNCE_MS = 2500;
/** How long a captured Cookie header from Network stays "fresh". */
const CAPTURE_FRESH_MS = 5 * 60 * 1000;
const NAV_CAPTURE_TIMEOUT_MS = 20000;

let debounceTimer = null;
let sending = false;
/** @type {{ cookieHeader: string, url: string, method: string, capturedAt: number } | null} */
let lastNetworkCapture = null;
/** Resolvers waiting for the next real Cookie header from Network. */
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
  if (data.lastNetworkCapture && data.lastNetworkCapture.cookieHeader) {
    lastNetworkCapture = data.lastNetworkCapture;
  }
  return liveConfig;
}

function rememberNetworkCapture(cap) {
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

function isFreshNetworkCapture(cap, forUrl) {
  if (!cap || !cap.cookieHeader) return false;
  const age = Date.now() - (Number(cap.capturedAt) || 0);
  if (age > CAPTURE_FRESH_MS) return false;
  if (forUrl && !isCaptureUrl(cap.url || "", liveConfig)) return false;
  return true;
}

function onBeforeSendHeaders(details) {
  if (details.method !== "GET") return;
  if (!isCaptureUrl(details.url, liveConfig)) return;
  const headers = details.requestHeaders || [];
  const cookieHdr = headers.find((h) => h.name.toLowerCase() === "cookie");
  if (!cookieHdr || !cookieHdr.value) return;

  const hadWaiters = pendingCookieWaiters.length > 0;
  rememberNetworkCapture({
    cookieHeader: cookieHdr.value,
    url: details.url,
    method: details.method,
  });
  console.log(
    "capturador-cookie captured Cookie length=",
    cookieHdr.value.length,
    details.url
  );
  // If Enviar agora is waiting for this header, don't auto-schedule a second send.
  if (!hadWaiters) {
    scheduleSend("network-capture", true);
  }
}

function bindWebRequest() {
  try {
    if (chrome.webRequest.onBeforeSendHeaders.hasListener(onBeforeSendHeaders)) {
      chrome.webRequest.onBeforeSendHeaders.removeListener(onBeforeSendHeaders);
    }
  } catch (_) {
    /* ignore */
  }
  const pattern = liveConfig && liveConfig.originPattern;
  if (!pattern) return;
  try {
    chrome.webRequest.onBeforeSendHeaders.addListener(
      onBeforeSendHeaders,
      { urls: [pattern], types: ["main_frame"] },
      ["requestHeaders", "extraHeaders"]
    );
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
  // Merge domain jar so Path=/ cookies are not missed when URL filter is picky.
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

/**
 * Prefer the real Cookie header from a logged-in GET (Network).
 * If missing/stale, navigate the capture URL and wait for webRequest.
 */
async function ensureNetworkCookieHeader({ forceNavigate }) {
  if (!forceNavigate && isFreshNetworkCapture(lastNetworkCapture, true)) {
    return lastNetworkCapture;
  }

  const captureUrl = liveConfig.captureUrl || TARGET_REQUEST_URL;

  const waitPromise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCookieWaiters = pendingCookieWaiters.filter((w) => w !== resolveWrapped);
      resolve(null);
    }, NAV_CAPTURE_TIMEOUT_MS);

    function resolveWrapped(cap) {
      clearTimeout(timer);
      resolve(cap);
    }
    pendingCookieWaiters.push(resolveWrapped);
  });

  try {
    let tab = await findTabForCapture();
    if (tab && tab.id) {
      // Reload/navigate so Network fires Cookie on the capture URL.
      await chrome.tabs.update(tab.id, { url: captureUrl, active: false });
    } else {
      await chrome.tabs.create({ url: captureUrl, active: false });
    }
  } catch (e) {
    console.warn("capturador-cookie navigate for Cookie header:", e);
  }

  const cap = await waitPromise;
  if (cap && cap.cookieHeader) return cap;
  if (isFreshNetworkCapture(lastNetworkCapture, false)) return lastNetworkCapture;
  return null;
}

/** Aba aberta no host/alvo — precisa existir pra ler local/sessionStorage. */
async function findTabForCapture() {
  const tabs = await chrome.tabs.query({});
  const preferred = liveConfig.captureUrl || TARGET_REQUEST_URL;
  let best = null;
  for (const tab of tabs) {
    if (!tab.id || !tab.url || !isTargetUrl(tab.url, liveConfig)) continue;
    if (isCaptureUrl(tab.url, liveConfig)) return tab;
    if (!best) best = tab;
  }
  if (best) return best;
  // fallback: URL configurada exata
  const exact = tabs.find((t) => t.url && t.url.startsWith(preferred.split("?")[0]));
  return exact || null;
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

async function readWebStorageFromTab() {
  const empty = {
    localStorage: {},
    sessionStorage: {},
    pageUrl: null,
    storageSource: "none",
  };
  try {
    const tab = await findTabForCapture();
    if (!tab || !tab.id) return empty;
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
    if (!webhookUrl) {
      return { ok: false, error: "Webhook não configurado" };
    }
    if (!(settings.captureUrl || "").trim()) {
      return { ok: false, error: "URL de captura não configurada" };
    }

    const now = Date.now();
    if (!force && !shouldSend(now, settings.lastSentAt, settings.intervalHours)) {
      return { ok: false, error: "Throttle ativo", throttled: true };
    }

    // Always try to get the full Cookie line from a real GET (like DevTools Network).
    let capture = networkCapture || null;
    const needFresh =
      reason === "send-now" ||
      reason === "network-capture" ||
      !isFreshNetworkCapture(capture || lastNetworkCapture, true);

    if (needFresh || !(capture && capture.cookieHeader)) {
      const ensured = await ensureNetworkCookieHeader({
        forceNavigate: reason === "send-now" || !isFreshNetworkCapture(lastNetworkCapture, true),
      });
      if (ensured && ensured.cookieHeader) capture = ensured;
      else if (!capture) capture = lastNetworkCapture;
    }

    const jar = await readCookiesForCaptureUrl();
    const jarHeader = jar.map((c) => `${c.name}=${c.value}`).join("; ");
    // Prefer Network Cookie header (complete request line). Fallback: jar merge.
    const cookieHeader =
      capture && capture.cookieHeader ? capture.cookieHeader : jarHeader;

    if (!cookieHeader) {
      return {
        ok: false,
        error:
          "Nenhum cookieHeader. Abra/logue na URL de captura (ex.: /orcamentos) e tente de novo.",
      };
    }

    const webStorage = await readWebStorageFromTab();

    const payload = buildPayload({
      url: (capture && capture.url) || tabUrl || liveConfig.captureUrl,
      cookies: jar,
      cookieHeader,
      capturedAt: new Date().toISOString(),
      request: {
        url: (capture && capture.url) || liveConfig.captureUrl,
        method: (capture && capture.method) || "GET",
      },
      config: liveConfig,
      webStorage,
    });
    payload.trigger = reason || (force ? "force" : "auto");
    payload.captureSource =
      capture && capture.cookieHeader ? "webRequest" : "cookies.getAll";
    // Explicit alias for consumers that expect this key shape.
    payload.cookieHeader = cookieHeader;

    if (
      force &&
      (reason === "login" || reason === "network-capture") &&
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
      await chrome.storage.local.set({
        lastSentAt: Date.now(),
        lastCookieHeader: payload.cookieHeader,
      });
      return {
        ok: true,
        status: res.status,
        cookieCount: payload.cookieNames.length,
        captureSource: payload.captureSource,
        storageSource: payload.storageSource,
        localStorageKeys: (payload.localStorageKeys || []).length,
        sessionStorageKeys: (payload.sessionStorageKeys || []).length,
      };
    }
    return { ok: false, error: `HTTP ${res.status}`, status: res.status };
  } finally {
    sending = false;
  }
}

function scheduleSend(reason, force) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    debounceTimer = null;
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
          "cookies=",
          result.cookieCount,
          result.captureSource
        );
      }
    } catch (e) {
      console.warn("capturador-cookie send exception:", e);
    }
  }, DEBOUNCE_MS);
}

chrome.cookies.onChanged.addListener((changeInfo) => {
  if (changeInfo.removed) return;
  if (!cookieBelongsToTarget(changeInfo.cookie, liveConfig)) return;
  scheduleSend("login", true);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  const url = tab && tab.url;
  if (!url || !isTargetUrl(url, liveConfig)) return;
  try {
    const force = isCaptureUrl(url, liveConfig);
    const result = await sendCookies({
      tabUrl: url,
      force,
      reason: force ? "tab-capture" : "tab-complete",
      networkCapture: lastNetworkCapture,
    });
    if (!result.ok && !result.throttled && !result.busy && !result.skipped) {
      console.warn("capturador-cookie auto-send:", result.error);
    }
  } catch (e) {
    console.warn("capturador-cookie auto-send exception:", e);
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
      sendResponse(await getSettings());
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
