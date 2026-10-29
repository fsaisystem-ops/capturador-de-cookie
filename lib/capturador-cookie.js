(function (root) {
  const TARGET_HOST = "www.example.com";
  const COOKIE_DOMAIN = "example.com";
  const TARGET_REQUEST_URL = "https://www.example.com/app";
  const DEFAULT_INTERVAL_HOURS = 12;
  const DOMAIN_MODE_PRINCIPAL = "principal";
  const DOMAIN_MODE_SUBDOMINIO = "subdominio";

  function defaultCaptureConfig() {
    return {
      captureUrl: TARGET_REQUEST_URL,
      domainMode: DOMAIN_MODE_SUBDOMINIO,
      targetHost: TARGET_HOST,
      cookieDomain: COOKIE_DOMAIN,
      originPattern: "https://www.example.com/*",
    };
  }

  /** Naive eTLD+1: last two labels (docs note limitation for co.uk etc.). */
  function resolveCookieDomain(hostname) {
    const host = String(hostname || "")
      .replace(/^\./, "")
      .toLowerCase();
    if (!host) return "";
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
    const parts = host.split(".").filter(Boolean);
    if (parts.length <= 2) return host;
    return parts.slice(-2).join(".");
  }

  function validateCaptureUrl(url) {
    let u;
    try {
      u = new URL(String(url || "").trim());
    } catch {
      return { ok: false, error: "URL de captura inválida" };
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      return { ok: false, error: "URL de captura deve ser http(s)" };
    }
    if (!u.hostname) {
      return { ok: false, error: "URL de captura inválida" };
    }
    return { ok: true, url: u };
  }

  function normalizeDomainMode(mode) {
    return mode === DOMAIN_MODE_PRINCIPAL
      ? DOMAIN_MODE_PRINCIPAL
      : DOMAIN_MODE_SUBDOMINIO;
  }

  /**
   * @param {string} captureUrl
   * @param {string} domainMode principal | subdominio
   */
  function parseCaptureTarget(captureUrl, domainMode) {
    const checked = validateCaptureUrl(captureUrl);
    if (!checked.ok) return checked;
    const u = checked.url;
    const mode = normalizeDomainMode(domainMode);
    const targetHost = u.hostname.toLowerCase();
    const cookieDomain =
      mode === DOMAIN_MODE_PRINCIPAL
        ? resolveCookieDomain(targetHost)
        : resolveCookieDomain(targetHost);
    return {
      ok: true,
      captureUrl: u.toString(),
      domainMode: mode,
      targetHost,
      cookieDomain,
      originPattern: `${u.protocol}//${u.host}/*`,
      pathname: u.pathname || "/",
    };
  }

  function isTargetUrl(url, config) {
    const cfg = config || defaultCaptureConfig();
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      const host = u.hostname.toLowerCase();
      if (cfg.domainMode === DOMAIN_MODE_PRINCIPAL) {
        const base = (cfg.cookieDomain || "").toLowerCase();
        return host === base || host.endsWith("." + base);
      }
      return host === String(cfg.targetHost || "").toLowerCase();
    } catch {
      return false;
    }
  }

  function isCaptureUrl(url, config) {
    const cfg = config || defaultCaptureConfig();
    try {
      const u = new URL(url);
      if (!isTargetUrl(url, cfg)) return false;
      const target = new URL(cfg.captureUrl || TARGET_REQUEST_URL);
      const want = target.pathname || "/";
      const got = u.pathname || "/";
      if (want === "/") return true;
      return got === want || got.startsWith(want.endsWith("/") ? want : want + "/");
    } catch {
      return false;
    }
  }

  function cookieBelongsToTarget(cookie, config) {
    if (!cookie || !cookie.domain) return false;
    const cfg = config || defaultCaptureConfig();
    const d = String(cookie.domain).replace(/^\./, "").toLowerCase();
    const host = String(cfg.targetHost || "").toLowerCase();
    const base = String(cfg.cookieDomain || "").toLowerCase();
    if (!base && !host) return false;
    if (cfg.domainMode === DOMAIN_MODE_SUBDOMINIO) {
      return (
        d === host ||
        d === base ||
        (base && d.endsWith("." + base)) ||
        (host && host.endsWith("." + d))
      );
    }
    return d === base || (base && d.endsWith("." + base));
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

  function buildPayload({ url, cookies, cookieHeader, capturedAt, request, config }) {
    const cfg = config || defaultCaptureConfig();
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
      host: cfg.targetHost || TARGET_HOST,
      domainMode: cfg.domainMode || DOMAIN_MODE_SUBDOMINIO,
      cookieDomain: cfg.cookieDomain || COOKIE_DOMAIN,
      url: url || cfg.captureUrl || TARGET_REQUEST_URL,
      requestUrl: (request && request.url) || url || cfg.captureUrl || TARGET_REQUEST_URL,
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
    DOMAIN_MODE_PRINCIPAL,
    DOMAIN_MODE_SUBDOMINIO,
    defaultCaptureConfig,
    resolveCookieDomain,
    validateCaptureUrl,
    parseCaptureTarget,
    isTargetUrl,
    isCaptureUrl,
    cookieBelongsToTarget,
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
