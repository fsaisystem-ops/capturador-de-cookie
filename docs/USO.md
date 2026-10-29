# Guia de uso — Capturador de Cookie

## Objetivo

Depois que você faz login no site de exemplo, a extensão manda o `Cookie` da sessão para o seu webhook, para outra ferramenta (n8n, script, etc.) reutilizar a sessão.

## Setup único

1. Instale a extensão (ver README → Instalação).
2. Abra as **Opções**.
3. Preencha a **URL para capturar / monitorar** e o **tipo de domínio** (principal ou subdomínio).
4. Cole a URL do webhook. Se o receptor exigir auth, escolha **Bearer** ou **Header** (nome + valor).
5. Intervalo (ex.: 12) → **Salvar** → aceite as permissões (site + webhook).
6. Clique **Enviar agora** com a sessão aberta na URL monitorada, para validar o receptor.

Checklist no JSON recebido:

- `captureSource` preferencialmente `webRequest`
- `cookieNames` inclui os cookies de sessão do seu site (ex.: `session_id`, `auth_token`, `waf_token`)

## Fluxo diário (renovar sessão)

1. Abra o Chrome com a extensão ativa.
2. Faça login em `https://www.example.com`.
3. Abra ou atualize `https://www.example.com/app`.
4. Em ~2–5 segundos o webhook deve receber o POST.
5. No n8n/API, use o campo `cookieHeader` no header `Cookie` das chamadas.

## Testar com webhook.site

1. Crie uma URL em https://webhook.site
2. Cole nas Opções → Salvar
3. Enviar agora **ou** navegue em `/app`
4. Abra o painel do webhook.site e inspecione o body JSON

## Integrar no n8n (ideia)

1. Trigger: Webhook (método POST).
2. Na URL do nó, use a mesma URL configurada na extensão.
3. Nos nós seguintes, leia `{{ $json.cookieHeader }}` (ou o path equivalente) e injete em HTTP Request → Header `Cookie`.

## Domínio principal vs subdomínio

Se o site abre em `www.example.com` mas o login grava cookie em outro host (ou o contrário), o header do Network **muda**.

- Capture sempre na URL do app que você vai reutilizar (ex.: `https://www.example.com/app`).
- Domínio principal (`example.com`) e subdomínio (`www` / `app`) não são intercambiáveis para cookie **host-only**.
- Ao mudar de host, atualize `TARGET_HOST`, `TARGET_REQUEST_URL`, `host_permissions` e o filtro do `webRequest` (ver README → *Domínio principal vs subdomínio*).

## O que não fazer

- Não usar a extensão para capturar sessão de outra pessoa.
- Não colar cookies reais em issues/commits/chat.
- Não esperar disparo se o webhook estiver vazio ou a permissão do host foi negada.
- Não assumir que cookie visto em `example.com` é o mesmo conjunto enviado em `www.example.com`.


