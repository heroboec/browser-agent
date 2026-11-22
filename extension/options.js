import { parseOrigin, isAllowedUrl } from "./protocol.js";
import { checkRelease, parseRepository } from "./updates.js";
import { createFastPoller } from "./fast-poll.js";
const $ = (id) => document.getElementById(id);
let approvalId = null;

async function send(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...extra });
  if (!response?.ok) throw new Error(response?.error || "Нет ответа от расширения.");
}

async function tabs(selected) {
  const previous = selected ?? Number($("tab").value);
  const origin = $("origin").value;
  $("tab").replaceChildren();
  for (const tab of await chrome.tabs.query({})) {
    if (!tab.url || (origin && !isAllowedUrl(tab.url, parseOrigin(origin)))) continue;
    const option = document.createElement("option");
    option.value = tab.id;
    option.textContent = `${tab.title || "Вкладка"} — ${new URL(tab.url).origin}${new URL(tab.url).pathname}`;
    $("tab").append(option);
  }
  if (previous) $("tab").value = String(previous);
  if (!$("tab").value && $("tab").options.length) $("tab").selectedIndex = 0;
}

async function render() {
  const { config, journal, last, lastError } = await chrome.storage.local.get(["config", "journal", "last", "lastError"]);
  $("status").textContent = JSON.stringify({
    управление: config?.enabled ? "включено" : "выключено",
    вкладка: config?.tabId || null,
    задание: journal ? { id: journal.job.id, фаза: journal.phase, до: new Date(journal.job.deadline).toLocaleTimeString() } : null,
    последнее: last || null,
    ошибка: lastError || null
  }, null, 2);
  approvalId = journal?.phase === "approval" ? journal.job.id : null;
  $("approval").hidden = !approvalId;
  $("command").textContent = approvalId ? JSON.stringify({
    сайт: journal.binding.origin, вкладка: journal.binding.tabId, команда: journal.job.command
  }, null, 2) : "";
}

function run(fn) {
  return async (event) => {
    event?.preventDefault();
    try { await fn(); $("message").textContent = "Готово."; }
    catch (error) { $("message").textContent = error.message; }
    await render();
  };
}

$("settings").addEventListener("submit", run(async () => {
  const relay = parseOrigin($("relay").value), origin = parseOrigin($("origin").value);
  const granted = await chrome.permissions.request({ origins: [`${relay}/*`, `${origin}/*`] });
  if (!granted) throw new Error("Нужно разрешить доступ к посреднику и выбранному сайту.");
  await send("configure", { config: {
    relay, origin, token: $("token").value.trim(), tabId: Number($("tab").value),
    confirmChanges: $("confirmChanges").checked, enabled: $("enabled").checked
  } });
}));
$("refresh").addEventListener("click", run(() => tabs()));
$("origin").addEventListener("change", run(() => tabs()));
$("poll").addEventListener("click", run(() => send("tick")));
$("stop").addEventListener("click", run(async () => { fastPoller.stop(); await send("stop"); $("enabled").checked = false; }));
$("approve").addEventListener("click", run(() => send("approve", { id: approvalId })));
$("reject").addEventListener("click", run(() => send("reject", { id: approvalId })));
chrome.storage.onChanged.addListener(() => { void render(); });

const fastPoller = createFastPoller({
  async poll() {
    const { config, journal } = await chrome.storage.local.get(["config", "journal"]);
    if (!config?.enabled) { fastPoller.stop(); return; }
    if (journal?.phase !== "approval") await send("tick");
  },
  onStop() { $("fast-poll").checked = false; }
});
$("fast-poll").addEventListener("change", () => {
  if ($("fast-poll").checked) fastPoller.start();
  else fastPoller.stop();
});
window.addEventListener("pagehide", () => fastPoller.stop());

const currentVersion = chrome.runtime.getManifest().version;
$("current-version").textContent = currentVersion;
$("check-updates").addEventListener("click", async () => {
  const button = $("check-updates"), result = $("update-result");
  button.disabled = true;
  result.textContent = "Проверяю…";
  try {
    const repository = parseRepository($("update-repository").value);
    const granted = await chrome.permissions.request({ origins: ["https://api.github.com/*"] });
    if (!granted) throw new Error("Для проверки нужен доступ к API GitHub.");
    await chrome.storage.local.set({ updateRepository: repository });
    const release = await checkRelease(repository, currentVersion);
    result.textContent = release.newer
      ? `Доступна версия ${release.version} (у вас ${currentVersion}). `
      : `Новой версии нет (у вас ${currentVersion}, последний релиз ${release.version}). `;
    const link = document.createElement("a");
    link.href = release.url;
    link.textContent = "Открыть релиз на GitHub";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    result.append(link);
  } catch (error) {
    result.textContent = `Не удалось проверить обновления: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});

async function initialize() {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  const { config = {} } = await chrome.storage.local.get("config");
  const { updateRepository = "heroboec/browser-agent" } = await chrome.storage.local.get("updateRepository");
  $("update-repository").value = updateRepository;
  for (const key of ["relay", "origin", "token"]) $(key).value = config[key] || "";
  $("enabled").checked = config.enabled === true;
  $("confirmChanges").checked = config.confirmChanges !== false;
  await tabs(config.tabId);
  await render();
}
initialize().catch((error) => { $("message").textContent = error.message; });
