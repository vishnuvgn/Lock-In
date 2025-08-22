function fmt(ms){
  const s = Math.max(0, Math.floor(ms/1000));
  const h = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  const ss = s%60;
  return (h?`${h}:`:"") + String(m).padStart(2,"0") + ":" + String(ss).padStart(2,"0");
}

function label() { return document.querySelector("#time .count"); }
function hostLabel() { return document.querySelector("#host"); }

async function updateCountdown(){
  const { lockMode = null, lockUntil = 0 } =
    await chrome.storage.local.get(["lockMode", "lockUntil"]);
  if (lockMode === "infinite") {
    label().textContent = "Forever";
  } else if (lockMode === "timed") {
    const left = Math.max(0, lockUntil - Date.now());
    label().textContent = left ? fmt(left) : "Done";
  } else {
    label().textContent = "Done";
  }
}

async function showTargetHost() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    const { url } = await chrome.runtime.sendMessage({ type: "getPendingFor", tabId: tab.id });
    if (url) { try { hostLabel().textContent = new URL(url).host; return; } catch {} }
  }
  // fallback from hash (#u=...)
  const raw = location.hash.startsWith("#u=") ? location.hash.slice(3) : "";
  try { if (raw) hostLabel().textContent = new URL(raw).host; } catch {}
}

document.addEventListener("DOMContentLoaded", () => {
  const backBtn = document.getElementById("goBack");
  if (backBtn) backBtn.addEventListener("click", () => history.back());

  updateCountdown();
  showTargetHost();

  setInterval(updateCountdown, 1000);
  document.addEventListener("visibilitychange", updateCountdown);
  chrome.storage.onChanged.addListener(ch => {
    if (ch.lockMode || ch.lockUntil) updateCountdown();
  });
});
