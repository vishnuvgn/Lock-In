// storage.local:
//   blocklist: string[]
//   lockMode: 'timed' | 'infinite' | null
//   lockUntil: number  (ms since epoch; for 'timed')
// storage.session:
//   pendingRedirects: { [tabId: string]: string }  // original URL per tab

// ---------- small utilities ----------
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function nowMs() { return Date.now(); }

// FNV-1a hash → stable POSITIVE rule id in a safe range
function ruleIdForHost(host) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < host.length; i++) {
    h ^= host.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const u32 = h >>> 0;                 // force unsigned
  const BASE = 100000;                 // avoid clashes with other extensions
  const MAX  = 2147000000;             // keep < 2^31-1
  return BASE + (u32 % (MAX - BASE));
}

function sanitizeList(blocklist) {
  const set = new Set();
  for (let raw of blocklist || []) {
    if (!raw) continue;
    const host = String(raw).toLowerCase()
      .replace(/^https?:\/\//, "")
      .split("/")[0]
      .trim();
    if (host) set.add(host);
  }
  return [...set];
}

// ---------- rule building ----------
function makeRules(blocklist) {
  const blockedBase = chrome.runtime.getURL("blocked.html"); // chrome-extension://id/blocked.html
  return blocklist.map((host) => {
    // Use urlFilter form that matches the domain and all subdomains.
    // Example: "||youtube.com^"
    const urlFilter = `||${host}^`;
    return {
      id: ruleIdForHost(host),
      priority: 1,
      action: {
        type: "redirect",
        redirect: { extensionPath: "/blocked.html" }
      },
      condition: {
        urlFilter,
        resourceTypes: ["main_frame"]
      }
    };
  });
}

async function getState() {
  return await chrome.storage.local.get(["blocklist", "lockMode", "lockUntil"]);
}

function rulesActive({ lockMode, lockUntil }) {
  const n = nowMs();
  return (lockMode === "timed" && n < lockUntil) || lockMode === "infinite";
}

// ---------- serialized refresh (fixes duplicate-id race) ----------
let refreshChain = Promise.resolve();

async function doRefresh() {
  const { blocklist = [], lockMode = null, lockUntil = 0 } = await getState();
  const list = sanitizeList(blocklist);
  const addRules = rulesActive({ lockMode, lockUntil }) ? makeRules(list) : [];

  // Always fetch-current → clear → add (two-phase) to avoid id collisions
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeIds = existing.map(r => r.id);
  if (removeIds.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds });
  }
  if (addRules.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules });
  }

  // Badge
  let text = "";
  if (lockMode === "infinite") text = "∞";
  else if (lockMode === "timed" && nowMs() < lockUntil) text = "🔒";
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: [0, 0, 0, 255] });
}

function refreshRules() {
  // queue refreshes so only one runs at a time
  refreshChain = refreshChain.then(doRefresh).catch(err => console.error("refresh error:", err));
  return refreshChain;
}

// ---------- locks ----------
async function startTimedLock(minutes) {
  const lockUntil = nowMs() + minutes * 60_000;
  await chrome.storage.local.set({ lockMode: "timed", lockUntil });
  chrome.alarms.create("unlock", { when: lockUntil });
  await refreshRules();
}

async function startInfiniteLock() {
  await chrome.storage.local.set({ lockMode: "infinite", lockUntil: 0 });
  chrome.alarms.clear("unlock");
  await refreshRules();
}

async function clearLock() {
  await chrome.storage.local.set({ lockMode: null, lockUntil: 0 });
  chrome.alarms.clear("unlock");
  await refreshRules();
}

// ---------- pending map for auto-resume ----------
async function setPending(tabId, url) {
  const key = "pendingRedirects";
  const store = await chrome.storage.session.get(key);
  const map = store[key] || {};
  map[String(tabId)] = url;
  await chrome.storage.session.set({ [key]: map });
}
async function popAllPending() {
  const key = "pendingRedirects";
  const store = await chrome.storage.session.get(key);
  const map = store[key] || {};
  await chrome.storage.session.set({ [key]: {} });
  return map;
}
async function getPendingFor(tabId) {
  const key = "pendingRedirects";
  const store = await chrome.storage.session.get(key);
  const map = store[key] || {};
  return map[String(tabId)] || null;
}
async function removePending(tabId) {
  const key = "pendingRedirects";
  const store = await chrome.storage.session.get(key);
  const map = store[key] || {};
  if (map[String(tabId)]) {
    delete map[String(tabId)];
    await chrome.storage.session.set({ [key]: map });
  }
}

// Remember exact URL that got blocked (needs declarativeNetRequestFeedback)
chrome.declarativeNetRequest.onRuleMatchedDebug?.addListener(async (info) => {
  if (!info?.request) return;
  const tabId = info.request.tabId;
  if (typeof tabId === "number" && info.request.url) {
    try { await setPending(tabId, info.request.url); } catch {}
  }
});

// Cleanup on tab close
chrome.tabs.onRemoved.addListener((tabId) => { removePending(tabId); });

// When the timed lock ends: stop blocking + auto-resume tabs
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== "unlock") return;
  const { lockMode = null, lockUntil = 0 } = await getState();
  if (lockMode === "timed" && nowMs() >= lockUntil) {
    await chrome.storage.local.set({ lockMode: null, lockUntil: 0 });
    await refreshRules();

    const pending = await popAllPending();
    const blockedBase = chrome.runtime.getURL("blocked.html");
    await Promise.all(Object.entries(pending).map(async ([idStr, targetUrl]) => {
      const tabId = Number(idStr);
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab && tab.url && tab.url.startsWith(blockedBase)) {
          await chrome.tabs.update(tabId, { url: targetUrl });
        }
      } catch {}
    }));
  }
});

// lifecycle + storage
chrome.runtime.onInstalled.addListener(refreshRules);
chrome.runtime.onStartup.addListener(refreshRules);
chrome.storage.onChanged.addListener(() => { refreshRules(); });

// message API for popup/blocked page
chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  (async () => {
    if (msg?.type === "startLock") await startTimedLock(msg.minutes);
    if (msg?.type === "startInfinite") await startInfiniteLock();
    if (msg?.type === "clearLock") await clearLock();
    if (msg?.type === "refresh") await refreshRules();
    if (msg?.type === "getState") { send(await getState()); return; }
    if (msg?.type === "getPendingFor") { send({ url: await getPendingFor(msg.tabId) }); return; }
    send({ ok: true });
  })();
  return true;
});
