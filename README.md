# Voice Isolate

Chrome extension that isolates vocals from browser audio in real-time, stripping music and sound effects while keeping speech clear. Pairs with a native audio processor and compensates for processing latency by delaying video frames and captions to maintain perfect A/V sync.

## What it does

**Audio processing** (via native host): Routes browser audio through a GPU-accelerated voice isolation model. You control voice volume and music/SFX bleed level.

**Video delay sync** (in-browser): The audio processor introduces latency (~6 seconds). This extension compensates by buffering video frames on a canvas overlay and displaying them delayed, so lips stay in sync with the processed audio. Works at any playback speed.

**Caption delay**: Automatically detects and delays subtitles/captions to match the video delay. Four detection strategies cover YouTube, JW Player, Video.js, Plyr, Netflix, native TextTracks, and any site with text overlays near the video.

## Features

- Toggle on/off from popup or keyboard shortcut (Ctrl+Super+V)
- Per-site auto-enable whitelist — automatically activates on your streaming sites
- Adjustable voice volume (0-150%), music bleed (0-100%), and sync delay
- Per-site delay settings (different sites may need different values)
- Works in iframes and cross-origin embedded players
- Handles SPA navigation, dynamic video loading, DRM-protected content gracefully
- Debug dashboard for diagnostics (`chrome-extension://<id>/debug.html`)

## Architecture

```
┌─────────────────────────────────────────────┐
│  Browser Tab                                │
│                                             │
│  ┌─────────┐    canvas     ┌─────────────┐  │
│  │  video   │──drawImage──▶│ frame buffer │  │
│  │ (hidden) │              │  (200 slots) │  │
│  └─────────┘              └──────┬──────┘  │
│                                  │ delayed  │
│                           ┌──────▼──────┐  │
│                           │ canvas overlay│  │
│                           │ (user sees)  │  │
│                           └─────────────┘  │
│                                             │
│  Captions: DOM observer / TextTrack poll /  │
│  generic scan / universal overlay watcher   │
│  → queued → displayed after delay           │
└──────────────────┬──────────────────────────┘
                   │ native messaging
          ┌────────▼────────┐
          │  Audio Processor │
          │  (native host)   │
          │  GPU voice model │
          └─────────────────┘
```

## Installation

### Chrome Extension

1. Clone this repo
2. Open `chrome://extensions/` in Chrome
3. Enable "Developer mode" (top right)
4. Click "Load unpacked" and select this directory
5. Pin the extension to your toolbar

### Native Host (required for audio processing)

The extension communicates with an external audio processor via Chrome's [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) API. You need to provide your own native host that:

1. Registers as `com.zeino.voice_isolate` (or change `HOST_NAME` in `background.js` and `popup.js`)
2. Accepts JSON messages: `{"command": "turn_on"}`, `{"command": "turn_off"}`, `{"command": "status"}`, `{"command": "set_levels", "voiceVolume": 100, "musicBleed": 0}`
3. Returns JSON responses: `{"status": "on"}` or `{"status": "off"}`

The native host manifest goes in:
- **Linux**: `~/.config/google-chrome/NativeMessagingHosts/com.zeino.voice_isolate.json`
- **macOS**: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.zeino.voice_isolate.json`
- **Windows**: Registry key under `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.zeino.voice_isolate`

Example manifest:
```json
{
  "name": "com.zeino.voice_isolate",
  "description": "Voice isolation audio processor",
  "path": "/path/to/your/processor",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID/"]
}
```

### Video delay only (no audio processing)

If you just want the video/caption delay (e.g., you have your own external audio processing setup), the extension works without a native host. Open the popup, toggle it on — the video delay and caption sync will activate. The audio controls won't function, but the sync features work independently.

## Caption Delay Strategies

The extension tries four strategies in order to find and delay captions:

| Strategy | Method | Sites |
|----------|--------|-------|
| S1 | DOM observer on known selectors | YouTube, JW Player, Video.js, Plyr, Netflix |
| S2 | Native TextTrack polling | Any site using `<track>` elements or `addTextTrack()` |
| S3 | Generic DOM scan by class name | Sites with `caption`, `subtitle`, `cue` in CSS classes |
| S4 | Universal overlay watcher | Any text element overlapping the video's bottom region |

S1 is tried first. If it finds a container but gets no content within 15 seconds, the lock is released. S2 runs in parallel unless S1 found a container. S4 activates as a fallback after 2 seconds if nothing else is producing content. When a higher-priority strategy starts producing content, lower ones are stopped.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension manifest (MV3) |
| `background.js` | Service worker — native messaging, auto-toggle, state management |
| `content.js` | Content script — video frame buffer, canvas overlay, caption delay |
| `popup.html/js` | Popup UI — power toggle, volume/bleed/delay sliders, site whitelist |
| `debug.html/js` | Debug dashboard — per-tab diagnostics, storage inspector |
| `icons/` | Extension icons (on/off states, 16/48/128px) |

## How the video sync works

1. `requestVideoFrameCallback` captures each video frame into a circular buffer of 200 canvas slots
2. Each frame is timestamped with `performance.now()` (wall clock time)
3. On every `requestAnimationFrame`, the display loop finds the latest frame whose timestamp is older than `delayMs` and draws it to the visible canvas overlay
4. The original video element is hidden (`opacity: 0`) once the buffer has frames to show
5. On seek, the buffer is cleared and the video is shown directly until the buffer refills

The wall-clock timestamp approach means the delay math works correctly at any playback speed — no special handling needed for 0.5x, 2x, etc.

## License

MIT
