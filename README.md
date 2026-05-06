# ChatGPT Long Chat Loader v0.5.0

[한국어 README](README.ko.md)

Chrome MV3 extension for reducing ChatGPT long-conversation loading, rendering, and RAM pressure.

## What changed in v0.5.0

This release fixes three user-facing issues found in v0.4.1:

1. **Micro-cache default is forced back to 1.** Existing stored values such as `apiCacheEntries: 0` are normalized and written back to `chrome.storage.local` when the popup opens.
2. **Popup estimates recover when the content script was not injected.** The popup now uses `activeTab` + `scripting` as a fallback. If the active ChatGPT tab was already open before the extension was installed or updated, clicking the popup injects `content.js` and `content.css`, then recalculates the metrics.
3. **Load-more is more visible.** The load-more control is now inserted as a body-level floating button. This avoids cases where ChatGPT's message container, flex layout, virtual scroll wrapper, or clipped parent hides the button.

The popup also reports the detected content-script version, MAIN-world API patch version, load-more state, micro-cache settings, DOM count, and popup-only estimated speedup.

## Problem cause

Long ChatGPT conversations can become slow because the browser receives a large conversation graph, parses it into JavaScript objects, lets the ChatGPT React app build state for old messages, and then keeps many Markdown/code/tool DOM nodes alive. Hiding old DOM after the fact helps scrolling, but the larger improvement comes from shrinking the conversation response before React ingests it.

## What this extension does

1. Patches `window.fetch` in the page MAIN world at `document_start`.
2. Intercepts `GET /backend-api/conversation/<id>` and `GET /backend-api/f/conversation/<id>` JSON responses.
3. Keeps only the current conversation chain tail before ChatGPT React consumes it.
4. Drops old visible user/assistant nodes and old tool nodes before the cutoff while preserving root/system/developer scaffolding.
5. Uses a bounded one-entry micro-cache by default instead of a zero-cache or unbounded body cache.
6. Keeps old DOM turns hidden behind a floating `Load more` control when the full DOM is already present.
7. Applies `content-visibility:auto` to visible turns where supported.
8. Runs a lightweight periodic maintenance pass while a chat page is visible.
9. Calculates estimated speedup only when the extension popup is opened.

## Cache policy

| Item | Default |
|---|---:|
| Response micro-cache entries | 1 |
| Maximum entries | 2 |
| Per-entry body limit | 1024 KB |
| Entry TTL | 60 seconds |
| Memory-pressure cutoff | clears stored entries |
| Route change | clears stored entries |

The cache stores only the trimmed response body, not the original full conversation body. The configured cache size is never normalized below 1, but the runtime cache map can still be temporarily empty after route changes, TTL expiry, memory pressure, or when a trimmed body exceeds the size limit.

## Maintenance behavior during a long chat

- New messages are handled by `MutationObserver` and a throttled scan.
- A visible chat tab runs a maintenance pass every 30 seconds by default.
- Maintenance prunes the bounded response micro-cache by count, TTL, body size, and memory pressure.
- Maintenance re-applies DOM windowing so long chats keep the same visible tail after new turns are appended.
- Maintenance clears stale API-trim stats so popup estimates do not use old conversation data.
- The loop is disabled when the tab is hidden or when the current route is not a likely chat surface.

The extension does not delete ChatGPT-owned React DOM nodes because removing nodes owned by React can break hydration, branch navigation, editing, and scroll restoration. The safer approach is to avoid creating old nodes through API trim, then hide or contain existing nodes when the full DOM is already present.

## Popup-only estimated speedup

The extension does not continuously calculate speedup on the page. When the popup opens, it requests a one-time snapshot from the active tab and estimates improvement from:

- API message reduction
- API JSON size reduction, using string length to avoid extra `TextEncoder` or `Blob` buffers
- hidden DOM turn ratio
- `content-visibility` support
- JS heap, when Chromium exposes `performance.memory`

This is an estimate, not a controlled benchmark.

## GPU and RAM notes

- The extension does not force `will-change`, `translateZ(0)`, or layer promotion. For text-heavy long chats, forced layer creation can increase GPU memory and layer-management overhead.
- The extension cannot toggle Chrome hardware acceleration. Check `chrome://gpu` manually if GPU compositing is suspected.
- The most important RAM reduction is avoiding full React state/DOM creation for old messages during conversation load.
- A JSON response must still be read and parsed once to rewrite it. That peak cannot be fully eliminated from an extension that rewrites `fetch` responses.
- The micro-cache is intentionally small. It is meant to avoid repeated parse work, not to retain many old conversations.

## Install

1. Unzip this package.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Click **Load unpacked**.
5. Select the `chatgpt-long-chat-loader-v0.5.0` folder.
6. Open or reload a long conversation on `https://chatgpt.com`.
7. Click the extension icon to view the current-tab estimate and settings.

If the popup reports `API patch: missing`, reload the ChatGPT tab. The DOM optimizer and estimate fallback can be injected into an already-open tab, but the early MAIN-world fetch patch works best after a page reload.

## Limitations

- Authenticated long-conversation E2E testing is required for final performance numbers.
- ChatGPT internal DOM/API changes may require selector or endpoint updates.
- Full-history search, old message editing, and old branch navigation require the `Load full conversation` bypass.
- Server-side model context is not reduced; only browser UI loading/rendering pressure is reduced.
- Shared chats may use different delivery paths; DOM windowing may still help, but API trim is not guaranteed there.

## Privacy

No message content is sent to an external server. Settings are stored in `chrome.storage.local` and bridged to the page via `localStorage` for MAIN-world access.
