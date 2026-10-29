const {
  validateWebhookUrl,
  validateCaptureUrl,
  parseCaptureTarget,
  DEFAULT_INTERVAL_HOURS,
  TARGET_REQUEST_URL,
  DOMAIN_MODE_PRINCIPAL,
} = CapturadorCookie;

const WEBHOOK_EXAMPLE = "https://webhook.site/";

const el = {
  captureUrl: document.getElementById("captureUrl"),
  domainMode: document.getElementById("domainMode"),
  domainHint: document.getElementById("domainHint"),
  webhookUrl: document.getElementById("webhookUrl"),
  intervalHours: document.getElementById("intervalHours"),
  lastSent: document.getElementById("lastSent"),
  activeTarget: document.getElementById("activeTarget"),
  status: document.getElementById("status"),
  save: document.getElementById("save"),
  sendNow: document.getElementById("sendNow"),
  copyWebhookExample: document.getElementById("copyWebhookExample"),
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

function updateDomainHint() {
  if (el.domainMode.value === DOMAIN_MODE_PRINCIPAL) {
    el.domainHint.textContent =
      "Domínio principal: abas/cookies sob o domínio registrável (ex.: example.com e www.example.com).";
  } else {
    el.domainHint.textContent =
      "Subdomínio: monitora o host exato da URL (ex.: só www.example.com).";
  }
}

function renderActiveTarget(data) {
  const parsed = parseCaptureTarget(
    data.captureUrl || el.captureUrl.value,
    data.domainMode || el.domainMode.value
  );
  if (!parsed.ok) {
    el.activeTarget.textContent = "—";
    return;
  }
  el.activeTarget.textContent = `${parsed.targetHost} · ${parsed.domainMode} · cookieDomain=${parsed.cookieDomain}`;
}

async function refresh() {
  const data = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  el.captureUrl.value = data.captureUrl || TARGET_REQUEST_URL;
  el.domainMode.value = data.domainMode || "subdominio";
  el.webhookUrl.value = data.webhookUrl || "";
  el.intervalHours.value =
    data.intervalHours != null ? data.intervalHours : DEFAULT_INTERVAL_HOURS;
  el.lastSent.textContent = formatLastSent(data.lastSentAt);
  updateDomainHint();
  renderActiveTarget(data);
}

el.copyWebhookExample.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(WEBHOOK_EXAMPLE);
    setStatus("Link copiado: " + WEBHOOK_EXAMPLE);
  } catch (_) {
    // Fallback if clipboard API is blocked
    const ta = document.createElement("textarea");
    ta.value = WEBHOOK_EXAMPLE;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      setStatus("Link copiado: " + WEBHOOK_EXAMPLE);
    } catch (e) {
      setStatus("Não deu para copiar — selecione o link manualmente");
    }
    ta.remove();
  }
});

el.domainMode.addEventListener("change", () => {
  updateDomainHint();
  renderActiveTarget({
    captureUrl: el.captureUrl.value,
    domainMode: el.domainMode.value,
  });
});

el.captureUrl.addEventListener("input", () => {
  renderActiveTarget({
    captureUrl: el.captureUrl.value,
    domainMode: el.domainMode.value,
  });
});

el.save.addEventListener("click", async () => {
  const captureRaw = el.captureUrl.value.trim();
  const domainMode = el.domainMode.value;
  const rawWebhook = el.webhookUrl.value.trim();
  const hours = Number(el.intervalHours.value);

  const captureCheck = validateCaptureUrl(captureRaw);
  if (!captureCheck.ok) {
    setStatus(captureCheck.error);
    return;
  }
  const target = parseCaptureTarget(captureRaw, domainMode);
  if (!target.ok) {
    setStatus(target.error || "URL de captura inválida");
    return;
  }

  const webhookCheck = validateWebhookUrl(rawWebhook);
  if (!webhookCheck.ok) {
    setStatus(webhookCheck.error);
    return;
  }
  if (!Number.isFinite(hours) || hours < 1) {
    setStatus("Intervalo deve ser um número ≥ 1");
    return;
  }

  try {
    const granted = await chrome.permissions.request({
      origins: [target.originPattern, webhookCheck.originPattern],
    });
    if (!granted) {
      setStatus("Permissão do host (captura ou webhook) negada");
      return;
    }
  } catch (e) {
    setStatus("Falha ao pedir permissão: " + (e.message || e));
    return;
  }

  await chrome.storage.local.set({
    captureUrl: target.captureUrl,
    domainMode: target.domainMode,
    webhookUrl: rawWebhook,
    intervalHours: hours,
  });
  await chrome.runtime.sendMessage({ type: "CONFIG_UPDATED" });
  await refresh();
  setStatus("Salvo");
});

el.sendNow.addEventListener("click", async () => {
  setStatus("Enviando…");
  const captureRaw = el.captureUrl.value.trim() || TARGET_REQUEST_URL;
  const result = await chrome.runtime.sendMessage({
    type: "SEND_NOW",
    url: captureRaw,
  });
  await refresh();
  if (result && result.ok) {
    setStatus("Enviado (HTTP " + result.status + ")");
  } else {
    setStatus((result && result.error) || "Falha no envio");
  }
});

updateDomainHint();
refresh().catch((e) => setStatus(String(e)));
