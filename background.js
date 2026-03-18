const HOST_NAME = "com.zeino.voice_isolate";
let isOn = false;
let lastDomain = "";      // Last domain we auto-toggled for
let manualOverride = false; // User manually toggled — don't auto-change

// --- Icon / badge ---
function updateIcon(on) {
  isOn = on;
  // Persist state so it survives MV3 service worker restarts
  chrome.storage.local.set({ _isOn: on });
  const base = on ? "on" : "off";
  chrome.action.setIcon({
    path: { 16: `icons/${base}-16.png`, 48: `icons/${base}-48.png`, 128: `icons/${base}-128.png` },
  });
  chrome.action.setTitle({ title: `Voice Isolate (${on ? "ON" : "OFF"})` });
  chrome.action.setBadgeText({ text: on ? "VO" : "" });
  chrome.action.setBadgeBackgroundColor({ color: on ? "#22c55e" : "#64748b" });

  // Notify all tabs — include per-tab videoDelay decision based on whitelist
  // (content scripts in cross-origin iframes can't check the parent URL)
  chrome.storage.sync.get(["sites"], (data) => {
    const sites = data.sites || [];
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        const tabHost = extractHostname(tab.url || "");
        const videoDelay = on && matchesSite(tabHost, sites);
        chrome.tabs.sendMessage(tab.id, {
          type: "voiceIsolateState", isOn: on, videoDelay
        }).catch(() => {});
      }
    });
  });
}

// --- Native messaging ---
function sendNative(command, data = {}) {
  return new Promise((resolve) => {
    const port = chrome.runtime.connectNative(HOST_NAME);
    let responded = false;
    port.onMessage.addListener((msg) => {
      responded = true;
      resolve(msg);
      port.disconnect();
    });
    port.onDisconnect.addListener(() => {
      if (!responded) resolve(null);
    });
    port.postMessage({ command, ...data });
  });
}

// --- Site matching (includes subdomains) ---
function matchesSite(hostname, sites) {
  if (!hostname || !sites?.length) return false;
  return sites.some((site) => hostname === site || hostname.endsWith("." + site));
}

function extractHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// --- Auto-enable/disable based on active tab ---
async function checkAutoToggle() {
  const { sites } = await chrome.storage.sync.get(["sites"]);
  if (!sites?.length) return; // No whitelist = fully manual

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;
  const hostname = extractHostname(tab.url);
  if (!hostname) return;

  // Domain didn't change — don't interfere
  const currentDomain = hostname;
  if (currentDomain === lastDomain) return;

  // Domain changed — clear manual override
  lastDomain = currentDomain;
  manualOverride = false;

  const shouldBeOn = matchesSite(hostname, sites);

  if (shouldBeOn && !isOn) {
    const msg = await sendNative("turn_on");
    if (msg) updateIcon(msg.status === "on");
  } else if (!shouldBeOn && isOn && !manualOverride) {
    const msg = await sendNative("turn_off");
    if (msg) updateIcon(msg.status === "on");
  }
}

// --- Listeners ---
chrome.tabs.onActivated.addListener(() => checkAutoToggle());
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) checkAutoToggle();
});

// Messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "updateUI") {
    updateIcon(msg.isOn);
    manualOverride = true; // User manually toggled — don't auto-override
  }
  if (msg.type === "sitesUpdated") {
    manualOverride = false;
    lastDomain = "";
    checkAutoToggle();
  }
  if (msg.type === "bgDiagnostics") {
    sendNative("status").then(nativeStatus => {
      sendResponse({ isOn, manualOverride, lastDomain, nativeStatus });
    });
    return true;
  }
  if (msg.type === "getState") {
    // Read both stored state AND whitelist in parallel — don't wait for native host
    Promise.all([
      chrome.storage.local.get(["_isOn"]),
      chrome.storage.sync.get(["sites"]),
    ]).then(([localData, syncData]) => {
      // Use in-memory isOn if set, else fall back to stored state
      const effectiveOn = isOn || !!localData._isOn;
      const sites = syncData.sites || [];
      const tabUrl = sender.tab?.url || sender.url || "";
      const tabHost = extractHostname(tabUrl);
      const videoDelay = effectiveOn && matchesSite(tabHost, sites);
      sendResponse({ isOn: effectiveOn, manualOverride, videoDelay });
    });
    return true; // async sendResponse
  }
});

// Startup — restore persisted state first, then verify with native host
let _statusReady = false;
let _statusPromise = (async () => {
  // Restore persisted state immediately (fast, no native call)
  const stored = await chrome.storage.local.get(["_isOn"]);
  if (stored._isOn) {
    isOn = true;
    const base = "on";
    chrome.action.setIcon({ path: { 16: `icons/${base}-16.png`, 48: `icons/${base}-48.png`, 128: `icons/${base}-128.png` } });
    chrome.action.setBadgeText({ text: "VO" });
    chrome.action.setBadgeBackgroundColor({ color: "#22c55e" });
  }
  // Then verify with native host (with timeout — don't hang forever)
  // Only let native status UPGRADE off→on, never downgrade stored on→off
  // (processor might not be running yet, but user's intent to have video delay is valid)
  const msg = await Promise.race([
    sendNative("status"),
    new Promise(r => setTimeout(() => r(null), 3000)),
  ]);
  if (msg && msg.status === "on") {
    updateIcon(true);
  }
  // If native says "off" but stored _isOn was true, keep isOn=true
  // (video delay works independently of processor)
  _statusReady = true;
})();
