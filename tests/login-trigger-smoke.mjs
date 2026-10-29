import fs from "fs";
import path from "path";
import os from "os";
import { chromium } from "playwright";

const WEBHOOK =
  process.env.CAPTURADOR_COOKIE_WEBHOOK_URL ||
  "https://webhook.site/00000000-0000-0000-0000-000000000000";
const SRC = process.cwd();

function copyExt(srcDir) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "cw-login-"));
  for (const name of [
    "manifest.json",
    "background.js",
    "options.html",
    "options.js",
    "lib",
  ]) {
    const from = path.join(srcDir, name);
    const to = path.join(dest, name);
    if (fs.statSync(from).isDirectory()) fs.cpSync(from, to, { recursive: true });
    else fs.copyFileSync(from, to);
  }
  const mp = path.join(dest, "manifest.json");
  const m = JSON.parse(fs.readFileSync(mp, "utf8"));
  m.host_permissions = [
    "https://www.example.com/*",
    "https://webhook.site/*",
  ];
  fs.writeFileSync(mp, JSON.stringify(m, null, 2));
  return dest;
}

const extDir = copyExt(SRC);
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-prof-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    "--no-first-run",
  ],
});

let ok = false;
try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 30000 });
  const extensionId = new URL(sw.url()).host;
  console.log("extensionId", extensionId);

  await sw.evaluate(async (webhookUrl) => {
    await chrome.storage.local.set({
      webhookUrl,
      intervalHours: 12,
      lastSentAt: 0,
      lastCookieHeader: "",
    });
  }, WEBHOOK);

  await sw.evaluate(async () => {
    await chrome.cookies.set({
      url: "https://www.example.com/",
      name: "LOGIN_TRIGGER",
      value: "after-login-" + Date.now(),
      domain: "www.example.com",
      path: "/",
      secure: true,
      httpOnly: true,
    });
  });

  console.log("cookie set; waiting debounce + POST (upto 20s)...");
  const deadline = Date.now() + 20000;
  let last = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const workers = context.serviceWorkers();
    const w = workers.find((x) => x.url().includes(extensionId)) || workers[0];
    if (!w) continue;
    last = await w.evaluate(() =>
      chrome.storage.local.get(["lastSentAt", "lastCookieHeader"])
    );
    if (
      last.lastSentAt &&
      last.lastCookieHeader &&
      String(last.lastCookieHeader).includes("LOGIN_TRIGGER")
    ) {
      console.log("LOGIN TRIGGER PASS", last);
      ok = true;
      break;
    }
  }
  if (!ok) {
    console.error("LOGIN TRIGGER FAIL", last);
  }
} finally {
  await context.close().catch(() => {});
  fs.rmSync(extDir, { recursive: true, force: true });
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

process.exit(ok ? 0 : 1);


