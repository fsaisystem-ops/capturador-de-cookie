# Arquitetura — Capturador de Cookie

## Visão geral

```
[Chrome: login example.com]
        │
        ├─ Set-Cookie / jar do browser
        │
        ├─ GET /app (main_frame)
        │         │
        │         ▼
        │  webRequest.onBeforeSendHeaders
        │  (lê header Cookie + extraHeaders)
        │         │
        ├─ cookies.onChanged (domínio alvo)
        │         │
        └─ tabs.onUpdated (host alvo)
                  │
                  ▼
           background.js (debounce 2,5s)
                  │
                  ├─ preferir lastNetworkCapture.cookieHeader
                  └─ senão cookies.getAll({ url: /app })
                  │
                  ▼
           buildPayload() → POST JSON → webhookUrl
                  │
                  ▼
           storage: lastSentAt, lastCookieHeader (só se HTTP 2xx)
```

## Componentes

| Peça | Papel |
|------|--------|
| `manifest.json` | MV3; `cookies`, `storage`, `tabs`, `webRequest`; host de exemplo; optional hosts para webhook |
| `background.js` | Orquestra captura, debounce, throttle, POST, mensagens |
| `lib/capturador-cookie.js` | Funções puras: URL alvo, throttle, parse/build payload (UMD: Node + `globalThis.CapturadorCookie`) |
| `options.html` / `options.js` | Configuração e `SEND_NOW` / `GET_STATUS` |

## Constantes relevantes

- Host: `www.example.com`
- URL de captura: `https://www.example.com/app`
- Domínio de cookie: `example.com`
- Debounce: 2500 ms
- Intervalo padrão (reload sem force): 12 h

## Mensagens runtime

| type | Direção | Efeito |
|------|---------|--------|
| `GET_STATUS` | options → background | Devolve `webhookUrl`, `intervalHours`, `lastSentAt`, `lastCookieHeader` |
| `SEND_NOW` | options → background | `sendCookies({ force: true, reason: "send-now" })` |

## Por que `webRequest` + `extraHeaders`

`document.cookie` e leituras parciais não veem HttpOnly.  
`getAll({ domain })` às vezes devolve jar incompleto para o que o browser **efetivamente envia** na navegação.  
O listener em `onBeforeSendHeaders` no `main_frame` de `/app` lê o header `Cookie` idêntico ao painel Network.

## Domínio e subdomínio

Três camadas diferentes no código:

1. **`TARGET_HOST` / `isTargetUrl` / `isCaptureUrl`** — hostname **exato** (ex.: `www.example.com`). Um `GET` em `app.example.com` não passa nesse filtro.
2. **`COOKIE_DOMAIN` (`example.com`)** — usado em `cookies.onChanged` / pertencimento do cookie. Cookie com domínio `.example.com` casa com subdomínios; cookie host-only de `www` **não** é o mesmo jar que host-only de `app`.
3. **`TARGET_REQUEST_URL` + `webRequest` `urls`** — definem de **qual** request o header `Cookie` é lido. Tem que ser o mesmo host/path que você copia do Network.

```
example.com          → apex (domínio principal)
www.example.com      → subdomínio
app.example.com      → outro subdomínio (outro host_permissions / outro pattern)
.example.com (Domain do Set-Cookie) → compartilhado entre apex e subdomínios
host-only            → preso a um host só
```

Se a captura “vem incompleta”, compare no Network o host do document request com `TARGET_HOST` e com o `Domain` de cada cookie no Application → Cookies.

## Segurança / limites

- A extensão **não** modifica requests do example.com (listener só observa).
- A extensão **não** grava cookies no perfil do usuário em produção.
- O POST do webhook usa a URL configurada; a permissão do host é pedida no **Salvar**.
- Service worker pode dormir; o próximo evento (navegação / cookie / Enviar agora) acorda o fluxo.


