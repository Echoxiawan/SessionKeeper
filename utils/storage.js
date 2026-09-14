export const STORAGE_KEYS = Object.freeze({
  SETTINGS: "settings",
  LOGS: "logs",
  RUNTIME: "runtimeState"
});

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  intervalMinutes: 10,
  pageWaitSeconds: 10,
  maxConcurrentTabs: 3,
  keepAliveUrlMode: "hostname",
  blacklist: [],
  whitelistEnabled: false,
  whitelist: []
});

const MAX_LOGS = 100;

export async function getSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return sanitizeSettings(result[STORAGE_KEYS.SETTINGS]);
}

export async function saveSettings(input) {
  const settings = sanitizeSettings(input);
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
  return settings;
}

export function sanitizeSettings(input = {}) {
  return {
    enabled: input.enabled !== false,
    intervalMinutes: clampInteger(input.intervalMinutes, 1, 1440, DEFAULT_SETTINGS.intervalMinutes),
    pageWaitSeconds: clampInteger(input.pageWaitSeconds, 0, 300, DEFAULT_SETTINGS.pageWaitSeconds),
    maxConcurrentTabs: clampInteger(input.maxConcurrentTabs, 1, 10, DEFAULT_SETTINGS.maxConcurrentTabs),
    keepAliveUrlMode: input.keepAliveUrlMode === "randomOpenUrl" ? "randomOpenUrl" : DEFAULT_SETTINGS.keepAliveUrlMode,
    blacklist: normalizeDomainList(input.blacklist),
    whitelistEnabled: input.whitelistEnabled === true,
    whitelist: normalizeDomainList(input.whitelist)
  };
}

export function normalizeDomainList(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\n,]+/);
  return [...new Set(values.map(normalizeDomainRule).filter(Boolean))];
}

export function domainListToText(value) {
  return normalizeDomainList(value).join("\n");
}

export function matchesDomain(hostname, rules) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return normalizeDomainList(rules).some((rule) => host === rule || host.endsWith("." + rule));
}

export async function getLogs() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.LOGS);
  return Array.isArray(result[STORAGE_KEYS.LOGS]) ? result[STORAGE_KEYS.LOGS] : [];
}

export async function appendLog(log) {
  const logs = await getLogs();
  logs.unshift(log);
  await chrome.storage.local.set({ [STORAGE_KEYS.LOGS]: logs.slice(0, MAX_LOGS) });
}

export function formatDateTime(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const pad = (number) => String(number).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
}

function normalizeDomainRule(value) {
  let rule = String(value || "").trim().toLowerCase();
  if (!rule) return "";

  try {
    if (rule.includes("://")) rule = new URL(rule).hostname;
  } catch {
    return "";
  }

  rule = rule.split("/")[0].split(":")[0].replace(/^\*\./, "").replace(/\.$/, "");
  if (rule === "localhost") return rule;
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(rule) ? rule : "";
}

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}
