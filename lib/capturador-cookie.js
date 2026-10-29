(function (root) {
  const TARGET_HOST = "www.example.com";
  const COOKIE_DOMAIN = "example.com";
  const TARGET_REQUEST_URL = "https://www.example.com/app";
  const DEFAULT_INTERVAL_HOURS = 12;

  function isTargetUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === "https:" && u.hostname === TARGET_HOST;
    } catch {
      return false;
    }
  }

  function isCaptureUrl(url) {
    try {
      const u = new URL(url);
      return (
        u.protocol === "https:" &&
        u.hostname === TARGET_HOST &&
        (u.pathname === "/app" || u.pathname.startsWith("/app/"))
      );
    } catch {
      return false;
    }
  }

  function shouldSend(nowMs, lastSentAt, intervalHours) {
    const last = Number(lastSentAt) || 0;
    if (!last) return true;
    const hours = Number(intervalHours);
    const interval =
      (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_INTERVAL_HOURS) *
      60 *
      60 *
      1000;
    return nowMs - last >= interval;
  }

  function validateWebhookUrl(url) {
    let u;
    try {
      u = new URL(String(url || "").trim());
    } catch {
      return { ok: false, error: "URL inválida" };
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      return { ok: false, error: "URL deve ser http(s)" };
    }
    if (!u.hostname) {
      return { ok: false, error: "URL inválida" };
    }
    return { ok: true, originPattern: `${u.protocol}//${u.host}/*` };
  }

  function buildCookieHeader(cookies) {
    return (cookies || []).map((c) => `${c.name}=${c.value}`).join("; ");
  }

  function parseCookieHeader(header) {
    const raw = String(header || "").trim();
    if (!raw) return [];
    return raw.split(/;\s*/).filter(Boolean).map((part) => {
      const eq = part.indexOf("=");
      if (eq === -1) return { name: part, value: "" };
      return {
        name: part.slice(0, eq),
        value: part.slice(eq + 1),
      };
    });
  }

  function cookieNames(headerOrList) {
    if (Array.isArray(headerOrList)) {
      return headerOrList.map((c) => c.name).filter(Boolean);
    }
    return parseCookieHeader(headerOrList).map((c) => c.name);
  }

  function buildPayload({ url, cookies, cookieHeader, capturedAt, request }) {
    const header =
      cookieHeader != null && String(cookieHeader).length
        ? String(cookieHeader)
        : buildCookieHeader(cookies || []);
    const fromHeader = parseCookieHeader(header);
    const byName = new Map((cookies || []).map((c) => [c.name, c]));
    const list = (fromHeader.length ? fromHeader : cookies || []).map((c) => {
      const full = byName.get(c.name) || {};
      return {
        name: c.name,
        value: c.value,
        domain: full.domain ?? null,
        path: full.path ?? null,
        secure: full.secure != null ? !!full.secure : null,
        httpOnly: full.httpOnly != null ? !!full.httpOnly : null,
        expirationDate: full.expirationDate ?? null,
      };
    });
    return {
      source: "capturador-de-cookie",
      host: TARGET_HOST,
      url: url || TARGET_REQUEST_URL,
      requestUrl: (request && request.url) || url || TARGET_REQUEST_URL,
      requestMethod: (request && request.method) || "GET",
      capturedAt: capturedAt || new Date().toISOString(),
      cookies: list,
      cookieHeader: header,
      cookieNames: list.map((c) => c.name),
    };
  }

  const api = {
    TARGET_HOST,
    COOKIE_DOMAIN,
    TARGET_REQUEST_URL,
    DEFAULT_INTERVAL_HOURS,
    isTargetUrl,
    isCaptureUrl,
    shouldSend,
    validateWebhookUrl,
    buildCookieHeader,
    parseCookieHeader,
    cookieNames,
    buildPayload,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.CapturadorCookie = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
