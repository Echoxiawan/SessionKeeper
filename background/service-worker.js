import {
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  appendLog,
  formatDateTime,
  getLogs,
  getSettings,
  matchesDomain,
  saveSettings
} from "../utils/storage.js";

const MAIN_ALARM = "sessionkeeper-main";
const CLOSE_ALARM_PREFIX = "sessionkeeper-close-";
const TIMEOUT_ALARM_PREFIX = "sessionkeeper-timeout-";
const LOAD_TIMEOUT_MS = 30_000;
const MAX_HISTORY = 100;
const preciseTimers = new Map();
let operationChain = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  void serialize(async () => {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    if (!stored[STORAGE_KEYS.SETTINGS]) await saveSettings(DEFAULT_SETTINGS);
    await configureMainAlarm();
    await recoverRuntime();
  });
});

chrome.runtime.onStartup.addListener(() => {
  void serialize(async () => {
    await configureMainAlarm();
    await recoverRuntime();
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MAIN_ALARM) {
    void serialize(startCycle);
  } else if (alarm.name.startsWith(CLOSE_ALARM_PREFIX)) {
    void serialize(() => completeTask(Number(alarm.name.slice(CLOSE_ALARM_PREFIX.length))));
  } else if (alarm.name.startsWith(TIMEOUT_ALARM_PREFIX)) {
    void serialize(() => failTask(Number(alarm.name.slice(TIMEOUT_ALARM_PREFIX.length)), "页面加载超时"));
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") void serialize(() => handlePageLoaded(tabId));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void serialize(async () => {
    const state = await getRuntime();
    const task = state.active[String(tabId)];
    if (!task || task.phase === "closing") return;
    await finalizeTask(state, task, "failed", "后台页面被提前关闭");
    await fillWorkerSlots(state);
  });
});

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0) return;
  void serialize(() => failTask(details.tabId, "页面无法访问：" + details.error));
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[STORAGE_KEYS.SETTINGS]) {
    void serialize(configureMainAlarm);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) return false;

  serialize(async () => {
    if (message.type === "GET_DASHBOARD") return buildDashboard();
    if (message.type === "RUN_NOW") {
      // 手动立即执行后，从当前时刻重新计算下一次定时任务。
      await configureMainAlarm();
      await startCycle();
      return buildDashboard();
    }
    if (message.type === "STOP_ALL") {
      await stopAll();
      return buildDashboard();
    }
    if (message.type === "SETTINGS_CHANGED") {
      await configureMainAlarm();
      return { ok: true };
    }
    throw new Error("未知操作");
  }).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

// 模块每次被唤醒时都恢复持久化任务，适配 MV3 Service Worker 生命周期。
void serialize(recoverRuntime);

function serialize(operation) {
  const next = operationChain.then(operation, operation);
  operationChain = next.catch(() => undefined);
  return next;
}

async function configureMainAlarm() {
  const settings = await getSettings();
  await chrome.alarms.clear(MAIN_ALARM);
  if (!settings.enabled) {
    await stopCycle();
    return;
  }
  chrome.alarms.create(MAIN_ALARM, {
    delayInMinutes: settings.intervalMinutes,
    periodInMinutes: settings.intervalMinutes
  });
}

async function startCycle() {
  const settings = await getSettings();
  if (!settings.enabled) return;

  const current = await getRuntime();
  if (current.isRunning) return;

  const sites = await scanSites(settings);
  const now = Date.now();
  const state = {
    cycleId: now + "-" + crypto.randomUUID(),
    isRunning: sites.length > 0,
    startedAt: now,
    queue: sites.map((site, index) => ({
      id: now + "-" + index,
      domain: site.domain,
      url: site.url,
      startTime: null,
      status: "pending",
      duration: null
    })),
    active: {},
    history: current.history || []
  };

  await saveRuntime(state);
  if (state.isRunning) await fillWorkerSlots(state);
}

async function stopCycle() {
  const state = await getRuntime();
  if (!state.isRunning && Object.keys(state.active).length === 0) return;

  state.isRunning = false;
  state.queue = [];
  state.completedAt = Date.now();
  const activeTasks = Object.values(state.active);

  // 先持久化 closing 状态，防止 tabs.onRemoved 将主动停止误判为意外关闭。
  for (const task of activeTasks) task.phase = "closing";
  await saveRuntime(state);

  for (const task of activeTasks) {
    clearPreciseTimer(task.tabId);
    await Promise.all([
      chrome.alarms.clear(closeAlarmName(task.tabId)),
      chrome.alarms.clear(timeoutAlarmName(task.tabId))
    ]);
    try {
      await chrome.tabs.remove(task.tabId);
    } catch {
      // 标签页可能已被用户或 Chrome 关闭，不影响停止其余任务。
    }
    await finalizeTask(state, task, "failed", "用户停止本轮任务");
  }

  await saveRuntime(state);
}

async function stopAll() {
  const settings = await getSettings();
  // 先持久化停用状态并清除主闹钟，阻止已经排队的定时事件启动新任务。
  if (settings.enabled) await saveSettings({ ...settings, enabled: false });
  await chrome.alarms.clear(MAIN_ALARM);
  await stopCycle();
}

async function scanSites(settings = null) {
  const config = settings || await getSettings();
  const tabs = await chrome.tabs.query({});
  const sites = new Map();

  for (const tab of tabs) {
    if (!tab.url) continue;
    try {
      const parsed = new URL(tab.url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      if (matchesDomain(parsed.hostname, config.blacklist)) continue;
      if (config.whitelistEnabled && !matchesDomain(parsed.hostname, config.whitelist)) continue;
      if (!sites.has(parsed.hostname)) {
        sites.set(parsed.hostname, { domain: parsed.hostname, url: parsed.origin });
      }
    } catch {
      // 非法 URL 不应阻断其余标签页的扫描。
    }
  }

  return [...sites.values()].sort((a, b) => a.domain.localeCompare(b.domain));
}

async function fillWorkerSlots(state) {
  const settings = await getSettings();
  while (Object.keys(state.active).length < settings.maxConcurrentTabs && state.queue.length > 0) {
    const task = state.queue.shift();
    task.status = "running";
    task.startTime = Date.now();

    try {
      const tab = await chrome.tabs.create({ url: task.url, active: false });
      if (!Number.isInteger(tab.id)) throw new Error("Chrome 未返回有效的 Tab ID");
      task.tabId = tab.id;
      task.phase = "loading";
      task.loadDeadline = Date.now() + LOAD_TIMEOUT_MS;
      state.active[String(tab.id)] = task;
      chrome.alarms.create(timeoutAlarmName(tab.id), { when: task.loadDeadline });
      // 极快页面可能在 onUpdated 监听到之前就完成，持久化后主动复核一次状态。
      const latestTab = await chrome.tabs.get(tab.id);
      if (latestTab.status === "complete") task.completedBeforePersist = true;
    } catch (error) {
      await finalizeTask(state, task, "failed", "创建后台页面失败：" + error.message);
    }
    await saveRuntime(state);
    if (task.completedBeforePersist) {
      delete task.completedBeforePersist;
      await saveRuntime(state);
      await handlePageLoaded(task.tabId);
      Object.assign(state, await getRuntime());
    }
  }

  await finishCycleIfIdle(state);
}

async function handlePageLoaded(tabId) {
  const state = await getRuntime();
  const task = state.active[String(tabId)];
  if (!task || task.phase !== "loading") return;

  await chrome.alarms.clear(timeoutAlarmName(tabId));
  const settings = await getSettings();
  task.phase = "waiting";
  task.loadedAt = Date.now();
  task.closeAt = task.loadedAt + settings.pageWaitSeconds * 1000;
  await saveRuntime(state);
  scheduleClose(task);
}

function scheduleClose(task) {
  clearPreciseTimer(task.tabId);
  const delay = Math.max(0, task.closeAt - Date.now());
  preciseTimers.set(task.tabId, setTimeout(() => {
    void serialize(() => completeTask(task.tabId));
  }, delay));
  // Alarm 在 Worker 休眠后兜底，setTimeout 负责正常运行时的秒级关闭。
  chrome.alarms.create(closeAlarmName(task.tabId), { when: task.closeAt });
}

async function completeTask(tabId) {
  const state = await getRuntime();
  const task = state.active[String(tabId)];
  if (!task || task.phase !== "waiting") return;
  if (Date.now() + 25 < task.closeAt) {
    scheduleClose(task);
    return;
  }

  task.phase = "closing";
  await saveRuntime(state);
  clearPreciseTimer(tabId);
  await chrome.alarms.clear(closeAlarmName(tabId));

  try {
    await chrome.tabs.remove(tabId);
    await finalizeTask(state, task, "success");
  } catch (error) {
    await finalizeTask(state, task, "failed", "关闭后台页面失败：" + error.message);
  }
  await fillWorkerSlots(state);
}

async function failTask(tabId, reason) {
  const state = await getRuntime();
  const task = state.active[String(tabId)];
  if (!task || task.phase !== "loading") return;

  task.phase = "closing";
  await saveRuntime(state);
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // 页面可能已被浏览器关闭，仍记录原始失败原因。
  }
  await finalizeTask(state, task, "failed", reason);
  await fillWorkerSlots(state);
}

async function finalizeTask(state, task, status, error = "") {
  if (task.tabId !== undefined) {
    delete state.active[String(task.tabId)];
    clearPreciseTimer(task.tabId);
    await Promise.all([
      chrome.alarms.clear(closeAlarmName(task.tabId)),
      chrome.alarms.clear(timeoutAlarmName(task.tabId))
    ]);
  }

  task.status = status;
  task.duration = task.startTime ? Date.now() - task.startTime : 0;
  if (error) task.error = error;
  state.history.unshift({ ...task, completedAt: Date.now() });
  state.history = state.history.slice(0, MAX_HISTORY);

  await appendLog({
    time: formatDateTime(),
    timestamp: Date.now(),
    domain: task.domain,
    action: "keep_alive",
    result: status,
    duration: task.duration,
    error
  });
  await saveRuntime(state);
}

async function finishCycleIfIdle(state) {
  if (state.queue.length === 0 && Object.keys(state.active).length === 0) {
    state.isRunning = false;
    state.completedAt = Date.now();
    await saveRuntime(state);
  }
}

async function recoverRuntime() {
  const state = await getRuntime();
  if (!state.isRunning) return;

  const activeTasks = Object.values(state.active);
  for (const task of activeTasks) {
    try {
      await chrome.tabs.get(task.tabId);
      if (task.phase === "waiting") {
        scheduleClose(task);
      } else if (task.phase === "loading") {
        chrome.alarms.create(timeoutAlarmName(task.tabId), { when: task.loadDeadline });
      }
    } catch {
      await finalizeTask(state, task, "failed", "Service Worker 恢复时后台页面已不存在");
    }
  }

  await saveRuntime(state);
  await fillWorkerSlots(state);

  // 过期任务在持久化状态稳定后统一处理，避免恢复流程覆盖新状态。
  for (const task of Object.values(state.active)) {
    if (task.phase === "loading" && Date.now() >= task.loadDeadline) {
      await failTask(task.tabId, "页面加载超时");
      return;
    }
  }
}

async function buildDashboard() {
  const [settings, sites, logs, state] = await Promise.all([
    getSettings(), scanSites(), getLogs(), getRuntime()
  ]);
  return {
    ok: true,
    settings,
    sites,
    logs,
    runtime: {
      isRunning: state.isRunning,
      pendingCount: state.queue.length,
      activeCount: Object.keys(state.active).length
    }
  };
}

async function getRuntime() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.RUNTIME);
  return result[STORAGE_KEYS.RUNTIME] || {
    cycleId: null,
    isRunning: false,
    startedAt: null,
    queue: [],
    active: {},
    history: []
  };
}

async function saveRuntime(state) {
  await chrome.storage.local.set({ [STORAGE_KEYS.RUNTIME]: state });
}

function closeAlarmName(tabId) { return CLOSE_ALARM_PREFIX + tabId; }
function timeoutAlarmName(tabId) { return TIMEOUT_ALARM_PREFIX + tabId; }
function clearPreciseTimer(tabId) {
  const timer = preciseTimers.get(tabId);
  if (timer !== undefined) clearTimeout(timer);
  preciseTimers.delete(tabId);
}
