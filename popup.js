const HOST_NAME = "com.zeino.voice_isolate";

// --- State ---
let isOn = false;

// --- DOM ---
const powerToggle = document.getElementById("powerToggle");
const statusDot = document.getElementById("statusDot");
const statusLabel = document.getElementById("statusLabel");
const voiceSlider = document.getElementById("voiceSlider");
const voiceVal = document.getElementById("voiceVal");
const bleedSlider = document.getElementById("bleedSlider");
const bleedVal = document.getElementById("bleedVal");
const syncSlider = document.getElementById("syncSlider");
const syncVal = document.getElementById("syncVal");
const currentSite = document.getElementById("currentSite");
const addSiteBtn = document.getElementById("addSiteBtn");
const siteList = document.getElementById("siteList");

// --- Tabs ---
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(tab.dataset.tab).classList.add("active");
  });
});

// --- Native messaging ---
function sendCommand(command, data = {}) {
  return new Promise((resolve) => {
    const port = chrome.runtime.connectNative(HOST_NAME);
    port.onMessage.addListener((msg) => {
      resolve(msg);
      port.disconnect();
    });
    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) {
        console.error("Native host error:", chrome.runtime.lastError.message);
      }
      resolve(null);
    });
    port.postMessage({ command, ...data });
  });
}

// --- UI Updates ---
function updatePowerUI(on) {
  isOn = on;
  powerToggle.checked = on;
  statusDot.classList.toggle("on", on);
  statusLabel.textContent = on ? "ON" : "OFF";
  // Update background icon
  chrome.runtime.sendMessage({ type: "updateUI", isOn: on });
}

// --- Power toggle ---
powerToggle.addEventListener("change", async () => {
  const target = powerToggle.checked ? "on" : "off";
  updatePowerUI(target === "on"); // Optimistic UI
  const msg = await sendCommand(target === "on" ? "turn_on" : "turn_off");
  if (msg) updatePowerUI(msg.status === "on");
});

// --- Sliders ---
function loadSliders() {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    let hostname = "";
    try { hostname = new URL(tab?.url || "").hostname.replace(/^www\./, ""); } catch {}
    const siteKey = hostname ? "syncDelay:" + hostname : null;
    const keys = ["voiceVolume", "musicBleed", "syncDelay"];
    if (siteKey) keys.push(siteKey);
    chrome.storage.local.get(keys, (data) => {
      voiceSlider.value = data.voiceVolume ?? 100;
      bleedSlider.value = data.musicBleed ?? 0;
      // Per-site delay takes priority
      const siteDelay = siteKey ? data[siteKey] : null;
      syncSlider.value = siteDelay ?? data.syncDelay ?? 6200;
      voiceVal.textContent = voiceSlider.value + "%";
      bleedVal.textContent = bleedSlider.value + "%";
      syncVal.textContent = syncSlider.value + "ms";
    });
  });
}

voiceSlider.addEventListener("input", () => {
  voiceVal.textContent = voiceSlider.value + "%";
  saveSliders();
});
bleedSlider.addEventListener("input", () => {
  bleedVal.textContent = bleedSlider.value + "%";
  saveSliders();
});
syncSlider.addEventListener("input", () => {
  syncVal.textContent = syncSlider.value + "ms";
  saveSyncDelay();
});

function saveSliders() {
  const settings = {
    voiceVolume: parseInt(voiceSlider.value),
    musicBleed: parseInt(bleedSlider.value),
  };
  chrome.storage.local.set(settings);
  // Send to processor in real-time
  sendCommand("set_levels", settings);
}

function saveSyncDelay() {
  const delay = parseInt(syncSlider.value);
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    let hostname = "";
    try { hostname = new URL(tab?.url || "").hostname.replace(/^www\./, ""); } catch {}
    // Save per-site
    const toSave = { syncDelay: delay };
    if (hostname) toSave["syncDelay:" + hostname] = delay;
    chrome.storage.local.set(toSave);
    // Broadcast to active tab's content scripts
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { type: "syncDelayChanged", delay }).catch(() => {});
    }
  });
}

// --- Sites management ---
let currentHostname = "";

function extractHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function loadCurrentSite() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url) {
    currentHostname = extractHostname(tab.url);
    currentSite.textContent = currentHostname || "—";
  }
  updateAddButton();
}

function updateAddButton() {
  chrome.storage.sync.get(["sites"], (data) => {
    const sites = data.sites || [];
    const alreadyAdded = sites.includes(currentHostname);
    addSiteBtn.disabled = !currentHostname || alreadyAdded;
    addSiteBtn.textContent = alreadyAdded ? "Added" : "Add";
  });
}

addSiteBtn.addEventListener("click", () => {
  if (!currentHostname) return;
  chrome.storage.sync.get(["sites"], (data) => {
    const sites = data.sites || [];
    if (!sites.includes(currentHostname)) {
      sites.push(currentHostname);
      sites.sort();
      chrome.storage.sync.set({ sites }, () => {
        renderSites(sites);
        updateAddButton();
        // Notify background to check auto-enable
        chrome.runtime.sendMessage({ type: "sitesUpdated" });
      });
    }
  });
});

function removeSite(hostname) {
  chrome.storage.sync.get(["sites"], (data) => {
    const sites = (data.sites || []).filter((s) => s !== hostname);
    chrome.storage.sync.set({ sites }, () => {
      renderSites(sites);
      updateAddButton();
      chrome.runtime.sendMessage({ type: "sitesUpdated" });
    });
  });
}

function renderSites(sites) {
  if (!sites.length) {
    siteList.innerHTML = '<div class="empty-state">No sites added yet</div>';
    return;
  }
  siteList.innerHTML = sites
    .map(
      (s) => `
    <div class="site-item">
      <span class="site-name">${s}</span>
      <button class="btn btn-remove" data-site="${s}">&times;</button>
    </div>`
    )
    .join("");
  siteList.querySelectorAll(".btn-remove").forEach((btn) => {
    btn.addEventListener("click", () => removeSite(btn.dataset.site));
  });
}

function loadSites() {
  chrome.storage.sync.get(["sites"], (data) => {
    renderSites(data.sites || []);
  });
}

// --- Init ---
async function init() {
  const msg = await sendCommand("status");
  if (msg) updatePowerUI(msg.status === "on");
  loadSliders();
  loadSites();
  loadCurrentSite();
}

init();
