const assert = require("assert");
const path = require("path");
const {
  isTargetUrl,
  isCaptureUrl,
  shouldSend,
  validateWebhookUrl,
  validateCaptureUrl,
  parseCaptureTarget,
  resolveCookieDomain,
  cookieBelongsToTarget,
  buildCookieHeader,
  parseCookieHeader,
  buildPayload,
  TARGET_REQUEST_URL,
  DEFAULT_INTERVAL_HOURS,
  DOMAIN_MODE_PRINCIPAL,
  DOMAIN_MODE_SUBDOMINIO,
  isCompleteCookieHeader,
} = require(path.join(__dirname, "..", "lib", "capturador-cookie.js"));

assert.strictEqual(DEFAULT_INTERVAL_HOURS, 12);
assert.strictEqual(TARGET_REQUEST_URL, "https://www.example.com/app");
assert.strictEqual(resolveCookieDomain("www.example.com"), "example.com");
assert.strictEqual(resolveCookieDomain("example.com"), "example.com");

const sub = parseCaptureTarget("https://www.example.com/app", "subdominio");
assert.strictEqual(sub.ok, true);
assert.strictEqual(sub.targetHost, "www.example.com");
assert.strictEqual(sub.domainMode, DOMAIN_MODE_SUBDOMINIO);
assert.strictEqual(sub.cookieDomain, "example.com");
assert.strictEqual(sub.originPattern, "https://www.example.com/*");

const apex = parseCaptureTarget("https://example.com/app", "principal");
assert.strictEqual(apex.ok, true);
assert.strictEqual(apex.domainMode, DOMAIN_MODE_PRINCIPAL);
assert.strictEqual(apex.cookieDomain, "example.com");

assert.strictEqual(validateCaptureUrl("not a url").ok, false);
assert.strictEqual(
  validateCaptureUrl("https://www.obraprimaweb.com.br/").ok,
  true
);
assert.strictEqual(validateCaptureUrl("www.example.com/app").ok, true);
assert.strictEqual(validateWebhookUrl("").ok, false);
assert.ok(
  String(validateWebhookUrl("").error).toLowerCase().includes("webhook")
);
assert.strictEqual(isTargetUrl("https://www.example.com/app", sub), true);
assert.strictEqual(isTargetUrl("https://evil.com/", sub), false);
assert.strictEqual(isCaptureUrl("https://www.example.com/app", sub), true);
assert.strictEqual(isCaptureUrl("https://www.example.com/home", sub), false);
assert.strictEqual(
  isCaptureUrl("https://www.example.com/login", sub),
  false,
  "never capture login page"
);

assert.strictEqual(isCompleteCookieHeader("a=1"), false);
assert.strictEqual(
  isCompleteCookieHeader(
    "ASP.NET_SessionId=abc; AWSALB=x; aws-waf-token=y; -OP=u; a=1; b=2; c=3; d=4"
  ),
  true
);
const rootCfg = parseCaptureTarget("https://www.example.com/", "subdominio");
assert.strictEqual(isCaptureUrl("https://www.example.com/", rootCfg), true);
assert.strictEqual(
  isCaptureUrl("https://www.example.com/orcamentos", rootCfg),
  false,
  "root / must not match every path"
);

assert.strictEqual(
  isTargetUrl("https://www.example.com/x", apex),
  true,
  "principal mode accepts www under example.com"
);
assert.strictEqual(isTargetUrl("https://other.com/x", apex), false);

assert.strictEqual(
  cookieBelongsToTarget({ domain: ".example.com" }, sub),
  true
);
assert.strictEqual(
  cookieBelongsToTarget({ domain: "www.example.com" }, sub),
  true
);
assert.strictEqual(
  cookieBelongsToTarget({ domain: "evil.com" }, sub),
  false
);

assert.strictEqual(shouldSend(1000, 0, 12), true);
assert.strictEqual(shouldSend(1000, 999, 12), false);
const twelveH = 12 * 60 * 60 * 1000;
assert.strictEqual(shouldSend(twelveH + 1, 1, 12), true);
assert.strictEqual(validateWebhookUrl("totally not a url!!!").ok, false);
assert.strictEqual(validateWebhookUrl("https://hooks.example.com/x").ok, true);
assert.strictEqual(validateWebhookUrl("hooks.example.com/x").ok, true);

const {
  buildWebhookAuthHeaders,
} = require(path.join(__dirname, "..", "lib", "capturador-cookie.js"));
assert.strictEqual(buildWebhookAuthHeaders("none").ok, true);
assert.strictEqual(buildWebhookAuthHeaders("bearer", "").ok, false);
assert.strictEqual(
  buildWebhookAuthHeaders("bearer", "tok").headers.Authorization,
  "Bearer tok"
);
assert.strictEqual(
  buildWebhookAuthHeaders("bearer", "Bearer already").headers.Authorization,
  "Bearer already"
);
assert.strictEqual(buildWebhookAuthHeaders("header", "", "X-Api-Key", "").ok, false);
assert.strictEqual(
  buildWebhookAuthHeaders("header", "", "X-Api-Key", "secret").headers["X-Api-Key"],
  "secret"
);

assert.strictEqual(
  buildCookieHeader([
    { name: "a", value: "1" },
    { name: "b", value: "2" },
  ]),
  "a=1; b=2"
);

const parsed = parseCookieHeader("session_id=abc; auth_token=x");
assert.strictEqual(parsed.length, 2);
assert.strictEqual(parsed[0].name, "session_id");

const payload = buildPayload({
  url: "https://www.example.com/app",
  cookies: [
    {
      name: "a",
      value: "1",
      domain: ".example.com",
      path: "/",
      secure: true,
      httpOnly: true,
      expirationDate: 1,
    },
  ],
  capturedAt: "2026-01-01T00:00:00.000Z",
  config: sub,
});
assert.strictEqual(payload.source, "capturador-de-cookie");
assert.strictEqual(payload.host, "www.example.com");
assert.strictEqual(payload.domainMode, DOMAIN_MODE_SUBDOMINIO);
assert.strictEqual(payload.cookieHeader, "a=1");

const withStorage = buildPayload({
  url: "https://www.example.com/app",
  cookieHeader: "a=1",
  cookies: [],
  config: sub,
  webStorage: {
    localStorage: { token: "abc" },
    sessionStorage: { flag: "1" },
    pageUrl: "https://www.example.com/app",
    storageSource: "tab",
  },
});
assert.strictEqual(withStorage.localStorage.token, "abc");
assert.deepStrictEqual(withStorage.localStorageKeys, ["token"]);
assert.strictEqual(withStorage.storageSource, "tab");

console.log("All capturador-cookie helper tests passed.");
