import { isAllowedUrl, MAX_RESULT_BYTES, parseOrigin, READ_ACTIONS, validateCommand } from "./protocol.js";

let inFlight = null;
let pollTimer = null;
let pollFailures = 0;
const pollIntervalMs = 2000;
const alarmName = "browser-agent-poll";
const defaults = { enabled: false, confirmChanges: true, relay: "", token: "", origin: "", tabId: null };

async function initialize() {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  if (!await chrome.alarms.get(alarmName)) await chrome.alarms.create(alarmName, { periodInMinutes: 0.5 });
}

async function api(config, path, data) {
  const response = await fetch(config.relay + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(data || {}), credentials: "omit", redirect: "error",
    signal: AbortSignal.timeout(12_000), cache: "no-store"
  });
  if (!response.ok) {
    const error = new Error(`Посредник: HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function badge(text, color = "#b45309") {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

async function persist(journal) {
  await chrome.storage.local.set({ journal });
}

async function completed(journal, status, result) {
  let outcome = { status, result };
  if (new TextEncoder().encode(JSON.stringify(outcome)).length > MAX_RESULT_BYTES - 1000) {
    outcome = { status: "failed", result: { error: "Результат слишком большой. Запросите меньший HTML-блок." } };
  }
  const next = { ...journal, phase: "completed", outcome };
  await persist(next);
  return next;
}

async function report(journal) {
  try {
    await api(journal.connection, `/api/device/jobs/${journal.job.id}/result`, journal.outcome);
  } catch (error) {
    if (error.status !== 409) throw error;
    // The server expired the job; do not execute it or resend it as a new job.
  }
  await chrome.storage.local.set({
    journal: null,
    lastError: null,
    last: { id: journal.job.id, status: journal.outcome.status, at: Date.now() }
  });
  await badge("");
}

async function execute(config, journal) {
  const command = validateCommand(journal.job.command);
  const { config: current } = await chrome.storage.local.get("config");
  if (!current?.enabled || current.tabId !== config.tabId || current.origin !== config.origin ||
      current.relay !== config.relay || current.token !== config.token) {
    throw new Error("Управление остановлено или настройки изменились.");
  }
  const tab = await chrome.tabs.get(config.tabId);
  if (!isAllowedUrl(tab.url, config.origin) || (tab.pendingUrl && !isAllowedUrl(tab.pendingUrl, config.origin))) {
    throw new Error("Выбранная вкладка ушла с разрешённого сайта.");
  }
  if (command.action === "navigate") {
    if (!isAllowedUrl(command.url, config.origin)) throw new Error("Переход за пределы разрешённого сайта запрещён.");
    await chrome.tabs.update(config.tabId, { url: command.url });
    return { dispatched: true, notice: "Переход запущен. Запросите get_page после загрузки." };
  }
  await chrome.scripting.executeScript({ target: { tabId: config.tabId, frameIds: [0] }, files: ["content.js"] });
  const reply = await chrome.tabs.sendMessage(config.tabId, {
    type: "agent-execute", origin: config.origin, command
  }, { frameId: 0 });
  if (!reply?.ok) throw new Error(reply?.error || "Нет ответа от страницы.");
  return reply.result;
}

async function poll() {
  await initialize();
  let { config: saved, journal } = await chrome.storage.local.get(["config", "journal"]);
  const config = { ...defaults, ...saved };
  if (journal?.phase === "completed") {
    await report(journal);
    return;
  }
  if (journal?.phase === "executing") {
    journal = await completed(journal, "failed", {
      error: "Расширение перезапустилось во время действия. Результат неизвестен; автоматического повтора не будет."
    });
    await report(journal);
    return;
  }
  if (!config.enabled) {
    if (journal) await report(await completed(journal, "failed", { error: "Управление остановлено пользователем." }));
    return;
  }
  if (!config.relay || !config.token || !config.origin || !Number.isInteger(config.tabId)) {
    throw new Error("Укажите посредника, ключ, сайт и вкладку.");
  }
  if (!journal) {
    const { job } = await api(config, "/api/device/next");
    await chrome.storage.local.set({ lastError: null });
    if (!job) { await badge(""); return; }
    journal = {
      job,
      phase: READ_ACTIONS.has(job.command.action) || !config.confirmChanges ? "approved" : "approval",
      connection: { relay: config.relay, token: config.token },
      binding: { tabId: config.tabId, origin: config.origin }
    };
    // Persist the claim BEFORE doing anything to the site.
    await persist(journal);
  }
  if (journal.binding.tabId !== config.tabId || journal.binding.origin !== config.origin ||
      journal.connection.relay !== config.relay || journal.connection.token !== config.token) {
    await report(await completed(journal, "failed", { error: "Настройки подключения или вкладка изменились." }));
    return;
  }
  if (!Number.isFinite(journal.job.deadline) || journal.job.deadline <= Date.now()) {
    await report(await completed(journal, "failed", { error: "Время выполнения/подтверждения истекло." }));
    return;
  }
  if (journal.phase === "approval") { await badge("?"); return; }
  journal.phase = "executing";
  await persist(journal);
  try {
    journal = await completed(journal, "succeeded", await execute(config, journal));
  } catch (error) {
    journal = await completed(journal, "failed", { error: error.message });
  }
  await report(journal);
}

function tick() {
  if (inFlight) return inFlight;
  clearTimeout(pollTimer);
  pollTimer = null;
  inFlight = poll().then((result) => {
    pollFailures = 0;
    return result;
  }).catch(async (error) => {
    pollFailures = Math.min(pollFailures + 1, 5);
    await chrome.storage.local.set({ lastError: { message: error.message, at: Date.now() } });
    await badge("!");
    return { error: error.message };
  }).finally(async () => {
    try {
      const { config, journal } = await chrome.storage.local.get(["config", "journal"]);
      // Keep delivery retries even after Stop, but never claim new jobs while disabled.
      if (config?.enabled || journal) {
        pollTimer = setTimeout(() => { void tick(); }, Math.min(30000, pollIntervalMs * 2 ** pollFailures));
      }
    } finally { inFlight = null; }
  });
  return inFlight;
}

chrome.runtime.onInstalled.addListener(() => { void tick(); });
chrome.runtime.onStartup.addListener(() => { void tick(); });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === alarmName) void tick(); });
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Only our own settings page can approve, stop, configure or wake the agent.
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("options.html")) return;
  const work = async () => {
    if (message.type === "tick") {
      const result = await tick();
      if (result?.error) throw new Error(result.error);
    } else if (message.type === "configure") {
      if (inFlight) await inFlight;
      const c = message.config;
      const relay = parseOrigin(c.relay), origin = parseOrigin(c.origin);
      if (typeof c.token !== "string" || c.token.length < 32 || !Number.isInteger(c.tabId)) throw new Error("Проверьте ключ и вкладку.");
      const tab = await chrome.tabs.get(c.tabId);
      if (!isAllowedUrl(tab.url, origin)) throw new Error("Вкладка не соответствует разрешённому сайту.");
      const granted = await chrome.permissions.contains({ origins: [`${relay}/*`, `${origin}/*`] });
      if (!granted) throw new Error("Не предоставлены разрешения на выбранные адреса.");
      await chrome.storage.local.set({
        config: { relay, origin, token: c.token, tabId: c.tabId, enabled: c.enabled === true, confirmChanges: c.confirmChanges !== false },
        lastError: null
      });
    } else if (message.type === "stop") {
      // Write immediately: already dispatched clicks/requests cannot be undone.
      const { config } = await chrome.storage.local.get("config");
      await chrome.storage.local.set({ config: { ...config, enabled: false } });
    } else if (["approve", "reject"].includes(message.type)) {
      if (inFlight) await inFlight;
      const { journal } = await chrome.storage.local.get("journal");
      if (!journal || journal.phase !== "approval" || journal.job.id !== message.id) throw new Error("Подтверждение устарело.");
      if (message.type === "approve") await persist({ ...journal, phase: "approved" });
      else await completed(journal, "failed", { error: "Пользователь отклонил действие." });
    } else throw new Error("Неизвестное сообщение.");
    if (message.type !== "tick") void tick();
    return { ok: true };
  };
  work().then(respond, (error) => respond({ ok: false, error: error.message }));
  return true;
});

// Restart the fast loop whenever Chrome wakes this service worker.
// The alarm remains a fallback if Chrome suspends the worker or the computer sleeps.
pollTimer = setTimeout(() => { void tick(); }, pollIntervalMs);
