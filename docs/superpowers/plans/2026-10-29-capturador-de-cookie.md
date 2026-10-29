# Capturador de Cookie Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Chrome MV3 extension that reads the operator’s cookies for `example.com` and POSTs them to a configurable webhook, with a default 12-hour throttle and an options page (“Salvar” / “Enviar agora”).

**Architecture:** Pure helpers in `lib/capturador-cookie.js` (throttle, header builder, URL validation, payload). Service worker `background.js` watches tab completion on the target host and sends. Options page stores `webhookUrl`, `intervalHours`, `lastSentAt` and can force a send. Webhook origin is requested via `chrome.permissions.request` on save.

**Tech Stack:** Chrome Extension Manifest V3, vanilla JS (no bundler), Node.js `assert` for pure-helper tests.

**Spec:** `C:\Users\svetlana\Desktop\capturador-de-cookie\docs\superpowers\specs\2026-10-29-capturador-de-cookie-design.md`

## Global Constraints

- Cookie domain scope: only `example.com`
- Target host trigger: `www.example.com` (any path)
- Default `intervalHours`: `12`
- Automatic send skips when webhook missing, throttle active, or zero cookies
- “Enviar agora” skips throttle; with zero cookies does **not** POST (warn in UI)
- `lastSentAt` updates only on HTTP 2xx
- Operator’s own session / local Load unpacked only (v1)
- Project root: `C:\Users\svetlana\Desktop\capturador-de-cookie`

## File structure

| File | Responsibility |
|------|----------------|
| `lib/capturador-cookie.js` | Pure helpers + shared constants (testable in Node) |
| `tests/capturador-cookie.test.js` | Node assert tests for helpers |
| `manifest.json` | MV3 manifest, permissions, options, background |
| `background.js` | Tab listener, auto-send orchestration, message handler |
| `options.html` | Options UI markup |
| `options.js` | Load/save settings, permission request, Send now |
| `README.md` | Install, configure, privacy |

---

### Task 1: Pure helpers + Node tests

**Files:**
- Create: `C:\Users\svetlana\Desktop\capturador-de-cookie\lib\capturador-cookie.js`
- Create: `C:\Users\svetlana\Desktop\capturador-de-cookie\tests\capturador-cookie.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `TARGET_HOST = "www.example.com"`
  - `COOKIE_DOMAIN = "example.com"`
  - `DEFAULT_INTERVAL_HOURS = 12`
  - `isTargetUrl(url: string): boolean`
  - `shouldSend(nowMs: number, lastSentAt: number, intervalHours: number): boolean`
  - `validateWebhookUrl(url: string): { ok: true, originPattern: string } | { ok: false, error: string }`
  - `buildCookieHeader(cookies: Array<{name: string, value: string}>): string`
  - `buildPayload({ url, cookies, capturedAt }): object`

- [ ] **Step 1: Write the failing test file**

Create `tests/capturador-cookie.test.js`:

```js
const assert = require("assert");
const path = require("path");
const {
  isTargetUrl,
  shouldSend,
  validateWebhookUrl,
  buildCookieHeader,
  buildPayload,
  DEFAULT_INTERVAL_HOURS,
} = require(path.join(__dirname, "..", "lib", "capturador-cookie.js"));

assert.strictEqual(DEFAULT_INTERVAL_HOURS, 12);
assert.strictEqual(isTargetUrl("https://www.example.com/app"), true);
assert.strictEqual(isTargetUrl("https://evil.com/"), false);
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
  buildCookieHeader([{ name: "a", value: "1" }, { name: "b", value: "2" }]),
  "a=1; b=2"
);
const payload = buildPayload({
  url: "https://www.example.com/app",
  cookies: [{ name: "a", value: "1", domain: ".example.com", path: "/", secure: true, httpOnly: true, expirationDate: 1 }],
  capturedAt: "2026-01-01T00:00:00.000Z",
});
assert.strictEqual(payload.source, "capturador-de-cookie");
assert.strictEqual(payload.host, "www.example.com");
assert.strictEqual(payload.cookieHeader, "a=1");
console.log("All capturador-cookie helper tests passed.");
```

- [ ] **Step 2: Run tests — expect FAIL (module missing)**

Run:

```powershell
node "C:\Users\svetlana\Desktop\capturador-de-cookie\tests\capturador-cookie.test.js"
```

Expected: error `Cannot find module` (or similar).

- [ ] **Step 3: Implement helpers**

Create `lib/capturador-cookie.js`:

```js
const TARGET_HOST = "www.example.com";
const COOKIE_DOMAIN = "example.com";
const DEFAULT_INTERVAL_HOURS = 12;

function isTargetUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === TARGET_HOST;
  } catch {
    return false;
  }
}

function shouldSend(nowMs, lastSentAt, intervalHours) {
  const last = Number(lastSentAt) || 0;
  const hours = Number(intervalHours);
  const interval = (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_INTERVAL_HOURS) * 60 * 60 * 1000;
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

function buildPayload({ url, cookies, capturedAt }) {
  const list = (cookies || []).map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    expirationDate: c.expirationDate ?? null,
  }));
  return {
    source: "capturador-de-cookie",
    host: TARGET_HOST,
    url: url || "",
    capturedAt: capturedAt || new Date().toISOString(),
    cookies: list,
    cookieHeader: buildCookieHeader(list),
  };
}

const api = {
  TARGET_HOST,
  COOKIE_DOMAIN,
  DEFAULT_INTERVAL_HOURS,
  isTargetUrl,
  shouldSend,
  validateWebhookUrl,
  buildCookieHeader,
  buildPayload,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
}
if (typeof globalThis !== "undefined") {
  globalThis.CapturadorCookie = api;
}
```

UMD: Node uses `module.exports`; Chrome uses `importScripts` / `<script>` and lê `globalThis.CapturadorCookie`.

- [ ] **Step 4: Run tests — expect PASS**

```powershell
node "C:\Users\svetlana\Desktop\capturador-de-cookie\tests\capturador-cookie.test.js"
```

Expected: `All capturador-cookie helper tests passed.`

- [ ] **Step 5: Commit (if git repo exists; else skip)**

```powershell
cd "C:\Users\svetlana\Desktop\capturador-de-cookie"
git init 2>$null
git add lib/capturador-cookie.js tests/capturador-cookie.test.js
git commit -m "feat: add cookie webhook pure helpers and tests"
```

If the user has no git preference yet, skip commit and continue.

---

### Task 2: Manifest V3

**Files:**
- Create: `C:\Users\svetlana\Desktop\capturador-de-cookie\manifest.json`

**Interfaces:**
- Consumes: none
- Produces: loadable unpacked extension declaring background + options + permissions

- [ ] **Step 1: Write `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "Capturador de Cookie",
  "version": "1.0.0",
  "description": "Envia cookies da sua sessão example.com para um webhook configurável (debug/automação).",
  "permissions": ["cookies", "storage", "tabs"],
  "host_permissions": ["https://www.example.com/*"],
  "optional_host_permissions": ["http://*/*", "https://*/*"],
  "background": {
    "service_worker": "background.js"
  },
  "options_page": "options.html",
  "action": {
    "default_title": "Capturador de Cookie — abra Opções"
  }
}
```

- [ ] **Step 2: Manual check**

Open `chrome://extensions` → Load unpacked → select `C:\Users\svetlana\Desktop\capturador-de-cookie`.  
Expected: extension appears; may warn until `background.js` / `options.html` exist — that is OK if Task 3–4 follow immediately. Prefer finishing Task 3–4 before load if Chrome rejects missing files.

- [ ] **Step 3: Commit (optional)**

```powershell
git add manifest.json
git commit -m "feat: add MV3 manifest for cookie webhook extension"
```

---

### Task 3: Background service worker

**Files:**
- Create: `C:\Users\svetlana\Desktop\capturador-de-cookie\background.js`
- Uses: `lib/capturador-cookie.js` via `importScripts`

**Interfaces:**
- Consumes: `CapturadorCookie.*` from Task 1; `chrome.tabs`, `chrome.cookies`, `chrome.storage`, `chrome.runtime`
- Produces:
  - Auto-send on target tab complete
  - Message API: `{ type: "SEND_NOW" }` → `{ ok: boolean, error?: string, status?: number }`
  - Message API: `{ type: "GET_STATUS" }` → `{ webhookUrl, intervalHours, lastSentAt }`

- [ ] **Step 1: Implement `background.js`**

```js
importScripts("lib/capturador-cookie.js");

const {
  COOKIE_DOMAIN,
  DEFAULT_INTERVAL_HOURS,
  isTargetUrl,
  shouldSend,
  buildPayload,
} = CapturadorCookie;

async function getSettings() {
  const data = await chrome.storage.local.get({
    webhookUrl: "",
    intervalHours: DEFAULT_INTERVAL_HOURS,
    lastSentAt: 0,
  });
  return data;
}

async function readCookies() {
  return chrome.cookies.getAll({ domain: COOKIE_DOMAIN });
}

async function postWebhook(webhookUrl, payload) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res;
}

async function sendCookies({ tabUrl, force }) {
  const settings = await getSettings();
  const webhookUrl = (settings.webhookUrl || "").trim();
  if (!webhookUrl) {
    return { ok: false, error: "Webhook não configurado" };
  }

  const now = Date.now();
  if (!force && !shouldSend(now, settings.lastSentAt, settings.intervalHours)) {
    return { ok: false, error: "Throttle ativo", throttled: true };
  }

  const cookies = await readCookies();
  if (!cookies.length) {
    return { ok: false, error: "Nenhum cookie encontrado para o domínio" };
  }

  const payload = buildPayload({
    url: tabUrl || "",
    cookies,
    capturedAt: new Date().toISOString(),
  });

  let res;
  try {
    res = await postWebhook(webhookUrl, payload);
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }

  if (res.status >= 200 && res.status < 300) {
    await chrome.storage.local.set({ lastSentAt: Date.now() });
    return { ok: true, status: res.status };
  }
  return { ok: false, error: `HTTP ${res.status}`, status: res.status };
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  const url = tab && tab.url;
  if (!url || !isTargetUrl(url)) return;
  const result = await sendCookies({ tabUrl: url, force: false });
  if (!result.ok && !result.throttled) {
    console.warn("capturador-cookie auto-send:", result.error);
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg && msg.type === "SEND_NOW") {
      sendResponse(await sendCookies({ tabUrl: msg.url || "", force: true }));
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
```

- [ ] **Step 2: Reload extension in Chrome**

`chrome://extensions` → Reload on the extension card. Open service worker “Inspect” — no boot errors.

- [ ] **Step 3: Commit (optional)**

```powershell
git add background.js
git commit -m "feat: add background auto-send and message API"
```

---

### Task 4: Options page

**Files:**
- Create: `C:\Users\svetlana\Desktop\capturador-de-cookie\options.html`
- Create: `C:\Users\svetlana\Desktop\capturador-de-cookie\options.js`

**Interfaces:**
- Consumes: `CapturadorCookie.validateWebhookUrl`, `DEFAULT_INTERVAL_HOURS`; messages `SEND_NOW` / `GET_STATUS`
- Produces: persisted settings + optional host permission for webhook origin

- [ ] **Step 1: Write `options.html`**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <title>Capturador de Cookie — Opções</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 560px; margin: 2rem auto; padding: 0 1rem; }
    label { display: block; margin-top: 1rem; font-weight: 600; }
    input { width: 100%; padding: 0.5rem; box-sizing: border-box; }
    .row { margin-top: 1rem; display: flex; gap: 0.5rem; }
    button { padding: 0.5rem 1rem; cursor: pointer; }
    #status { margin-top: 1rem; min-height: 1.5em; }
    .muted { color: #555; }
  </style>
</head>
<body>
  <h1>Capturador de Cookie</h1>
  <p class="muted">Sessão sua em example.com → POST no webhook (throttle padrão 12h).</p>

  <label for="webhookUrl">URL do webhook</label>
  <input id="webhookUrl" type="url" placeholder="https://…" autocomplete="off" />

  <label for="intervalHours">Intervalo (horas)</label>
  <input id="intervalHours" type="number" min="1" step="1" />

  <p class="muted">Último envio: <span id="lastSent">nunca</span></p>

  <div class="row">
    <button id="save" type="button">Salvar</button>
    <button id="sendNow" type="button">Enviar agora</button>
  </div>
  <p id="status"></p>

  <script src="lib/capturador-cookie.js"></script>
  <script src="options.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `options.js`**

```js
const { validateWebhookUrl, DEFAULT_INTERVAL_HOURS } = CapturadorCookie;

const el = {
  webhookUrl: document.getElementById("webhookUrl"),
  intervalHours: document.getElementById("intervalHours"),
  lastSent: document.getElementById("lastSent"),
  status: document.getElementById("status"),
  save: document.getElementById("save"),
  sendNow: document.getElementById("sendNow"),
};

function setStatus(text) {
  el.status.textContent = text || "";
}

function formatLastSent(ts) {
  const n = Number(ts) || 0;
  if (!n) return "nunca";
  try {
    return new Date(n).toLocaleString("pt-BR");
  } catch {
    return String(n);
  }
}

async function refresh() {
  const data = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  el.webhookUrl.value = data.webhookUrl || "";
  el.intervalHours.value = data.intervalHours != null ? data.intervalHours : DEFAULT_INTERVAL_HOURS;
  el.lastSent.textContent = formatLastSent(data.lastSentAt);
}

el.save.addEventListener("click", async () => {
  const rawUrl = el.webhookUrl.value.trim();
  const hours = Number(el.intervalHours.value);
  const checked = validateWebhookUrl(rawUrl);
  if (!checked.ok) {
    setStatus(checked.error);
    return;
  }
  if (!Number.isFinite(hours) || hours < 1) {
    setStatus("Intervalo deve ser um número ≥ 1");
    return;
  }

  try {
    const granted = await chrome.permissions.request({
      origins: [checked.originPattern],
    });
    if (!granted) {
      setStatus("Permissão do host do webhook negada");
      return;
    }
  } catch (e) {
    setStatus("Falha ao pedir permissão: " + (e.message || e));
    return;
  }

  await chrome.storage.local.set({
    webhookUrl: rawUrl,
    intervalHours: hours,
  });
  await refresh();
  setStatus("Salvo");
});

el.sendNow.addEventListener("click", async () => {
  setStatus("Enviando…");
  const result = await chrome.runtime.sendMessage({
    type: "SEND_NOW",
    url: "https://www.example.com/app",
  });
  await refresh();
  if (result && result.ok) {
    setStatus("Enviado (HTTP " + result.status + ")");
  } else {
    setStatus((result && result.error) || "Falha no envio");
  }
});

refresh().catch((e) => setStatus(String(e)));
```

- [ ] **Step 3: Manual verify options**

1. Reload extension.
2. Right-click extension → Opções.
3. Paste a test webhook (e.g. `https://webhook.site/<uuid>`).
4. Salvar → allow permission prompt.
5. While logged into example.com in Chrome, click **Enviar agora**.
6. Confirm JSON on the webhook receiver includes `cookies` and `cookieHeader`.

- [ ] **Step 4: Commit (optional)**

```powershell
git add options.html options.js
git commit -m "feat: add options page for webhook config and send now"
```

---

### Task 5: README + end-to-end checklist

**Files:**
- Create: `C:\Users\svetlana\Desktop\capturador-de-cookie\README.md`

**Interfaces:**
- Consumes: finished extension from Tasks 1–4
- Produces: install docs + privacy note matching the spec

- [ ] **Step 1: Write README**

Create `C:\Users\svetlana\Desktop\capturador-de-cookie\README.md`:

````markdown
# Capturador de Cookie

Extensão Chrome (MV3) para **a sua** sessão em `www.example.com`: lê cookies e envia um POST JSON para um webhook que você configura. Útil para renovar sessão em automações (n8n, API própria, etc.).

## Instalação

1. Abra `chrome://extensions`
2. Ative **Modo do desenvolvedor**
3. **Carregar sem compactação** → pasta `C:\Users\svetlana\Desktop\capturador-de-cookie`
4. Abra **Opções** da extensão

## Configuração

1. Cole a URL do webhook
2. Intervalo em horas (padrão 12)
3. **Salvar** (aceite a permissão do host do webhook)
4. **Enviar agora** para testar

## Comportamento

- Ao carregar qualquer página em `https://www.example.com/*`, tenta enviar se o throttle expirou
- Só atualiza “último envio” se o webhook responder HTTP 2xx
- Cookies apenas do domínio `example.com`

## Testes unitários (helpers)

No PowerShell:

    node "C:\Users\svetlana\Desktop\capturador-de-cookie\tests\capturador-cookie.test.js"

## Privacidade

Uso local, sessão do operador, destino do webhook sob responsabilidade de quem configurou. Não publique na Chrome Web Store sem revisão de política.
````

- [ ] **Step 2: Run helper tests again**

```powershell
node "C:\Users\svetlana\Desktop\capturador-de-cookie\tests\capturador-cookie.test.js"
```

Expected: PASS.

- [ ] **Step 3: E2E checklist (manual)**

- [ ] Options save webhook + interval
- [ ] Enviar agora delivers payload with cookies + `cookieHeader`
- [ ] After successful send, reload example.com tab → auto-send skipped (throttle)
- [ ] Failed POST does not advance `lastSentAt` (optional: point webhook at a closed port and confirm)

- [ ] **Step 4: Commit (optional)**

```powershell
git add README.md
git commit -m "docs: add README for cookie webhook extension"
```

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|------------------|------|
| MV3 + background + options | 2, 3, 4 |
| Cookies only `example.com` | 1, 3 |
| Configurable webhook | 4 |
| Default 12h throttle | 1, 3, 4 |
| Enviar agora skips throttle | 3, 4 |
| Zero cookies auto skip / Send now warn no POST | 3 |
| `lastSentAt` only on 2xx | 3 |
| Payload shape + `cookieHeader` | 1, 3 |
| Optional host permission for webhook | 2, 4 |
| README privacy + load unpacked | 5 |
| Helper tests | 1, 5 |

No TBD placeholders. Signatures aligned: `SEND_NOW` / `GET_STATUS`, `CapturadorCookie` global + `module.exports`.
```

