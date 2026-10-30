importScripts("lib/capturador-cookie.js");

const {
  DEFAULT_INTERVAL_HOURS,
  TARGET_REQUEST_URL,
  defaultCaptureConfig,
  parseCaptureTarget,
  isTargetUrl,
  isCaptureUrl,
  isAuthOrLoginPath,
  cookieBelongsToTarget,
  shouldSend,
  buildPayload,
} = CapturadorCookie;

const DEBOUNCE_MS = 2500;
const CAPTURE_FRESH_MS = 5 * 60 * 1000;
const NAV_CAPTURE_TIMEOUT_MS = 20000;
/** Min gap between automatic webhook sends (stops storm). */
const AUTO_SEND_COOLDOWN_MS = 60 * 1000;

let debounceTimer = null;
let sending = false;
/** True while we intentionally navigate to read Cookie header (Enviar agora only). */
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
  if (cap.url && isAuthOrLoginPath(new URL(cap.url).pathname)) return false;
  return true;
}

function onBeforeSendHeaders(details) {
  if (details.method !== "GET") return;
  if (!isCaptureUrl(details.url, liveConfig)) return;
  const headers = details.requestHeaders || [];
  const cookieHdr = headers.find((h) => h.name.toLowerCase() === "cookie");
  if (!cookieHdr || !cookieHdr.value) return;

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

  // NEVER auto-send from webRequest while we are navigating for capture,
  // and do not reload the page from here — that caused the infinite loop.
  if (navigatingForCapture || pendingCookieWaiters.length > 0) return;

  // Passive observe only: optional auto-send with cooldown + throttle (no navigate).
  scheduleSend("network-capture", false);
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

/** Aba aberta no host/alvo. */
async function findTabForCapture() {
  const tabs = await chrome.tabs.query({});
  const preferred = liveConfig.captureUrl || TARGET_REQUEST_URL;
  let best = null;
  for (const tab of tabs) {
    if (!tab.id || !tab.url || !isTargetUrl(tab.url, liveConfig)) continue;
    if (isAuthOrLoginPath(new URL(tab.url).pathname)) continue;
    if (isCaptureUrl(tab.url, liveConfig)) return tab;
    if (!best) best = tab;
  }
  if (best) return best;
  const exact = tabs.find(
    (t) => t.url && t.url.startsWith(preferred.split("?")[0])
  );
  return exact || null;
}

/**
 * Only used by Enviar agora. Navigates once, waits for Cookie header, stops.
 */
async function ensureNetworkCookieHeader({ forceNavigate }) {
  if (!forceNavigate && isFreshNetworkCapture(lastNetworkCapture, true)) {
    return lastNetworkCapture;
  }
  if (!forceNavigate) {
    return isFreshNetworkCapture(lastNetworkCapture, false)
      ? lastNetworkCapture
      : null;
  }

  if (navigatingForCapture) {
    // Already navigating — just wait.
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingCookieWaiters = pendingCookieWaiters.filter((w) => w !== wrap);
        resolve(lastNetworkCapture);
      }, NAV_CAPTURE_TIMEOUT_MS);
      function wrap(cap) {
        clearTimeout(timer);
        resolve(cap);
      }
      pendingCookieWaiters.push(wrap);
    });
  }

  const captureUrl = liveConfig.captureUrl || TARGET_REQUEST_URL;
  navigatingForCapture = true;

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
      const same =
        tab.url &&
        tab.url.split("?")[0].replace(/\/$/, "") ===
          captureUrl.split("?")[0].replace(/\/$/, "");
      if (same) {
        await chrome.tabs.reload(tab.id);
      } else {
        await chrome.tabs.update(tab.id, { url: captureUrl, active: false });
      }
    } else {
      await chrome.tabs.create({ url: captureUrl, active: false });
    }
  } catch (e) {
    console.warn("capturador-cookie navigate for Cookie header:", e);
  }

  try {
    const cap = await waitPromise;
    if (cap && cap.cookieHeader) return cap;
    if (isFreshNetworkCapture(lastNetworkCapture, false)) return lastNetworkCapture;
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
    const isManual = reason === "send-now";

    if (!isManual && now - lastAutoSendAt < AUTO_SEND_COOLDOWN_MS) {
      return { ok: false, error: "Cooldown-send cooldown", throttled: true };
    }

    if (!force && !shouldSend(now, settings.lastSentAt, settings.intervalHours)) {
      return { ok: false, error: "Throttle ativo", throttled: true };
    }

    let capture = networkCapture || null;
    if (capture && capture.url && isAuthOrLoginPath(new URL(capture.url).pathname)) {
      capture = null;
    }

    // ONLY manual Enviar agora may navigate/reload the page.
    if (isManual) {
      const ensured = await ensureNetworkCookieHeader({
        forceNavigate: !isFreshNetworkCapture(capture || lastNetworkCapture, true),
      });
      if (ensured && ensured.cookieHeader) {
        if (ensured.url && isAuthOrLoginPath(new URL(ensured.url).pathname)) {
          return {
            ok: false,
            error:
              "Ainda na tela de login. Faça login e use a URL de captura (ex.: /orcamentos).",
          };
        }
        capture = ensured;
      } else if (!capture) {
        capture = lastNetworkCapture;
      }
    } else {
      // Auto paths: use whatever Network already saw — never navigate.
      if (!capture) capture = lastNetworkCapture;
      if (!isFreshNetworkCapture(capture, true)) {
        return {
          ok: false,
          error: "Sem Cookie fresco do Network (auto sem reload)",
          skipped: true,
        };
      }
    }

    if (
      isManual &&
      !(
        capture &&
        capture.cookieHeader &&
        capture.url &&
        isCaptureUrl(capture.url, liveConfig)
      )
    ) {
      return {
        ok: false,
        error:
          "cookieHeader incompleto. Configure /orcamentos (não /login), logue e Enviar agora.",
      };
    }

    const jar = await readCookiesForCaptureUrl();
    const jarHeader = jar.map((c) => `${c.name}=${c.value}`).join("; ");
    const cookieHeader =
      capture && capture.cookieHeader ? capture.cookieHeader : jarHeader;

    if (!cookieHeader) {
      return {
        ok: false,
        error:
          "Nenhum cookieHeader. Logue e abra a URL de captura (ex.: /orcamentos).",
      };
    }

    if (
      !isManual &&
      settings.lastCookieHeader &&
      cookieHeader === settings.lastCookieHeader
    ) {
      return { ok: false, error: "Cookies iguais ao último envio", skipped: true };
    }

    const webStorage = await readWebStorageFromTab();
    if (
      webStorage.pageUrl &&
      isAuthOrLoginPath(new URL(webStorage.pageUrl).pathname)
    ) {
      webStorage.localStorage = {};
      webStorage.sessionStorage = {};
      webStorage.storageSource = "skipped-login-page";
    }

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
    payload.cookieHeader = cookieHeader;

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

// Cookie changes: do NOT navigate. Only queue a soft auto-send (cooldown + throttle).
chrome.cookies.onChanged.addListener(async (changeInfo) => {
  if (changeInfo.removed) return;
  if (navigatingForCapture) return;
  if (!cookieBelongsToTarget(changeInfo.cookie, liveConfig)) return;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeUrl = tabs[0] && tabs[0].url;
    if (activeUrl) {
      const path = new URL(activeUrl).pathname;
      if (isAuthOrLoginPath(path)) return;
      if (!isCaptureUrl(activeUrl, liveConfig)) return;
    }
  } catch (_) {
    return;
  }
  scheduleSend("login", false);
});

// Tab complete: never force, never navigate — respects intervalHours.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (navigatingForCapture) return;
  if (changeInfo.status !== "complete") return;
  const url = tab && tab.url;
  if (!url || !isTargetUrl(url, liveConfig)) return;
  if (isAuthOrLoginPath(new URL(url).pathname)) return;
  if (!isCaptureUrl(url, liveConfig)) return;
  try {
    const result = await sendCookies({
      tabUrl: url,
      force: false,
      reason: "tab-capture",
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
