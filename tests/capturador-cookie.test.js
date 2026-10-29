const assert = require("assert");
const path = require("path");
const {
  isTargetUrl,
  isCaptureUrl,
  shouldSend,
  validateWebhookUrl,
  buildCookieHeader,
  parseCookieHeader,
  buildPayload,
  TARGET_REQUEST_URL,
  DEFAULT_INTERVAL_HOURS,
} = require(path.join(__dirname, "..", "lib", "capturador-cookie.js"));

assert.strictEqual(DEFAULT_INTERVAL_HOURS, 12);
assert.strictEqual(TARGET_REQUEST_URL, "https://www.example.com/app");
assert.strictEqual(isTargetUrl("https://www.example.com/app"), true);
assert.strictEqual(isTargetUrl("https://evil.com/"), false);
assert.strictEqual(isCaptureUrl("https://www.example.com/app"), true);
assert.strictEqual(isCaptureUrl("https://www.example.com/home"), false);
assert.strictEqual(shouldSend(1000, 0, 12), true);
assert.strictEqual(shouldSend(1000, 999, 12), false);
const twelveH = 12 * 60 * 60 * 1000;
assert.strictEqual(shouldSend(twelveH + 1, 1, 12), true);
assert.strictEqual(validateWebhookUrl("not-a-url").ok, false);
assert.strictEqual(validateWebhookUrl("https://hooks.example.com/x").ok, true);
assert.strictEqual(
  validateWebhookUrl("https://hooks.example.com/x").originPattern,
  "https://hooks.example.com/*"
);
assert.strictEqual(
  buildCookieHeader([
    { name: "a", value: "1" },
    { name: "b", value: "2" },
  ]),
  "a=1; b=2"
);

const parsed = parseCookieHeader(
  "session_id=abc; auth_token=x; user=u@x.com; csrf=t"
);
assert.strictEqual(parsed.length, 4);
assert.strictEqual(parsed[0].name, "session_id");
assert.strictEqual(parsed[0].value, "abc");

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
});
assert.strictEqual(payload.source, "capturador-de-cookie");
assert.strictEqual(payload.host, "www.example.com");
assert.strictEqual(payload.cookieHeader, "a=1");
assert.strictEqual(payload.requestUrl, "https://www.example.com/app");

const fromNet = buildPayload({
  url: "https://www.example.com/app",
  cookieHeader: "session_id=s1; auth_token=alb; csrf=cors; waf_token=waf",
  cookies: [],
  request: {
    url: "https://www.example.com/app",
    method: "GET",
  },
  capturedAt: "2026-01-01T00:00:00.000Z",
});
assert.ok(fromNet.cookieHeader.includes("session_id=s1"));
assert.deepStrictEqual(fromNet.cookieNames, [
  "session_id",
  "auth_token",
  "csrf",
  "waf_token",
]);

console.log("All capturador-cookie helper tests passed.");
