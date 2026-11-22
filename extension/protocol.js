export const MAX_RESULT_BYTES = 180_000;
export const JOB_TTL_MS = 5 * 60_000;
export const RUN_TTL_MS = 3 * 60_000;
export const READ_ACTIONS = new Set(["get_page", "get_html"]);
const ACTIONS = new Set([...READ_ACTIONS, "click", "fill", "select", "navigate"]);

export function parseOrigin(value) {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
    throw new Error("Нужен HTTPS (HTTP допустим только на localhost).");
  }
  return url.origin;
}

export function validateCommand(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !ACTIONS.has(input.action)) {
    throw new Error("Неизвестная команда.");
  }
  const out = { action: input.action };
  const string = (key, max = 200) => {
    if (typeof input[key] !== "string" || !input[key] || input[key].length > max) {
      throw new Error(`Некорректное поле ${key}.`);
    }
    return input[key];
  };
  if (["click", "fill", "select"].includes(out.action)) {
    out.snapshot = string("snapshot");
    out.element = string("element");
    if (!/^e[1-9]\d*$/.test(out.element)) throw new Error("Некорректный ID элемента.");
  }
  if (["fill", "select"].includes(out.action)) {
    if (typeof input.value !== "string" || input.value.length > 10_000) throw new Error("Некорректное значение.");
    out.value = input.value;
  }
  if (out.action === "navigate") {
    out.url = string("url", 4096);
    parseOrigin(out.url);
  }
  if (out.action === "get_html" && input.selector !== undefined) out.selector = string("selector", 500);
  return out;
}

export function isAllowedUrl(url, origin) {
  try {
    const parsed = new URL(url);
    return parseOrigin(url) === origin && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
