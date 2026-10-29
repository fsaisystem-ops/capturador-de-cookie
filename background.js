importScripts("lib/capturador-cookie.js");

const {
  COOKIE_DOMAIN,
  TARGET_REQUEST_URL,
  DEFAULT_INTERVAL_HOURS,
  isTargetUrl,
  isCaptureUrl,
  shouldSend,
  buildPayload,
} = CapturadorCookie;

const DEBOUNCE_MS = 2500;

let debounceTimer = null;
let sending = false;
/** @type {{ cookieHeader: string, url: string, method: string } | null} */
let lastNetworkCapture = null;

async function getSettings() {
  return chrome.storage.local.get({
    webhookUrl: "",
    intervalHours: DEFAULT_INTERVAL_HOURS,
    lastSentAt: 0,
    lastCookieHeader: "",
  });
}

async function readCookiesForCaptureUrl() {
  return chrome.cookies.getAll({ url: TARGET_REQUEST_URL });
}

function cookieBelongsToTarget(cookie) {
  if (!cookie || !cookie.domain) return false;
  const d = String(cookie.domain).replace(/^\./, "").toLowerCase();
  return d === COOKIE_DOMAIN || d.endsWith("." + COOKIE_DOMAIN);
}

async function postWebhook(webhookUrl, payload) {
  return fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

    const now = Date.now();
    if (!force && !shouldSend(now, settings.lastSentAt, settings.intervalHours)) {
      return { ok: false, error: "Throttle ativo", throttled: true };
    }

    const capture = networkCapture || lastNetworkCapture;
    const jar = await readCookiesForCaptureUrl();
    const cookieHeader =
      capture && capture.cookieHeader
        ? capture.cookieHeader
        : jar.map((c) => `${c.name}=${c.value}`).join("; ");

    if (!cookieHeader) {
      return { ok: false, error: "Nenhum cookie para a URL de captura" };
    }

    const payload = buildPayload({
      url: (capture && capture.url) || tabUrl || TARGET_REQUEST_URL,
      cookies: jar,
      cookieHeader,
      capturedAt: new Date().toISOString(),
      request: {
        url: (capture && capture.url) || TARGET_REQUEST_URL,
        method: (capture && capture.method) || "GET",
      },
    });
    payload.trigger = reason || (force ? "force" : "auto");
    payload.captureSource =
      capture && capture.cookieHeader ? "webRequest" : "cookies.getAll";

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
      res = await postWebhook(webhookUrl, payload);
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
        tabUrl: TARGET_REQUEST_URL,
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

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.method !== "GET") return;
    if (!isCaptureUrl(details.url)) return;
    const headers = details.requestHeaders || [];
    const cookieHdr = headers.find((h) => h.name.toLowerCase() === "cookie");
    if (!cookieHdr || !cookieHdr.value) return;

    lastNetworkCapture = {
      cookieHeader: cookieHdr.value,
      url: details.url,
      method: details.method,
    };
    console.log(
      "capturador-cookie captured Cookie length=",
      cookieHdr.value.length
    );
    scheduleSend("network-capture", true);
  },
  {
    urls: ["https://www.example.com/app*"],
    types: ["main_frame"],
  },
  ["requestHeaders", "extraHeaders"]
);

chrome.cookies.onChanged.addListener((changeInfo) => {
  if (changeInfo.removed) return;
  if (!cookieBelongsToTarget(changeInfo.cookie)) return;
  scheduleSend("login", true);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  const url = tab && tab.url;
  if (!url || !isTargetUrl(url)) return;
  try {
    const force = isCaptureUrl(url);
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg && msg.type === "SEND_NOW") {
      sendResponse(
        await sendCookies({
          tabUrl: msg.url || TARGET_REQUEST_URL,
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
    sendResponse({ ok: false, error: "Mensagem desconhecida" });
  })();
  return true;
});
