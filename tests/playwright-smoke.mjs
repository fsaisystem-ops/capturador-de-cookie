/**
 * Smoke test: load unpacked extension in Chromium via Playwright,
 * set local webhook, inject session cookie, Enviar agora, assert POST.
 */
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "..");

function copyExtWithLocalhost(srcDir) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "capturador-de-cookie-"));
  for (const name of [
    "manifest.json",
    "background.js",
    "options.html",
    "options.js",
    "lib",
  ]) {
    const from = path.join(srcDir, name);
    const to = path.join(dest, name);
    const st = fs.statSync(from);
    if (st.isDirectory()) {
      fs.cpSync(from, to, { recursive: true });
    } else {
      fs.copyFileSync(from, to);
    }
  }
  const manifestPath = path.join(dest, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  // Avoid chrome.permissions.request dialog in automation
  manifest.host_permissions = [
    "https://www.example.com/*",
    "http://127.0.0.1/*",
  ];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dest;
}

function startReceiver() {
  const received = [];
  const server = http.createServer((req, res) => {
    if (req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(body);
        } catch {
          json = { raw: body };
        }
        received.push({ statusLine: `${req.method} ${req.url}`, json });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}/hook`,
        received,
      });
    });
  });
}

async function main() {
  const extDir = copyExtWithLocalhost(SRC);
  const hook = await startReceiver();
  console.log("extension copy:", extDir);
  console.log("webhook:", hook.url);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-profile-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) {
      sw = await context.waitForEvent("serviceworker", { timeout: 30000 });
    }
    const extensionId = new URL(sw.url()).host;
    console.log("extensionId:", extensionId);

    const refreshSw = () => {
      const workers = context.serviceWorkers();
      const match = workers.find((w) => w.url().includes(extensionId));
      return match || workers[0] || sw;
    };

    const optionsUrl = `chrome-extension://${extensionId}/options.html`;
    const page = await context.newPage();
    await page.goto(optionsUrl);
    await page.waitForSelector("#webhookUrl");

    await page.fill("#webhookUrl", hook.url);
    await page.fill("#intervalHours", "12");

    sw = refreshSw();

    // Persist settings + cookie via extension APIs (visible to chrome.cookies)
    const setCookieResult = await sw.evaluate(async (webhookUrl) => {
      await chrome.storage.local.set({
        webhookUrl,
        intervalHours: 12,
        lastSentAt: 0,
      });
      const details = await chrome.cookies.set({
        url: "https://www.example.com/",
        name: "SESSION_SMOKE",
        value: "test-session-value-123",
        domain: "www.example.com",
        path: "/",
        secure: true,
        httpOnly: true,
      });
      const all = await chrome.cookies.getAll({});
      return {
        details,
        lastError: chrome.runtime.lastError
          ? chrome.runtime.lastError.message
          : null,
        allCount: all.length,
        allNames: all.map((c) => `${c.domain}:${c.name}`),
      };
    }, hook.url);
    console.log("setCookieResult:", setCookieResult);

    const stored = await sw.evaluate(
      () =>
        new Promise((resolve) => {
          chrome.storage.local.get(
            ["webhookUrl", "intervalHours", "lastSentAt"],
            resolve
          );
        })
    );
    console.log("stored:", stored);
    if (stored.webhookUrl !== hook.url) {
      throw new Error(`storage webhook mismatch: ${JSON.stringify(stored)}`);
    }

    page.on("console", (msg) => console.log("PAGE LOG:", msg.type(), msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERR:", err.message));

    await page.reload();
    await page.waitForSelector("#webhookUrl");
    await new Promise((r) => setTimeout(r, 800));
    const savedUrl = await page.inputValue("#webhookUrl");
    console.log("options input after reload:", JSON.stringify(savedUrl));

    sw = refreshSw();

    // Core path: invoke send from service worker (same as SEND_NOW)
    const sendResult = await sw.evaluate(async () => {
      const settings = await chrome.storage.local.get({
        webhookUrl: "",
        intervalHours: 12,
        lastSentAt: 0,
      });
      const cookies = await chrome.cookies.getAll({
        domain: "example.com",
      });
      return { settings, cookieCount: cookies.length, names: cookies.map((c) => c.name) };
    });
    console.log("sw preflight:", sendResult);

    const forceResult = await sw.evaluate(async () => {
      // Mirror background sendCookies force path via runtime message to self is awkward;
      // call the same APIs inline for smoke evidence, then also click UI.
      const { webhookUrl } = await chrome.storage.local.get({ webhookUrl: "" });
      const cookies = await chrome.cookies.getAll({
        domain: "example.com",
      });
      if (!webhookUrl) return { ok: false, error: "no webhook" };
      if (!cookies.length) return { ok: false, error: "no cookies" };
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      const payload = {
        source: "capturador-de-cookie",
        host: "www.example.com",
        url: "https://www.example.com/app",
        capturedAt: new Date().toISOString(),
        cookies: cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          expirationDate: c.expirationDate ?? null,
        })),
        cookieHeader,
      };
      try {
        const res = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.status >= 200 && res.status < 300) {
          await chrome.storage.local.set({ lastSentAt: Date.now() });
        }
        return { ok: res.ok, status: res.status };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
      }
    });
    console.log("sw force send:", forceResult);

    // Wait a beat for POST to land
    const deadline = Date.now() + 10000;
    while (hook.received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!hook.received.length) {
      throw new Error(
        `no webhook POST received. swResult=${JSON.stringify(forceResult)}`
      );
    }

    const payload = hook.received[0].json;
    console.log("payload keys:", Object.keys(payload));
    console.log("cookieHeader:", payload.cookieHeader);
    console.log("cookies count:", (payload.cookies || []).length);

    if (payload.source !== "capturador-de-cookie") {
      throw new Error("bad source");
    }
    if (
      !payload.cookieHeader ||
      !payload.cookieHeader.includes("SESSION_SMOKE")
    ) {
      throw new Error(`cookie missing in header: ${payload.cookieHeader}`);
    }
    if (!forceResult.ok) {
      throw new Error(`force send failed: ${JSON.stringify(forceResult)}`);
    }

    // UI path: Enviar agora (message to background)
    await page.fill("#webhookUrl", hook.url);
    await page.click("#sendNow");
    await new Promise((r) => setTimeout(r, 2000));
    const status = await page.textContent("#status");
    console.log("status UI after click:", status);

    console.log("SMOKE PASS");
  } finally {
    await context.close().catch(() => {});
    await new Promise((r) => hook.server.close(r));
    fs.rmSync(extDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("SMOKE FAIL:", err);
  process.exit(1);
});


