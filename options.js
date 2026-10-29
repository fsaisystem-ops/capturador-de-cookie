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
    url: CapturadorCookie.TARGET_REQUEST_URL,
  });
  await refresh();
  if (result && result.ok) {
    setStatus("Enviado (HTTP " + result.status + ")");
  } else {
    setStatus((result && result.error) || "Falha no envio");
  }
});

refresh().catch((e) => setStatus(String(e)));
