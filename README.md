# ChatGPT Long Chat Loader

Chrome MV3 extension for reducing long ChatGPT conversation load and RAM pressure.

Default README language: English. For Korean documentation, open [`README.ko.md`](./README.ko.md) or use the **한국어 README** button in the extension popup.

## v1.1.0 focus

v1.1.0 prioritizes ChatGPT answer progress stability over aggressive network optimization.

### Fixed / changed

- Added a stronger **Thinking Shield**.
- Thinking/reasoning/status elements are detected and protected for up to 15 minutes.
- During thinking/reasoning, conversation GET responses pass through unchanged.
- Current thinking/reasoning turns are never hidden, never `aria-hidden`, and never CSS-contained.
- The latest tail of the conversation is always live-protected even when ChatGPT does not expose a clear streaming marker.
- The MAIN-world fetch patch treats active thinking/reasoning nodes in the conversation graph as live generation and bypasses trimming.
- Network Safe Mode remains enabled by default: the extension rewrites at most the initial conversation load for a route, then lets later refresh/recovery requests pass through unchanged.
- Passive safety lock remains enabled for unusual/suspicious activity notices.
- Initial content-script overhead is lower because `content.js` runs at `document_idle`; the MAIN-world fetch patch still runs at `document_start`.

## Defaults

| Setting | Default |
|---|---:|
| Enabled | on |
| Initial API trimming | on |
| Network Safe Mode | on |
| Recent turns | 3 |
| Load-more batch | 4 |
| API prefetch batches | 1 |
| Response micro-cache entries | 1 |
| Cache item limit | 512 KB |
| Maintenance interval | 45 sec |
| Status badge | off |

## Popup diagnostics

The popup estimates performance only while it is open. It can show:

- estimated loading improvement
- API trim count and estimated size reduction
- DOM visible/hidden counts
- response live-protection state
- Thinking Shield state
- live API original-pass state
- safety lock state
- micro-cache state
- content/main script versions

## Installation

1. Extract the ZIP.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Click **Load unpacked**.
5. Select the extracted extension folder.
6. Refresh existing ChatGPT tabs.
7. Open the popup and confirm `API patch: MAIN 1.1.0`.

## Notes on unusual-activity warnings

This extension does not bypass OpenAI security systems. If ChatGPT displays an unusual/suspicious activity warning, the extension enters a passive safety lock and stops conversation-response rewriting temporarily. VPNs, proxies, browser/device sessions, network reputation, and account security can still trigger warnings independently of the extension.

## Update helper

The popup includes GitHub update buttons. The repository URL is fixed internally and is not shown as an editable field. Chrome unpacked extensions cannot replace their own files automatically, so the helper downloads the latest ZIP and opens the extension-management page.

## Limitations

- Authenticated long-conversation E2E benchmarks must be run in your own ChatGPT session.
- ChatGPT DOM/API changes may still require selector or trim-logic updates.
- Full server-side model context is not reduced; this targets browser loading, rendering, and memory pressure.
