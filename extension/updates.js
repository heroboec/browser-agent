export function parseRepository(value) {
  const repository = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(repository) ||
      repository.split("/")[1] === "." || repository.split("/")[1] === "..") {
    throw new Error("Укажите репозиторий в формате владелец/репозиторий.");
  }
  return repository;
}

function versionParts(value) {
  if (typeof value !== "string" || !/^v?\d+(\.\d+){0,3}$/i.test(value)) {
    throw new Error("У релиза неподдерживаемый тег версии. Ожидается, например, v0.1.1.");
  }
  return value.replace(/^v/i, "").split(".").map(Number);
}

export function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference) return difference;
  }
  return 0;
}

export async function checkRelease(repository, currentVersion, fetcher = fetch) {
  const repo = parseRepository(repository);
  const response = await fetcher(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
    cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(15000)
  });
  if (response.status === 404) throw new Error("Релизов нет, либо репозиторий не найден или приватный.");
  if (!response.ok) throw new Error(`GitHub ответил ${response.status}${[403, 429].includes(response.status) ? " — возможно, исчерпан лимит запросов. Повторите позже." : "."}`);
  const release = await response.json();
  const newer = compareVersions(release.tag_name, currentVersion) > 0;
  // Construct the link locally; never trust URLs or HTML supplied by a release.
  return {
    newer, version: release.tag_name.replace(/^v/i, ""),
    url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(release.tag_name)}`
  };
}
