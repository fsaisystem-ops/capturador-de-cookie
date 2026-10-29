# Capturador de Cookie — Design Spec

**Date:** 2026-10-29  
**Project path:** `C:\Users\svetlana\Desktop\capturador-de-cookie`  
**Status:** Ready for user file review (chat design approved; self-review done)

## 1. Goal

Chrome extension (Manifest V3) that, for the user's own session on example.com Web, reads cookies for `example.com` and POSTs them to a user-configured webhook. Used for debug / session renewal automation: after the user logs in again, the extension can forward the new session to a backend (n8n, custom API, etc.).

**Out of scope for v1:** Firefox, polished popup UI, payload encryption, multi-domain lists, Chrome Web Store publish, silent capture of third-party sessions.

**Use constraint:** Only the operator's own cookies / authorized automation. Not for stealing other people's sessions.

## 2. Target site

- Host: `www.example.com`
- Cookie domain scope: `example.com` (covers host and related subdomains as returned by `chrome.cookies`)
- Typical path after login: `/app` (any path on that host may trigger the check)

## 3. Architecture

| Piece | Role |
|-------|------|
| `manifest.json` | MV3, permissions, options page, background service worker |
| `background.js` | On tab complete for target host → throttle → read cookies → POST webhook |
| `options.html` / `options.js` | Webhook URL, interval hours, last-sent display, Save, Send now |
| `chrome.storage.local` | `webhookUrl`, `intervalHours`, `lastSentAt` |
| `README.md` | Install (Load unpacked), config, privacy note |

### Data flow

1. User opens or reloads a URL on `https://www.example.com/*`.
2. Service worker handles `chrome.tabs.onUpdated` with `status === "complete"` and matching host.
3. If `webhookUrl` is missing → no-op.
4. If `Date.now() - lastSentAt < intervalHours * 3600 * 1000` → no-op (default interval 12).
5. Else `chrome.cookies.getAll` for domain `example.com`.
6. If no cookies → no-op on automatic path.
7. POST JSON to webhook; on HTTP 2xx set `lastSentAt = Date.now()`.
8. On network / non-2xx → do **not** update `lastSentAt` (retry on next qualifying load).

**Send now** (options page): same cookie read + POST, **skips** throttle; on 2xx updates `lastSentAt`. If zero cookies → do not POST; show warning in options (v1).

## 4. Permissions

Declared / used:

- `cookies` — read cookies for example.com
- `storage` — persist settings and `lastSentAt`
- `tabs` — `tabs.onUpdated` + tab URL

Host permission:

- `https://www.example.com/*`

Webhook host:

- On Save of webhook URL, call `chrome.permissions.request` for that origin (e.g. `https://hooks.example.com/*`) so the extension does not ship with blanket `https://*/*` if avoidable.
- If optional-permissions flow is awkward in practice, fallback documented in plan: `host_permissions` entry for known webhook patterns or user-added origin in manifest during local use.

## 5. Storage schema

```json
{
  "webhookUrl": "https://…",
  "intervalHours": 12,
  "lastSentAt": 0
}
```

- `intervalHours` default: `12`
- `lastSentAt` default: `0` (never sent)

## 6. Webhook payload

```json
{
  "source": "capturador-de-cookie",
  "host": "www.example.com",
  "url": "<tab url at capture time>",
  "capturedAt": "<ISO-8601>",
  "cookies": [
    {
      "name": "",
      "value": "",
      "domain": "",
      "path": "",
      "secure": true,
      "httpOnly": true,
      "expirationDate": null
    }
  ],
  "cookieHeader": "name=value; name2=value2"
}
```

- Content-Type: `application/json`
- Method: `POST`
- No auth headers in v1 (webhook URL may embed a secret token if the user wants)

## 7. Options UI

- Input: Webhook URL  
- Input: Interval (hours), default 12  
- Read-only: Last sent (locale string or “nunca”)  
- Button: Salvar — validate URL, request host permission, write storage  
- Button: Enviar agora — force send, skip throttle  
- Status line: saved / sent / error message  

## 8. Error handling

| Case | Behavior |
|------|----------|
| Empty webhook | No automatic send; options explain missing URL |
| Invalid URL on save | Reject save, show error |
| POST non-2xx / network error | Show error; do not bump `lastSentAt` |
| Zero cookies (auto) | Skip send |
| Zero cookies (Send now) | Do not POST; show warning in options |

## 9. Privacy

- Cookie read limited to `example.com`
- Local unpacked install; no store listing in v1
- Operator owns the webhook endpoint and the session data in transit

## 10. Install / verify

1. Open `chrome://extensions` → Developer mode → Load unpacked → select `C:\Users\svetlana\Desktop\capturador-de-cookie`
2. Open extension Options → paste webhook (e.g. webhook.site) → Salvar → Enviar agora
3. Confirm JSON received
4. Clear or set `lastSentAt` for test; open `https://www.example.com/app` → one auto send; immediate reload must not send again until interval elapses (unless Enviar agora)

## 11. File layout (v1)

```
C:\Users\svetlana\Desktop\capturador-de-cookie\
  manifest.json
  background.js
  options.html
  options.js
  README.md
  docs\superpowers\specs\2026-10-29-capturador-de-cookie-design.md
```

## 12. Success criteria

- [ ] Options save webhook URL and interval
- [ ] Enviar agora delivers payload to webhook with cookies + `cookieHeader`
- [ ] Automatic send on target host respects 12h (configurable) throttle
- [ ] Failed POST does not advance throttle
- [ ] README documents load unpacked + privacy scope

