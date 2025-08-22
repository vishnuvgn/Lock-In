const hostEl      = document.getElementById("host");
const addBtn      = document.getElementById("add");
const listEl      = document.getElementById("list");
const statusEl    = document.getElementById("status");
const customMinEl = document.getElementById("customMin");
const startCustom = document.getElementById("startCustom");
const cancelLock  = document.getElementById("cancelLock");
const presetBtns  = [...document.querySelectorAll("[data-min], [data-infinite]")];

let tickHandle = null;

function fmt(ms) {
  const s = Math.max(0, Math.floor(ms/1000));
  const h = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  const ss = s % 60;
  return (h ? `${h}:` : "") + String(m).padStart(2, "0") + ":" + String(ss).padStart(2, "0");
}

async function getState() {
  return await chrome.runtime.sendMessage({ type: "getState" });
}

async function load() {
  const { blocklist = [], lockMode = null, lockUntil = 0 } = await getState();
  render(blocklist);
  updateLockUI({ lockMode, lockUntil });
}

function render(blocklist) {
  listEl.innerHTML = "";
  blocklist.forEach((h, idx) => {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = h;
    const rm = document.createElement("button");
    rm.textContent = "remove";
    rm.onclick = async () => {
      const next = blocklist.filter((_, i) => i !== idx);
      await chrome.storage.local.set({ blocklist: next });
      render(next);
      await chrome.runtime.sendMessage({ type: "refresh" });
    };
    li.appendChild(span);
    li.appendChild(rm);
    listEl.appendChild(li);
  });
}

function updateLockUI({ lockMode = null, lockUntil = 0 }) {
  if (tickHandle) clearInterval(tickHandle);

  const updateTimed = () => {
    const now = Date.now();
    if (now < lockUntil) {
      statusEl.textContent = `LOCKED • ${fmt(lockUntil - now)} remaining`;
      presetBtns.forEach(b => b.disabled = true);
      startCustom.disabled = true;
      customMinEl.disabled = true;
      cancelLock.disabled = false;
    } else {
      statusEl.textContent = "Idle";
      presetBtns.forEach(b => b.disabled = false);
      startCustom.disabled = false;
      customMinEl.disabled = false;
      cancelLock.disabled = true;
      clearInterval(tickHandle);
      tickHandle = null;
    }
  };

  if (lockMode === "infinite") {
    statusEl.textContent = "LOCKED • ∞";
    presetBtns.forEach(b => b.disabled = false);
    startCustom.disabled = false;
    customMinEl.disabled = false;
    cancelLock.disabled = false;
  } else if (lockMode === "timed") {
    updateTimed();
    tickHandle = setInterval(updateTimed, 1000);
  } else {
    statusEl.textContent = "Idle";
    presetBtns.forEach(b => b.disabled = false);
    startCustom.disabled = false;
    customMinEl.disabled = false;
    cancelLock.disabled = true;
  }
}

addBtn.onclick = async () => {
  const raw = hostEl.value.trim();
  if (!raw) return;
  const host = raw.replace(/^https?:\/\//, "").split("/")[0];
  const { blocklist = [] } = await chrome.storage.local.get("blocklist");
  if (!blocklist.includes(host)) {
    blocklist.push(host);
    await chrome.storage.local.set({ blocklist });
    render(blocklist);
    await chrome.runtime.sendMessage({ type: "refresh" });
  }
  hostEl.value = "";
};

presetBtns.forEach(btn => {
  btn.onclick = async () => {
    if ("infinite" in btn.dataset) {
      await chrome.runtime.sendMessage({ type: "startInfinite" });
    } else {
      const minutes = parseInt(btn.dataset.min, 10);
      await chrome.runtime.sendMessage({ type: "startLock", minutes });
    }
    const st = await getState();
    updateLockUI(st);
  };
});

startCustom.onclick = async () => {
  const minutes = Math.max(1, parseInt(customMinEl.value, 10) || 0);
  await chrome.runtime.sendMessage({ type: "startLock", minutes });
  const st = await getState();
  updateLockUI(st);
};

/* ========= Auto-resume helper (redirect blocked tabs back) ========= */
async function resumeBlockedTabs() {
  try {
    const blockedBase = chrome.runtime.getURL("blocked.html");
    const tabs = await chrome.tabs.query({ url: blockedBase + "*" });
    for (const tab of tabs) {
      let target = null;
      try {
        const resp = await chrome.runtime.sendMessage({ type: "getPendingFor", tabId: tab.id });
        target = resp?.url || null;
      } catch {}
      if (!target && tab.url) {
        const i = tab.url.indexOf("#u=");
        if (i >= 0) target = tab.url.slice(i + 3);
      }
      if (target) {
        try { await chrome.tabs.update(tab.id, { url: target }); } catch {}
      }
    }
  } catch {}
}

/* =========================
   Cancel → confirmation modal
   ========================= */

function ensureModal() {
  let overlay = document.getElementById("sb-confirm-overlay");
  if (overlay) return overlay;

  if (!document.getElementById("sb-confirm-style")) {
    const style = document.createElement("style");
    style.id = "sb-confirm-style";
    style.textContent = `
      .sb-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center;padding:16px;z-index:9999}
      .sb-overlay.open{display:flex}
      .sb-modal{width:100%;max-width:520px;background:#fff;color:#111;border-radius:16px;padding:20px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
      @media (prefers-color-scheme: dark){.sb-modal{background:#1f1f1f;color:#f0f0f0}}
      .sb-modal h2{margin:0 0 10px;font-size:18px}
      .sb-quote{margin:6px 0 16px;line-height:1.5;font-style:italic}
      .sb-actions{display:flex;gap:10px;justify-content:flex-end}
      .sb-btn{border:1px solid rgba(0,0,0,.2);border-radius:10px;padding:8px 12px;background:#efefef;cursor:pointer}
      .sb-btn-danger{border-color:rgba(200,0,0,.35);color:#b00000;background:transparent}
    `;
    document.head.appendChild(style);
  }

  overlay = document.createElement("div");
  overlay.id = "sb-confirm-overlay";
  overlay.className = "sb-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.innerHTML = `
    <div class="sb-modal" role="document">
      <h2>Before you cancel…</h2>
      <div class="sb-quote">Lock in bro</div>
      <div class="sb-actions">
        <button class="sb-btn" id="sb-dismiss">No, keep focusing</button>
        <button class="sb-btn sb-btn-danger" id="sb-confirm">you still want to cancel?</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const dismiss = overlay.querySelector("#sb-dismiss");
  const confirm = overlay.querySelector("#sb-confirm");

  const close = () => overlay.classList.remove("open");
  overlay._open = () => overlay.classList.add("open");

  dismiss.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  // CONFIRM: clear lock, auto-resume tabs, close, refresh UI
  confirm.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "clearLock" });
    await resumeBlockedTabs();
    close();
    const st = await getState();
    updateLockUI(st);
  });

  return overlay;
}

// Intercept Cancel in capture phase; block any old handlers
cancelLock.onclick = null;
cancelLock.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopImmediatePropagation();
  e.stopPropagation();
  if (!cancelLock.disabled) {
    const overlay = ensureModal();
    overlay._open();
  }
}, true);

/* ========================= */

chrome.storage.onChanged.addListener(async (ch) => {
  if (ch.lockMode || ch.lockUntil) {
    const st = await getState();
    updateLockUI(st);
  }
});

load();
