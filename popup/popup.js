import { domainListToText, saveSettings } from "../utils/storage.js";

const ui = {
  status: document.querySelector("#statusBadge"),
  notice: document.querySelector("#notice"),
  siteCount: document.querySelector("#siteCount"),
  interval: document.querySelector("#interval"),
  activeCount: document.querySelector("#activeCount"),
  sites: document.querySelector("#siteList"),
  run: document.querySelector("#runNow"),
  toggle: document.querySelector("#toggleEnabled"),
  powerLabel: document.querySelector("#powerLabel"),
  form: document.querySelector("#settingsForm"),
  autoSaveStatus: document.querySelector("#autoSaveStatus"),
  intervalInput: document.querySelector("#intervalMinutes"),
  waitInput: document.querySelector("#pageWaitSeconds"),
  concurrencyInput: document.querySelector("#maxConcurrentTabs"),
  keepAliveUrlMode: document.querySelector("#keepAliveUrlMode"),
  blacklist: document.querySelector("#blacklist"),
  whitelistEnabled: document.querySelector("#whitelistEnabled"),
  whitelist: document.querySelector("#whitelist"),
  logCount: document.querySelector("#logCount"),
  totalLogs: document.querySelector("#totalLogs"),
  successRate: document.querySelector("#successRate"),
  allLogs: document.querySelector("#allLogs")
};

let dashboard = null;
let runAction = "RUN_NOW";
let noticeTimer = null;
let autoSaveTimer = null;
let saveInFlight = false;
let saveQueued = false;
let settingsInitialized = false;

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => switchView(tab.dataset.view));
});
ui.run.addEventListener("click", handleRunAction);
ui.toggle.addEventListener("click", toggleEnabled);
ui.form.addEventListener("submit", (event) => event.preventDefault());
ui.form.querySelectorAll("[data-autosave]").forEach((field) => {
  field.addEventListener("input", () => scheduleAutoSave(field instanceof HTMLTextAreaElement ? 400 : 250));
  field.addEventListener("change", () => scheduleAutoSave(0));
});
ui.whitelistEnabled.addEventListener("change", updateWhitelistState);

void refresh();

async function refresh(type = "GET_DASHBOARD") {
  try {
    const data = await chrome.runtime.sendMessage({ type });
    if (!data?.ok) throw new Error(data?.error || "无法读取后台状态");
    dashboard = data;
    render(data);
  } catch (error) {
    ui.status.className = "status error";
    ui.status.textContent = "读取失败";
    showNotice(error.message, true);
  }
}

async function handleRunAction() {
  const action = runAction;
  ui.run.disabled = true;
  ui.run.textContent = action === "STOP_ALL" ? "正在停止…" : "正在启动…";
  await refresh(action);
  showNotice(action === "STOP_ALL" ? "已停止全部任务和后续定时" : "已立即执行，下一轮将按设定间隔启动");
}

async function toggleEnabled() {
  if (!dashboard) return;
  ui.toggle.disabled = true;
  const willEnable = !dashboard.settings.enabled;
  try {
    await persistSettings({ ...dashboard.settings, enabled: willEnable });
    showNotice(willEnable ? "自动保活已启用" : "自动保活已停用");
  } catch (error) {
    showNotice("启停失败：" + error.message, true);
  } finally {
    ui.toggle.disabled = false;
  }
}

function scheduleAutoSave(delay) {
  window.clearTimeout(autoSaveTimer);
  setAutoSaveStatus("pending", "等待自动保存…");
  autoSaveTimer = window.setTimeout(queueAutoSave, delay);
}

async function queueAutoSave() {
  window.clearTimeout(autoSaveTimer);
  if (!dashboard) return;
  if (!ui.form.checkValidity()) {
    setAutoSaveStatus("error", "数值超出允许范围，尚未保存");
    return;
  }
  if (saveInFlight) {
    saveQueued = true;
    return;
  }

  saveInFlight = true;
  setAutoSaveStatus("saving", "正在自动保存…");
  try {
    await persistSettings({
      enabled: dashboard.settings.enabled,
      intervalMinutes: Number(ui.intervalInput.value),
      pageWaitSeconds: Number(ui.waitInput.value),
      maxConcurrentTabs: Number(ui.concurrencyInput.value),
      keepAliveUrlMode: ui.keepAliveUrlMode.value,
      blacklist: ui.blacklist.value,
      whitelistEnabled: ui.whitelistEnabled.checked,
      whitelist: ui.whitelist.value
    });
    const now = new Date();
    setAutoSaveStatus("saved", "已自动保存 " + String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0") + ":" + String(now.getSeconds()).padStart(2, "0"));
  } catch (error) {
    setAutoSaveStatus("error", "自动保存失败：" + error.message);
  } finally {
    saveInFlight = false;
    if (saveQueued) {
      saveQueued = false;
      scheduleAutoSave(0);
    }
  }
}

async function persistSettings(settings) {
  await saveSettings(settings);
  const response = await chrome.runtime.sendMessage({ type: "SETTINGS_CHANGED" });
  if (!response?.ok) throw new Error(response?.error || "后台未确认设置");
  await refresh();
}

function render({ settings, runtime, sites, logs }) {
  ui.status.className = "status " + (settings.enabled ? "running" : "paused");
  ui.status.innerHTML = "<i></i>" + (settings.enabled ? (runtime.isRunning ? "执行中" : "运行中") : "已停用");
  ui.powerLabel.textContent = settings.enabled ? "已启用" : "已停用";
  ui.toggle.classList.toggle("enabled", settings.enabled);
  ui.toggle.setAttribute("aria-checked", String(settings.enabled));
  ui.siteCount.textContent = sites.length;
  ui.interval.textContent = settings.intervalMinutes + "m";
  ui.activeCount.textContent = runtime.activeCount;
  runAction = runtime.isRunning ? "STOP_ALL" : "RUN_NOW";
  ui.run.disabled = !settings.enabled && !runtime.isRunning;
  ui.run.classList.toggle("stop", runtime.isRunning);
  ui.run.textContent = runtime.isRunning ? "停止全部 · " + runtime.activeCount + " 个运行中" : "立即保活";
  ui.sites.innerHTML = sites.length
    ? sites.map((site) => '<li><span class="site-dot"></span><div><strong>' + escapeHtml(site.domain) + '</strong><small>' + escapeHtml(site.url) + "</small></div></li>").join("")
    : '<li class="empty">没有符合规则的网页</li>';

  // 只在首次加载时填充表单，避免后台刷新覆盖用户正在输入但尚未防抖保存的内容。
  if (!settingsInitialized) {
    ui.intervalInput.value = settings.intervalMinutes;
    ui.waitInput.value = settings.pageWaitSeconds;
    ui.concurrencyInput.value = settings.maxConcurrentTabs;
    ui.keepAliveUrlMode.value = settings.keepAliveUrlMode;
    ui.blacklist.value = domainListToText(settings.blacklist);
    ui.whitelistEnabled.checked = settings.whitelistEnabled;
    ui.whitelist.value = domainListToText(settings.whitelist);
    settingsInitialized = true;
    updateWhitelistState();
  }
  renderLogs(logs);
}

function renderLogs(logs) {
  ui.logCount.textContent = logs.length;
  ui.totalLogs.textContent = logs.length;
  const successes = logs.filter((log) => log.result === "success").length;
  ui.successRate.textContent = logs.length ? Math.round(successes / logs.length * 100) + "%" : "—";
  ui.allLogs.innerHTML = logs.length
    ? logs.map((log) => '<article class="log-card"><span class="result ' + log.result + '">' + (log.result === "success" ? "SUCCESS" : "FAILED") + '</span><div><strong>' + escapeHtml(log.domain) + "</strong><time>" + escapeHtml(log.time) + " · " + formatDuration(log.duration) + "</time>" + (log.error ? "<small>" + escapeHtml(log.error) + "</small>" : "") + "</div></article>").join("")
    : '<p class="empty">完成首次任务后将在这里显示</p>';
}

function switchView(view) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  document.querySelectorAll(".view").forEach((panel) => panel.classList.toggle("active", panel.dataset.viewPanel === view));
}

function updateWhitelistState() {
  ui.whitelist.disabled = !ui.whitelistEnabled.checked;
  document.querySelector(".whitelist-field").classList.toggle("disabled", !ui.whitelistEnabled.checked);
}

function setAutoSaveStatus(state, message) {
  ui.autoSaveStatus.className = "autosave-status " + state;
  ui.autoSaveStatus.querySelector("span").textContent = message;
}

function showNotice(message, isError = false) {
  window.clearTimeout(noticeTimer);
  ui.notice.textContent = message;
  ui.notice.className = "notice visible " + (isError ? "error" : "success");
  noticeTimer = window.setTimeout(() => { ui.notice.className = "notice"; }, 3000);
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "—";
  return milliseconds < 1000 ? milliseconds + "ms" : (milliseconds / 1000).toFixed(1) + "s";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}
