/**
 * Voice Isolate — Video Frame Delay + Caption Delay for A/V sync.
 *
 * Video: Canvas overlay buffers and shows frames delayed.
 * Captions: Three strategies tried in order:
 *   1. DOM observer on known player caption containers (YouTube, JW, Video.js)
 *   2. Native TextTrack interception — hides native rendering, replays cues
 *      delayed in a custom overlay via cuechange events
 *   3. Generic DOM scan for caption-like elements near the video
 */

(() => {
  "use strict";

  let delayMs = 6200;
  const POLL_INTERVAL = 2000;

  let active = false;
  let syncer = null;
  let captionDelayer = null;

  // =========================================================================
  // VideoSyncer — delays video frames via canvas overlay
  // =========================================================================

  class VideoSyncer {
    constructor(video) {
      this.video = video;
      this.canvas = null;
      this.ctx = null;
      this.buffer = [];
      this.maxBuffer = 200;  // ~6s at 24-30fps + headroom
      this.writeHead = 0;    // next slot to write into
      this.readHead = -1;    // last slot drawn (-1 = none yet)
      this.count = 0;        // total frames written (for fullness check)
      this.running = false;
      this._origOpacity = video.style.opacity;
      this._fixedParent = false;
      this._onCapture = this._capture.bind(this);
      this._onDraw = this._draw.bind(this);
      this._ro = null;
    }

    start() {
      if (this.running) return;
      this.running = true;

      const c = document.createElement("canvas");
      c.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1;";
      const controlStyle = document.createElement("style");
      controlStyle.textContent = `
        .jw-controls, .jw-controlbar, .jw-display, .jw-nextup-container,
        .vjs-control-bar, .vjs-big-play-button, .vjs-menu,
        .plyr__controls, .plyr__menu {
          z-index: 20 !important;
          pointer-events: auto !important;
        }
      `;
      document.head.appendChild(controlStyle);
      this._controlStyle = controlStyle;
      const parent = this.video.parentElement;
      if (parent && getComputedStyle(parent).position === "static") {
        parent.style.position = "relative";
        this._fixedParent = true;
      }
      this.video.insertAdjacentElement("afterend", c);
      this.canvas = c;
      this.ctx = c.getContext("2d");

      this.buffer = [];
      for (let i = 0; i < this.maxBuffer; i++) {
        const fc = document.createElement("canvas");
        fc.width = this.video.videoWidth || 1920;
        fc.height = this.video.videoHeight || 1080;
        this.buffer.push({ canvas: fc, ctx: fc.getContext("2d"), ts: 0 });
      }

      this._syncSize();
      this._videoHidden = false;

      this._ro = new ResizeObserver(() => this._syncSize());
      this._ro.observe(this.video);

      // Listen for seek to reset buffer (content jumps, old frames invalid).
      // Rate changes do NOT need a reset — timestamps use performance.now()
      // (wall clock), so the delay math works identically at any speed.
      this._onSeeked = () => {
        this._resetBuffer("seeked");
        // Show video directly until buffer refills (no frozen stale frame)
        this.video.style.opacity = this._origOpacity || "";
        this._videoHidden = false;
      };
      this.video.addEventListener("seeked", this._onSeeked);

      if (this.video.requestVideoFrameCallback) {
        this.video.requestVideoFrameCallback(this._onCapture);
      } else {
        this._fallbackCapture();
      }
      requestAnimationFrame(this._onDraw);

      console.log("[VoiceIsolate] Syncer started, delay=" + delayMs + "ms");
    }

    _resetBuffer(reason) {
      console.log("[VoiceIsolate] Buffer reset: " + reason);
      this.writeHead = 0;
      this.readHead = -1;
      this.count = 0;
      for (let i = 0; i < this.maxBuffer; i++) {
        this.buffer[i].ts = 0;
      }
    }

    stop() {
      this.running = false;
      this.video.style.opacity = this._origOpacity;
      if (this._fixedParent && this.video.parentElement) {
        this.video.parentElement.style.position = "";
      }
      if (this._onSeeked) { this.video.removeEventListener("seeked", this._onSeeked); this._onSeeked = null; }
      if (this.canvas) { this.canvas.remove(); this.canvas = null; }
      if (this._controlStyle) { this._controlStyle.remove(); this._controlStyle = null; }
      if (this._ro) { this._ro.disconnect(); this._ro = null; }
      this.buffer = [];
      this.writeHead = 0;
      this.readHead = -1;
      this.count = 0;
    }

    _syncSize() {
      if (!this.canvas || !this.video) return;
      const w = this.video.videoWidth || 1920;
      const h = this.video.videoHeight || 1080;
      // Only update if actually changed — setting canvas.width/height clears content
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
    }

    _fallbackCapture() {
      if (!this.running) return;
      this._capture(performance.now(), null);
      requestAnimationFrame(() => this._fallbackCapture());
    }

    _capture(now, _meta) {
      if (!this.running) return;
      const v = this.video;
      const idx = this.writeHead;
      const frame = this.buffer[idx];

      if (v.videoWidth && v.videoHeight) {
        if (frame.canvas.width !== v.videoWidth || frame.canvas.height !== v.videoHeight) {
          frame.canvas.width = v.videoWidth;
          frame.canvas.height = v.videoHeight;
          this._syncSize();
        }
      }

      try {
        frame.ctx.drawImage(v, 0, 0);
        frame.ts = now;
        this.writeHead = (idx + 1) % this.maxBuffer;
        this.count++;
        // If writeHead overtakes readHead, push readHead forward (drop oldest)
        if (this.count > this.maxBuffer && this.readHead === this.writeHead) {
          this.readHead = (this.readHead + 1) % this.maxBuffer;
        }
      } catch (e) {
        console.warn("[VoiceIsolate] drawImage failed (DRM?), disabling sync:", e.message);
        this.video.style.opacity = this._origOpacity;
      }

      if (v.requestVideoFrameCallback) {
        v.requestVideoFrameCallback(this._onCapture);
      }
    }

    _draw(now) {
      if (!this.running) return;

      // Advance readHead to the latest frame whose timestamp is old enough
      // Walk forward from readHead+1 toward writeHead
      const filled = Math.min(this.count, this.maxBuffer);
      if (filled > 0) {
        // Find the starting search position
        let searchStart;
        if (this.readHead < 0) {
          // Haven't drawn yet — start from the oldest frame in buffer
          searchStart = this.count <= this.maxBuffer ? 0 : this.writeHead;
        } else {
          searchStart = (this.readHead + 1) % this.maxBuffer;
        }

        // Walk forward looking for frames ready to display
        let advanced = false;
        for (let steps = 0; steps < filled; steps++) {
          const idx = (searchStart + steps) % this.maxBuffer;
          if (idx === this.writeHead) break; // caught up to writer
          const frame = this.buffer[idx];
          if (frame.ts === 0) break;
          if (now - frame.ts < delayMs) break;
          this.readHead = idx;
          advanced = true;
        }
      }

      if (this.readHead >= 0 && this.ctx) {
        const frame = this.buffer[this.readHead];
        this.ctx.drawImage(frame.canvas, 0, 0, this.canvas.width, this.canvas.height);
        if (!this._videoHidden) {
          this.video.style.opacity = "0";
          this._videoHidden = true;
          console.log("[VoiceIsolate] Canvas has frames, hiding video");
        }
      }

      requestAnimationFrame(this._onDraw);
    }
  }

  // =========================================================================
  // CaptionDelayer — universal caption delay
  // =========================================================================

  class CaptionDelayer {
    constructor(video) {
      this.video = video;
      this._running = false;
      // DOM-based caption delay
      this._domObserver = null;
      this._domStyle = null;
      this._domClone = null;
      this._domContainer = null;
      this._domTimeouts = [];
      // Native TextTrack delay
      this._overlay = null;
      this._overlayStyle = null;
      this._trackListeners = [];
      this._cueQueue = [];  // {text, showAt}
      this._cueTimer = null;
      // Generic DOM scan
      this._genericObserver = null;
      this._genericStyle = null;
      this._genericClone = null;
      this._genericContainer = null;
      this._genericTimeouts = [];
      // Debug
      this._debugLog = [];
      this._activeStrategy = "none";
    }

    _dlog(msg) {
      console.log("[VI] " + msg);
      this._debugLog.push(msg);
      if (this._debugLog.length > 30) this._debugLog.splice(0, 15);
    }

    /** Safely render caption text into the overlay (no innerHTML) */
    _showCue(text) {
      if (!this._overlay) return;
      if (text) {
        const span = document.createElement("span");
        span.className = "vi-cue";
        span.textContent = text;
        this._overlay.replaceChildren(span);
      } else {
        this._overlay.replaceChildren();
      }
    }

    start() {
      if (this._running) return;
      this._running = true;

      const foundDOM = this._tryDOMCaptions();

      // Only use native TextTrack strategy if no DOM captions found
      // (DOM strategy handles YouTube etc. better; TextTrack for streaming sites)
      if (!foundDOM) {
        this._setupNativeTextTracks();
      }

      // Strategy 4: Universal overlay watcher — starts only if S1 hasn't received content yet.
      // S1 may latch onto an empty container (e.g., .jw-captions exists but subtitles not loaded).
      // If S1 gets content later, S4 is stopped.
      setTimeout(() => {
        if (this._running && !this._hasActiveTracks && !this._owFoundContainer && !this._domHasContent) {
          this._setupOverlayWatcher();
        }
      }, 2000);

      // Periodic generic scan fallback — streaming sites load captions late
      this._genericScanTimer = setInterval(() => {
        if (!this._running) return;
        // Only scan if no strategy is actively producing content
        if (!this._hasActiveTracks && !this._genericContainer && !this._owFoundContainer && !this._domHasContent) {
          if (!this._domContainer) this._tryGenericScan();
        }
        // Start overlay watcher if not yet running and S1 has no content
        if (!this._hasActiveTracks && !this._owFoundContainer && !this._overlayWatcher && !this._domHasContent) {
          this._setupOverlayWatcher();
        }
      }, 3000);

      // S1 fallback: if S1 container stays empty for 15s, release the lock
      if (foundDOM) {
        this._domFallbackTimer = setTimeout(() => {
          if (!this._running || !this._domContainer) return;
          if (!this._domContainer.innerHTML.trim()) {
            this._dlog("S1 empty 15s, releasing lock");
            this._activeStrategy = "none";
            this._domContainer = null;
          }
        }, 15000);
      }

      // Display loop for Strategy 4 overlay queue
      this._owDisplayTimer = setInterval(() => {
        if (!this._running || !this._owQueue?.length) return;
        const now = performance.now();
        let latestReady = null;
        while (this._owQueue.length > 0 && this._owQueue[0].showAt <= now) {
          latestReady = this._owQueue.shift();
        }
        if (latestReady !== null) {
          this._showCue(latestReady.text);
        }
      }, 100);

      this._dlog("started, domFound=" + foundDOM);
    }

    stop() {
      this._running = false;
      // DOM captions (S1)
      if (this._domObserver) { this._domObserver.disconnect(); this._domObserver = null; }
      if (this._domStyle) { this._domStyle.remove(); this._domStyle = null; }
      if (this._domDisplayTimer) { clearInterval(this._domDisplayTimer); this._domDisplayTimer = null; }
      this._domQueue = [];
      this._domContainer = null;
      this._domHasContent = false;
      // Native TextTrack
      this._teardownNativeTextTracks();
      // Overlay watcher (Strategy 4)
      this._stopOverlayWatcher();
      if (this._owDisplayTimer) { clearInterval(this._owDisplayTimer); this._owDisplayTimer = null; }
      // Timers
      if (this._genericScanTimer) { clearInterval(this._genericScanTimer); this._genericScanTimer = null; }
      if (this._domFallbackTimer) { clearTimeout(this._domFallbackTimer); this._domFallbackTimer = null; }
      // Generic observer
      if (this._genericObserver) { this._genericObserver.disconnect(); this._genericObserver = null; }
      if (this._genericStyle) { this._genericStyle.remove(); this._genericStyle = null; }
      if (this._genericClone) { this._genericClone.remove(); this._genericClone = null; }
      this._genericTimeouts.forEach(t => clearTimeout(t));
      this._genericTimeouts = [];
      this._genericContainer = null;
    }

    updateDelay() {
      // Native text track overlay is event-driven, delay applied per-cue
      // No need to re-init, new delayMs is read dynamically
    }

    // ----- Strategy 1: Known DOM selectors -----

    static CAPTION_SELECTORS = [
      "#ytp-caption-window-container",   // YouTube
      ".jw-captions",                     // JW Player
      ".vjs-text-track-display",          // Video.js
      ".plyr__captions",                  // Plyr
      ".player-timedtext",                // Netflix
      ".caption-window",                  // YouTube alt
    ];

    _tryDOMCaptions() {
      for (const sel of CaptionDelayer.CAPTION_SELECTORS) {
        const container = document.querySelector(sel);
        if (container) {
          this._attachDOMClone(container, sel);
          return true;
        }
      }
      // Keep polling for late-loaded players
      let attempts = 0;
      const poll = () => {
        if (!this._running || this._domContainer) return;
        for (const sel of CaptionDelayer.CAPTION_SELECTORS) {
          const container = document.querySelector(sel);
          if (container) {
            this._attachDOMClone(container, sel);
            return;
          }
        }
        if (attempts++ < 15) setTimeout(poll, 2000);
      };
      setTimeout(poll, 2000);
      return false;
    }

    _attachDOMClone(container, selector) {
      this._domContainer = container;

      // Create our own overlay (same as S2/S4) — guaranteed visible at max z-index
      // Old approach (cloneNode) failed because the clone inherited JW Player CSS
      // that got buried behind our canvas overlay.
      if (!this._overlay) {
        this._overlay = document.createElement("div");
        this._overlay.id = "vi-caption-overlay";
        const parent = this.video?.parentElement;
        if (parent) parent.appendChild(this._overlay);
      }
      this._overlayStyle = document.createElement("style");
      this._overlayStyle.textContent = `
        #vi-caption-overlay {
          position: absolute; bottom: 10%; left: 0; width: 100%;
          text-align: center; pointer-events: none; z-index: 2;
        }
        #vi-caption-overlay .vi-cue {
          display: inline-block; padding: 3px 8px;
          background: rgba(0,0,0,0.75); color: #fff;
          font: 400 3.3vw/1.3 Arial, sans-serif;
          max-width: 80%; white-space: pre-wrap;
        }
      `;
      document.head.appendChild(this._overlayStyle);

      // Hide original captions
      this._domStyle = document.createElement("style");
      this._domStyle.textContent = `${selector} { visibility: hidden !important; }`;
      document.head.appendChild(this._domStyle);

      // Queue + display loop (same approach as S2/S4)
      this._domQueue = [];
      this._domLastText = "";

      this._domObserver = new MutationObserver(() => {
        const text = container.textContent?.trim() || "";
        if (text !== this._domLastText) {
          this._domLastText = text;
          if (text && !this._domHasContent) {
            this._domHasContent = true;
            this._dlog("S1 got content, stopping S4");
            this._stopOverlayWatcher();
          }
          this._domQueue.push({ text, showAt: performance.now() + delayMs, html: false });
          if (this._domQueue.length > 500) this._domQueue.splice(0, 250);
        }
      });
      this._domObserver.observe(container, {
        childList: true, subtree: true, attributes: true, characterData: true
      });

      // Display delayed subtitles from queue
      this._domDisplayTimer = setInterval(() => {
        if (!this._running || !this._domQueue?.length) return;
        const now = performance.now();
        let latestReady = null;
        while (this._domQueue.length > 0 && this._domQueue[0].showAt <= now) {
          latestReady = this._domQueue.shift();
        }
        if (latestReady !== null) {
          this._showCue(latestReady.text);
        }
      }, 100);

      this._activeStrategy = "s1-dom:" + selector;
      this._dlog("S1 DOM caption: " + selector);
    }

    // ----- Strategy 2: Native TextTrack — polling approach -----
    // Event-driven cuechange is unreliable on streaming sites (players override
    // track.mode, tracks load late, events don't fire). Poll activeCues instead.

    _setupNativeTextTracks() {
      const v = this.video;
      if (!v || !v.textTracks) return;

      this._hasActiveTracks = false;

      // Create overlay for delayed captions
      this._overlay = document.createElement("div");
      this._overlay.id = "vi-caption-overlay";
      const parent = v.parentElement;
      if (parent) parent.appendChild(this._overlay);

      this._overlayStyle = document.createElement("style");
      this._overlayStyle.textContent = `
        #vi-caption-overlay {
          position: absolute; bottom: 10%; left: 0; width: 100%;
          text-align: center; pointer-events: none; z-index: 2;
        }
        #vi-caption-overlay .vi-cue {
          display: inline-block; padding: 3px 8px;
          background: rgba(0,0,0,0.75); color: #fff;
          font: 400 3.3vw/1.3 Arial, sans-serif;
          max-width: 80%; white-space: pre-wrap;
        }
        video::cue { opacity: 0 !important; color: transparent !important; }
      `;
      document.head.appendChild(this._overlayStyle);

      // Delayed cue queue: [{text, showAt}]
      this._cueQueue = [];
      this._lastCueText = "";

      // Listen for dynamically added tracks
      this._onAddTrack = () => {
        this._dlog("track added, total=" + v.textTracks.length);
      };
      v.textTracks.addEventListener("addtrack", this._onAddTrack);

      // Poll every 200ms for active cues across all text tracks
      // Key rules:
      //   - "disabled" → change to "hidden" (activeCues is null when disabled,
      //     AND WebVTT file isn't loaded until mode changes — per spec)
      //   - "showing" → leave as-is (don't fight the player's rendering)
      //   - "hidden" → read activeCues normally
      // CSS video::cue hides native browser rendering for "showing" tracks.
      // Retry disabled→hidden every 2s (player may fight back and re-disable).
      this._pollInterval = setInterval(() => {
        if (!this._running || !v.textTracks) return;

        // Ensure overlay is still in DOM (player might remove it)
        if (this._overlay && !this._overlay.parentNode && v.parentElement) {
          v.parentElement.appendChild(this._overlay);
        }

        // Collect active cue text from all text tracks
        let currentText = "";
        let foundAny = false;
        const now = performance.now();
        for (let i = 0; i < v.textTracks.length; i++) {
          const track = v.textTracks[i];

          // Enable disabled subtitle/caption tracks so cues load and activeCues works
          // Retry every 2s — player may fight back and re-disable
          if (track.mode === "disabled" && (track.kind === "subtitles" || track.kind === "captions")) {
            if (!track._viLastEnable || now - track._viLastEnable > 2000) {
              track.mode = "hidden";
              track._viLastEnable = now;
              this._dlog("enabled track: " + (track.label || track.language || "track-" + i));
            }
          }

          // Skip still-disabled tracks (non subtitle/caption kinds)
          if (track.mode === "disabled") continue;
          if (!track.activeCues) continue;
          for (let j = 0; j < track.activeCues.length; j++) {
            const text = track.activeCues[j].text;
            if (text) {
              currentText += (currentText ? "\n" : "") + text;
              foundAny = true;
            }
          }
        }

        if (foundAny && !this._hasActiveTracks) {
          this._hasActiveTracks = true;
          this._activeStrategy = "s2-texttrack";
          this._dlog("S2 active: found cues");
        }

        // Only queue when text changes (avoid duplicate entries)
        if (currentText !== this._lastCueText) {
          this._lastCueText = currentText;
          this._cueQueue.push({
            text: currentText,
            showAt: performance.now() + delayMs
          });
          if (this._cueQueue.length > 500) this._cueQueue.splice(0, 250);
        }

        // Display queued cues that are ready
        const dispNow = performance.now();
        let latestReady = null;
        while (this._cueQueue.length > 0 && this._cueQueue[0].showAt <= dispNow) {
          latestReady = this._cueQueue.shift();
        }
        if (latestReady !== null) {
          this._showCue(latestReady.text);
        }
      }, 200);
    }

    _teardownNativeTextTracks() {
      if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
      if (this._onAddTrack && this.video?.textTracks) {
        this.video.textTracks.removeEventListener("addtrack", this._onAddTrack);
        this._onAddTrack = null;
      }
      // Restore tracks we enabled back to disabled
      if (this.video?.textTracks) {
        for (let i = 0; i < this.video.textTracks.length; i++) {
          const t = this.video.textTracks[i];
          if (t._viLastEnable) {
            try { t.mode = "disabled"; } catch {}
            delete t._viLastEnable;
          }
        }
      }
      this._hasActiveTracks = false;
      this._cueQueue = [];
      if (this._overlay) { this._overlay.remove(); this._overlay = null; }
      if (this._overlayStyle) { this._overlayStyle.remove(); this._overlayStyle = null; }
    }

    // ----- Strategy 3: Generic DOM scan (class-name based) -----

    _tryGenericScan() {
      if (!this._running || !this.video) return;

      const searchRoots = [
        this.video.parentElement,
        this.video.closest("[class*=player], [class*=Player], [class*=video], [class*=Video], [id*=player], [id*=video]"),
        document.body,
      ].filter(Boolean);

      const seen = new Set();
      for (const root of searchRoots) {
        if (seen.has(root)) continue;
        seen.add(root);
        const candidates = root.querySelectorAll(
          "[class*=caption], [class*=subtitle], [class*=cue], [class*=Caption], [class*=Subtitle], " +
          "[class*=track-text], [class*=subs], [class*=Subs], [id*=caption], [id*=subtitle]"
        );
        for (const el of candidates) {
          if (el === this._domClone || el.id === "vi-delayed-captions" ||
              el.id === "vi-caption-overlay" || el.id === "vi-generic-delayed") continue;
          if (el.offsetWidth > 0 && el.textContent?.trim()) {
            this._attachGenericClone(el);
            return;
          }
        }
      }
    }

    _attachGenericClone(container) {
      this._genericContainer = container;
      this._genericClone = container.cloneNode(false);
      this._genericClone.id = "vi-generic-delayed";
      container.parentNode.insertBefore(this._genericClone, container.nextSibling);

      this._genericStyle = document.createElement("style");
      const sel = container.id ? "#" + container.id :
                  container.className ? "." + container.className.split(/\s+/).join(".") : "";
      if (sel) {
        this._genericStyle.textContent =
          `${sel}:not(#vi-generic-delayed) > * { visibility: hidden !important; }
           #vi-generic-delayed * { visibility: visible !important; }`;
        document.head.appendChild(this._genericStyle);
      }

      this._genericObserver = new MutationObserver(() => {
        const html = container.innerHTML;
        const tid = setTimeout(() => {
          if (!this._running || !this._genericClone) return;
          this._genericClone.innerHTML = html;
        }, delayMs);
        this._genericTimeouts.push(tid);
        if (this._genericTimeouts.length > 200) this._genericTimeouts.splice(0, 100);
      });
      this._genericObserver.observe(container, {
        childList: true, subtree: true, attributes: true, characterData: true
      });
      this._activeStrategy = "s3-generic";
      this._dlog("S3 generic caption attached");
    }

    // ----- Strategy 4: Universal text overlay detector -----
    // Catches ANY text appearing over the video regardless of class names.
    // Works with obfuscated players that use random CSS classes.

    _setupOverlayWatcher() {
      if (!this._running || !this.video) return;
      if (this._overlayWatcher) return;

      const v = this.video;
      const vParent = v.parentElement;
      if (!vParent) return;

      // Create our delayed subtitle overlay
      if (!this._overlay) {
        this._overlay = document.createElement("div");
        this._overlay.id = "vi-caption-overlay";
        vParent.appendChild(this._overlay);

        this._overlayStyle = document.createElement("style");
        this._overlayStyle.textContent = `
          #vi-caption-overlay {
            position: absolute; bottom: 12%; left: 0; width: 100%;
            text-align: center; pointer-events: none; z-index: 2;
          }
          #vi-caption-overlay .vi-cue {
            display: inline-block; padding: 3px 8px;
            background: rgba(0,0,0,0.75); color: #fff;
            font: 400 3.3vw/1.3 Arial, sans-serif;
            max-width: 80%; white-space: pre-wrap;
          }
        `;
        document.head.appendChild(this._overlayStyle);
      }

      this._owLastText = "";
      this._owQueue = [];  // {text, showAt}
      this._owFoundContainer = null;

      // Find the player root — walk UP from video to find the outermost positioned container
      // Streaming players nest deeply: div > div > div > video, with subtitles as siblings
      // of an ancestor several levels up
      let watchRoot = vParent;
      let el = vParent;
      for (let i = 0; i < 8 && el && el !== document.body; i++) {
        const pos = getComputedStyle(el).position;
        if (pos === "relative" || pos === "absolute" || pos === "fixed") {
          watchRoot = el;
        }
        el = el.parentElement;
      }
      this._owWatchRoot = watchRoot;

      this._overlayWatcher = new MutationObserver(() => {
        if (!this._running) return;
        this._scanForTextOverlays();
      });
      this._overlayWatcher.observe(watchRoot, {
        childList: true, subtree: true, characterData: true
      });
      this._dlog("S4 watch root: " + watchRoot.tagName + "." + (watchRoot.className?.toString?.()?.substring(0, 30) || ""));

      // Also poll periodically (some players update text without DOM mutations)
      this._owPoll = setInterval(() => {
        if (!this._running) return;
        this._scanForTextOverlays();
      }, 300);

      this._dlog("S4 overlay watcher started");
    }

    _scanForTextOverlays() {
      const v = this.video;
      if (!v) return;
      const vRect = v.getBoundingClientRect();
      const scanRoot = this._owWatchRoot || v.parentElement;
      if (!scanRoot) return;

      // If we already found the subtitle container, just read its text
      if (this._owFoundContainer) {
        // Check it's still in DOM
        if (!this._owFoundContainer.parentElement) {
          this._dlog("S4 element removed, rescanning");
          this._owFoundContainer = null;
        } else {
          const text = this._owFoundContainer.textContent?.trim() || "";
          this._queueOverlayText(text);
          return;
        }
      }

      // Scan from the player root for text elements overlapping the video's bottom region.
      // Don't require position:absolute/fixed — some players use flexbox/transform/relative.
      const children = scanRoot.querySelectorAll("*");
      for (const el of children) {
        if (el === v || el === this._overlay || el === this._domClone || el === this._genericClone) continue;
        if (el.id === "vi-caption-overlay" || el.id === "vi-debug" || el.id === "vi-delayed-captions" || el.id === "vi-generic-delayed") continue;
        if (el.tagName === "VIDEO" || el.tagName === "CANVAS" || el.tagName === "SOURCE" || el.tagName === "STYLE" || el.tagName === "SCRIPT") continue;
        // Skip elements hidden by Strategy 1/3
        try { if (getComputedStyle(el).visibility === "hidden") continue; } catch {}

        // Must have text content
        const text = el.textContent?.trim();
        if (!text || text.length < 2 || text.length > 500) continue;

        // Must be visible and overlap with the video area
        const elRect = el.getBoundingClientRect();
        if (elRect.width < 50 || elRect.height < 5) continue;
        // Must overlap horizontally with video
        if (elRect.right < vRect.left + 20 || elRect.left > vRect.right - 20) continue;
        // Must be in the bottom 60% of the video (subtitles area)
        const vTop40 = vRect.top + vRect.height * 0.4;
        if (elRect.top < vTop40) continue;
        // Must not be below the video
        if (elRect.top > vRect.bottom) continue;

        // Must not be a button/control/nav element
        if (el.tagName === "BUTTON" || el.tagName === "INPUT" || el.tagName === "A" || el.tagName === "NAV" || el.tagName === "LABEL") continue;
        if (el.querySelector("button, input, select, [role=button], [role=slider], svg")) continue;
        // Skip elements with too many children (controls bar, not subtitles)
        if (el.children.length > 10) continue;
        // Skip time displays and player controls
        const cls = (el.className?.toString?.() || "").toLowerCase();
        if (/slider|time|control|progress|seek|scrub|toolbar|menu|icon|button|jw-|vjs-|plyr|settings|tooltip|overlay-(?!sub)/.test(cls)) continue;
        // Skip by role attribute
        const role = el.getAttribute("role") || "";
        if (/button|slider|toolbar|menu|tab|dialog|navigation/i.test(role)) continue;
        // Skip text that looks like a timestamp (e.g., "45:05", "1:23:45")
        if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(text)) continue;
        // Skip if element or ancestor has pointer-events:auto (likely interactive control)
        try {
          let ancestor = el;
          let isControl = false;
          for (let i = 0; i < 3 && ancestor && ancestor !== scanRoot; i++) {
            const aCls = (ancestor.className?.toString?.() || "").toLowerCase();
            if (/control|toolbar|jw-controls|vjs-control/i.test(aCls)) { isControl = true; break; }
            ancestor = ancestor.parentElement;
          }
          if (isControl) continue;
        } catch {}

        // Found a subtitle overlay!
        this._owFoundContainer = el;
        this._activeStrategy = "s4-overlay";
        this._dlog("S4 found: " + el.tagName + "." + (el.className?.toString?.()?.substring(0, 40) || "") + " = " + text.substring(0, 30));

        // Hide the original text — use opacity instead of visibility to avoid
        // breaking parent layout or hiding sibling controls
        el.style.setProperty("opacity", "0", "important");
        el.style.setProperty("pointer-events", "none", "important");

        // Watch this specific element for changes
        if (this._overlayWatcher) this._overlayWatcher.disconnect();
        this._overlayWatcher = new MutationObserver(() => {
          if (!this._running) return;
          const t = this._owFoundContainer?.textContent?.trim() || "";
          this._queueOverlayText(t);
        });
        this._overlayWatcher.observe(el, {
          childList: true, subtree: true, characterData: true
        });
        // Also watch parent in case player replaces the element entirely
        if (el.parentElement) {
          this._overlayWatcherParent = new MutationObserver(() => {
            if (!this._running) return;
            // Check if our found container was removed/replaced
            if (!el.parentElement) {
              this._owFoundContainer = null;
              this._dlog("S4 container removed, rescanning");
            }
          });
          this._overlayWatcherParent.observe(el.parentElement, { childList: true });
        }

        this._queueOverlayText(text);
        return;
      }
    }

    _queueOverlayText(text) {
      if (text === this._owLastText) return;
      this._owLastText = text;
      this._hasActiveTracks = true;

      this._owQueue.push({
        text,
        showAt: performance.now() + delayMs
      });
      if (this._owQueue.length > 500) this._owQueue.splice(0, 250);
    }

    _stopOverlayWatcher() {
      if (this._overlayWatcher) { this._overlayWatcher.disconnect(); this._overlayWatcher = null; }
      if (this._overlayWatcherParent) { this._overlayWatcherParent.disconnect(); this._overlayWatcherParent = null; }
      if (this._owPoll) { clearInterval(this._owPoll); this._owPoll = null; }
      if (this._owFoundContainer) {
        try {
          this._owFoundContainer.style.removeProperty("opacity");
          this._owFoundContainer.style.removeProperty("pointer-events");
        } catch {}
        this._owFoundContainer = null;
      }
      this._owQueue = [];
    }
  }

  // =========================================================================
  // Video detection & lifecycle
  // =========================================================================

  function findVideo() {
    const videos = document.querySelectorAll("video");
    for (const v of videos) {
      if (v.readyState >= 2 && v.videoWidth > 0) return v;
    }
    return videos.length > 0 ? videos[0] : null;
  }

  function activate() {
    if (active) return;
    active = true;
    tryAttach();
    startVideoObserver();
  }

  function deactivate() {
    active = false;
    if (syncer) { syncer.stop(); syncer = null; }
    if (captionDelayer) { captionDelayer.stop(); captionDelayer = null; }
    stopVideoObserver();
  }

  let videoObserver = null;
  function startVideoObserver() {
    if (videoObserver) return;
    videoObserver = new MutationObserver(() => {
      if (!active) return;
      if (syncer && syncer.running) {
        // Already attached — stop observing the whole DOM tree (performance)
        videoObserver.disconnect();
        videoObserver = null;
        return;
      }
      tryAttach();
    });
    videoObserver.observe(document.documentElement, {
      childList: true, subtree: true
    });
  }
  function stopVideoObserver() {
    if (videoObserver) { videoObserver.disconnect(); videoObserver = null; }
  }

  function tryAttach() {
    if (!active) return;
    const video = findVideo();
    if (!video) {
      setTimeout(tryAttach, POLL_INTERVAL);
      return;
    }
    if (syncer && syncer.video === video && syncer.running) return;
    if (syncer) syncer.stop();
    syncer = new VideoSyncer(video);
    syncer.start();

    if (captionDelayer) captionDelayer.stop();
    captionDelayer = new CaptionDelayer(video);
    captionDelayer.start();
  }

  // --- SPA navigation ---
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (syncer) { syncer.stop(); syncer = null; }
      if (captionDelayer) { captionDelayer.stop(); captionDelayer = null; }
      if (active) setTimeout(tryAttach, 500);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // --- Messages ---
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "voiceIsolateState") {
      console.log("[VoiceIsolate] state msg: isOn=" + msg.isOn);
      if (msg.isOn) {
        activate();
      } else {
        deactivate();
      }
    }
    if (msg.type === "syncDelayChanged" && typeof msg.delay === "number") {
      delayMs = msg.delay;
      if (captionDelayer) captionDelayer.updateDelay();
    }
    if (msg.type === "getDiagnostics") {
      const d = { frame: location.href.substring(0, 120), hostname, delayMs, active };
      // Video
      const v = syncer?.video;
      if (v) {
        d.video = {
          src: (v.src || v.currentSrc || "").substring(0, 80),
          readyState: v.readyState,
          paused: v.paused,
          currentTime: Math.round(v.currentTime * 10) / 10,
          videoWidth: v.videoWidth,
          videoHeight: v.videoHeight,
          opacity: v.style.opacity,
          networkState: v.networkState,
        };
      } else {
        const vids = document.querySelectorAll("video");
        d.video = { found: vids.length, note: vids.length ? "found but syncer not attached" : "no video element" };
      }
      // Canvas / Syncer
      if (syncer) {
        d.syncer = {
          running: syncer.running,
          frameCount: syncer.count,
          writeHead: syncer.writeHead,
          readHead: syncer.readHead,
          maxBuffer: syncer.maxBuffer,
          bufferFill: syncer.count > 0 ? Math.min(syncer.count, syncer.maxBuffer) : 0,
          canvasSize: syncer.canvas ? `${syncer.canvas.width}x${syncer.canvas.height}` : "none",
          canvasInDOM: !!syncer.canvas?.parentElement,
          canvasZIndex: syncer.canvas ? getComputedStyle(syncer.canvas).zIndex : "n/a",
          videoHidden: !!syncer._videoHidden,
          playbackRate: syncer.video?.playbackRate || 1,
        };
      }
      // Captions
      if (captionDelayer) {
        d.captions = {
          strategy: captionDelayer._activeStrategy,
          domContainer: !!captionDelayer._domContainer,
          domHasContent: !!captionDelayer._domHasContent,
          domQueueLen: captionDelayer._domQueue?.length || 0,
          hasActiveTracks: !!captionDelayer._hasActiveTracks,
          cueQueueLen: captionDelayer._cueQueue?.length || 0,
          owFoundContainer: !!captionDelayer._owFoundContainer,
          owQueueLen: captionDelayer._owQueue?.length || 0,
          overlayInDOM: !!captionDelayer._overlay?.parentElement,
          overlayText: captionDelayer._overlay?.textContent?.trim()?.substring(0, 50) || "",
          logs: captionDelayer._debugLog?.slice(-10) || [],
        };
      }
      // Controls
      const controls = document.querySelector(".jw-controls, .vjs-control-bar, .plyr__controls");
      if (controls) {
        const cs = getComputedStyle(controls);
        d.controls = { class: controls.className.substring(0, 40), zIndex: cs.zIndex, visibility: cs.visibility, pointerEvents: cs.pointerEvents };
      }
      sendResponse(d);
      return true;
    }
  });

  // Load per-site delay, fallback to global, fallback to default 6200
  // Auto-migrate: old defaults (1650-3000) are from v8 (2s segments).
  // v9 uses 10s segments → default 6200ms. Reset stale values.
  const hostname = location.hostname.replace(/^www\./, "");
  const siteDelayKey = "syncDelay:" + hostname;
  chrome.storage.local.get(["syncDelay", siteDelayKey, "_delayMigrated"], (data) => {
    if (!data._delayMigrated) {
      // One-time migration: clear old delays so new default takes effect
      const toClear = {};
      if (data.syncDelay != null && data.syncDelay < 5000) toClear.syncDelay = 6200;
      if (data[siteDelayKey] != null && data[siteDelayKey] < 5000) toClear[siteDelayKey] = 6200;
      toClear._delayMigrated = true;
      chrome.storage.local.set(toClear);
      delayMs = 6200;
    } else {
      if (data[siteDelayKey] != null) {
        delayMs = data[siteDelayKey];
      } else if (data.syncDelay != null) {
        delayMs = data.syncDelay;
      }
    }
  });

  // Read _isOn directly from storage — doesn't rely on service worker being alive
  // Background auto-toggle controls _isOn per-site, content script just follows it
  chrome.storage.local.get(["_isOn"], (data) => {
    console.log("[VoiceIsolate] init: hostname=" + hostname + " _isOn=" + data._isOn);
    if (data._isOn) {
      activate();
    }
  });

  // Test mode: auto-activate when URL has ?vi-test for headless testing
  if (location.search.includes("vi-test")) {
    console.log("[VoiceIsolate] Test mode: auto-activating");
    delayMs = 2000;  // short delay for testing
    setTimeout(() => activate(), 1000);  // delay to let page create video
  }

  // Also try background getState as secondary source (may provide more info)
  try {
    chrome.runtime.sendMessage({ type: "getState" }, (response) => {
      if (chrome.runtime.lastError) return;
      console.log("[VoiceIsolate] getState: isOn=" + response?.isOn + " videoDelay=" + response?.videoDelay);
      if (response?.videoDelay || response?.isOn) {
        activate();
      }
    });
  } catch (e) {
    // SW not available — storage read above handles it
  }
})();
