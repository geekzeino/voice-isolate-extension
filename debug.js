function valClass(v, trueClass = "on", falseClass = "off") {
  if (v === true || v === "on") return trueClass;
  if (v === false || v === "off") return falseClass;
  return "";
}

function row(label, value, cls = "") {
  const vc = cls || (typeof value === "number" ? "num" : "");
  return "<tr><td>" + label + "</td><td class=\"val " + vc + "\">" + value + "</td></tr>";
}

async function pollBg() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "bgDiagnostics" });
    if (!resp) throw new Error("No response");

    document.getElementById("bg-card").className = "card " + (resp.isOn ? "ok" : "warn");
    document.getElementById("bg-table").innerHTML =
      row("isOn", resp.isOn, valClass(resp.isOn)) +
      row("manualOverride", resp.manualOverride) +
      row("lastDomain", resp.lastDomain || "(none)");

    document.getElementById("native-table").innerHTML =
      row("status", resp.nativeStatus?.status || "unknown", valClass(resp.nativeStatus?.status === "on", "on", "off")) +
      row("raw", JSON.stringify(resp.nativeStatus || {}));

    document.getElementById("native-card").className = "card " + (resp.nativeStatus?.status === "on" ? "ok" : "error");
  } catch (e) {
    document.getElementById("bg-table").innerHTML = row("error", e.message, "off");
    document.getElementById("bg-card").className = "card error";
  }
}

async function pollTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    const container = document.getElementById("tabs-content");
    let html = "";

    for (const tab of tabs) {
      if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) continue;

      try {
        const d = await chrome.tabs.sendMessage(tab.id, { type: "getDiagnostics" }).catch(() => null);
        if (!d) continue;

        const syncerOk = d.syncer?.running && d.syncer?.frameCount > 0;
        const borderClass = !d.active ? "" : syncerOk ? "ok" : "error";

        html += "<div class=\"card " + borderClass + "\" style=\"margin-bottom:8px\">";
        html += "<div style=\"color:#58a6ff;margin-bottom:6px;font-size:12px\">" + (tab.title?.substring(0, 60) || "Tab " + tab.id) + "</div>";
        html += "<table>";
        html += row("frame", d.frame);
        html += row("active", d.active, valClass(d.active));
        html += row("delayMs", d.delayMs, "num");

        if (d.video) {
          html += "<tr><td colspan=\"2\" style=\"color:#8b949e;padding-top:6px\">-- Video --</td></tr>";
          if (d.video.note) {
            html += row("status", d.video.note, d.video.found ? "warn" : "off");
          } else {
            html += row("src", d.video.src || "(blob/empty)");
            html += row("size", d.video.videoWidth + "x" + d.video.videoHeight, "num");
            html += row("readyState", d.video.readyState, d.video.readyState >= 2 ? "on" : "warn");
            html += row("paused", d.video.paused, valClass(!d.video.paused));
            html += row("currentTime", d.video.currentTime + "s", "num");
            html += row("opacity", d.video.opacity, d.video.opacity === "0" ? "on" : "warn");
            html += row("networkState", d.video.networkState, "num");
          }
        }

        if (d.syncer) {
          html += "<tr><td colspan=\"2\" style=\"color:#8b949e;padding-top:6px\">-- Syncer (Canvas) --</td></tr>";
          html += row("running", d.syncer.running, valClass(d.syncer.running));
          html += row("frames captured", d.syncer.frameCount, "num");
          html += row("writeHead", d.syncer.writeHead, "num");
          html += row("readHead", d.syncer.readHead, "num");
          html += row("buffer fill", d.syncer.bufferFill + "/" + d.syncer.maxBuffer, "num");
          html += row("canvas size", d.syncer.canvasSize);
          html += row("canvas in DOM", d.syncer.canvasInDOM, valClass(d.syncer.canvasInDOM));
          html += row("canvas z-index", d.syncer.canvasZIndex);
          html += row("playback rate", d.syncer.playbackRate + "x", "num");

          var delayFrames = Math.round(d.delayMs / 1000 * 30);
          if (d.syncer.readHead < 0 && d.syncer.frameCount > 0) {
            html += row("ISSUE", "Capturing frames (" + d.syncer.frameCount + ") but readHead=-1. Buffer not yet filled to " + d.delayMs + "ms delay.", "warn");
            if (d.syncer.frameCount > delayFrames * 1.5) {
              html += row("ISSUE", "frameCount (" + d.syncer.frameCount + ") >> expected delay frames (" + delayFrames + "). Timestamps may be wrong.", "off");
            }
          }
        }

        if (d.captions) {
          html += "<tr><td colspan=\"2\" style=\"color:#8b949e;padding-top:6px\">-- Captions --</td></tr>";
          html += row("strategy", d.captions.strategy);
          html += row("S1 dom", d.captions.domContainer ? "attached" : "no", valClass(d.captions.domContainer));
          html += row("S1 hasContent", d.captions.domHasContent, valClass(d.captions.domHasContent));
          html += row("S1 queue", d.captions.domQueueLen, "num");
          html += row("S2 activeTracks", d.captions.hasActiveTracks, valClass(d.captions.hasActiveTracks));
          html += row("S2 queue", d.captions.cueQueueLen, "num");
          html += row("S4 found", d.captions.owFoundContainer ? "yes" : "no", valClass(d.captions.owFoundContainer));
          html += row("S4 queue", d.captions.owQueueLen, "num");
          html += row("overlay in DOM", d.captions.overlayInDOM, valClass(d.captions.overlayInDOM));
          html += row("overlay text", d.captions.overlayText || "(empty)");

          if (d.captions.logs.length) {
            html += "<tr><td colspan=\"2\"><div class=\"log\">";
            for (var i = 0; i < d.captions.logs.length; i++) {
              html += "<div>" + d.captions.logs[i] + "</div>";
            }
            html += "</div></td></tr>";
          }
        }

        if (d.controls) {
          html += "<tr><td colspan=\"2\" style=\"color:#8b949e;padding-top:6px\">-- Controls --</td></tr>";
          html += row("class", d.controls.class);
          html += row("z-index", d.controls.zIndex, "num");
          html += row("visibility", d.controls.visibility, valClass(d.controls.visibility === "visible"));
          html += row("pointer-events", d.controls.pointerEvents, valClass(d.controls.pointerEvents === "auto"));
        }

        html += "</table></div>";
      } catch (e) {
        // Tab doesn't have content script
      }
    }

    container.innerHTML = html || "<div style=\"color:#8b949e\">No tabs with content scripts responding</div>";
  } catch (e) {
    document.getElementById("tabs-content").innerHTML = "<div class=\"val off\">Error: " + e.message + "</div>";
  }
}

async function pollStorage() {
  var local = await chrome.storage.local.get(null);
  var sync = await chrome.storage.sync.get(null);

  var t = document.getElementById("storage-table");
  var html = "<tr><td colspan=\"2\" style=\"color:#58a6ff\">-- local --</td></tr>";
  for (var k in local) {
    html += row(k, JSON.stringify(local[k]));
  }
  html += "<tr><td colspan=\"2\" style=\"color:#58a6ff\">-- sync --</td></tr>";
  for (var k in sync) {
    html += row(k, JSON.stringify(sync[k]));
  }
  t.innerHTML = html;
}

async function togglePower() {
  var resp = await chrome.runtime.sendMessage({ type: "bgDiagnostics" });
  chrome.runtime.sendMessage({ type: "updateUI", isOn: !resp?.isOn });
  setTimeout(poll, 500);
}

function resetDelay() {
  chrome.storage.local.set({ syncDelay: 6200, _delayMigrated: true });
  chrome.storage.local.get(null, function(data) {
    var toClear = {};
    for (var k in data) {
      if (k.indexOf("syncDelay:") === 0) toClear[k] = 6200;
    }
    chrome.storage.local.set(toClear);
    setTimeout(poll, 500);
  });
}

function clearMigration() {
  chrome.storage.local.remove("_delayMigrated");
  setTimeout(poll, 500);
}

function forceRefresh() { poll(); }

async function poll() {
  var t0 = Date.now();
  await Promise.all([pollBg(), pollTabs(), pollStorage()]);
  document.getElementById("status").textContent = "Updated " + new Date().toLocaleTimeString() + " (" + (Date.now() - t0) + "ms)";
}

poll();
setInterval(poll, 2000);
