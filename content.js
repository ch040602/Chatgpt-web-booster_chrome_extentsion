(() => {
  "use strict";

  const CONTENT_VERSION = "0.5.0";
  const CONTENT_BOOT_FLAG = "__CGPT_LONG_CHAT_LOADER_CONTENT_ACTIVE__";
  if (window[CONTENT_BOOT_FLAG]) {
    try {
      window.dispatchEvent(new CustomEvent("cgpt-lb-force-scan", { detail: CONTENT_VERSION }));
    } catch {
      // Ignore duplicate-injection notification failures.
    }
    return;
  }
  window[CONTENT_BOOT_FLAG] = CONTENT_VERSION;

  const SETTINGS_KEY = "cgptLongChatLoader.settings";
  const SETTINGS_ATTR = "data-cgpt-lb-settings";
  const TRIMMED_ATTR = "data-cgpt-lb-api-trimmed";
  const KEPT_ATTR = "data-cgpt-lb-api-kept";
  const STATS_ATTR = "data-cgpt-lb-api-stats";
  const BYPASS_KEY = "cgptLongChatLoader.bypassOnce";
  const SETTINGS_EVENT = "cgpt-lb-settings";
  const STATS_EVENT = "cgpt-lb-trim-stats";
  const LOCATION_EVENT = "cgpt-lb-locationchange";
  const MAINTENANCE_EVENT = "cgpt-lb-maintenance";
  const HIDDEN_CLASS = "cgpt-lb-hidden";
  const CONTAINED_CLASS = "cgpt-lb-contained";
  const LOAD_MORE_ID = "cgpt-lb-load-more";
  const STATUS_ID = "cgpt-lb-status";
  const TURN_SELECTOR = [
    '[data-testid^="conversation-turn-"]',
    '[data-testid*="conversation-turn"]',
    '[data-turn-id]',
    '[data-message-id]'
  ].join(", ");
  const ROLE_SELECTOR = [
    "[data-message-author-role]",
    "[data-message-author]",
    "[data-author-role]"
  ].join(", ");
  const TURN_CLOSEST_SELECTOR = [
    '[data-testid^="conversation-turn-"]',
    '[data-testid*="conversation-turn"]',
    '[data-turn-id]',
    "article",
    '[role="article"]'
  ].join(", ");

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    apiTrimEnabled: true,
    visibleTurns: 4,
    loadMoreBatch: 4,
    prefetchBatches: 2,
    apiCacheEntries: 1,
    apiCacheMaxKb: 1024,
    maintenanceEnabled: true,
    maintenanceIntervalSec: 30,
    cssContainmentEnabled: true,
    showStatus: false,
    debug: false
  });

  let settings = { ...DEFAULT_SETTINGS };
  let extraVisibleMessages = 0;
  let apiTrimmedCurrentConversation = false;
  let lastApiStats = null;
  let lastUrl = location.href;
  let lastDomMetrics = { total: 0, hidden: 0, visible: 0 };
  let scanScheduled = false;
  let scanTimer = 0;
  let lastScanAt = 0;
  let loadMoreButton = null;
  let statusBadge = null;
  let observer = null;
  let observerTarget = null;
  let navigationTimer = 0;
  let maintenanceTimer = 0;
  let maintenanceScheduled = false;
  let lastMaintenanceAt = 0;
  let pendingRelevantMutations = 0;
  let lastObservedTurnTotal = 0;
  let lastLoadMoreState = { visible: false, mode: "none", hiddenCount: 0, reason: "init" };

  boot();

  async function boot() {
    settings = await loadSettings();
    writeSettingsBridge();
    listenForSettingsChanges();
    listenForPopupMetrics();
    listenForTrimStats();
    startNavigationWatcher();
    startMaintenanceLoop();
    window.addEventListener("cgpt-lb-force-scan", () => scheduleScan(true));

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => {
        ensureObserverTarget();
        scheduleScan(true);
      }, { once: true });
    }

    ensureObserverTarget();
    scheduleScan(true);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        scheduleScan();
        scheduleMaintenance("visibility");
      }
    }, { passive: true });
    window.addEventListener("focus", () => scheduleMaintenance("focus"), { passive: true });
  }

  function loadSettings() {
    return new Promise((resolve) => {
      if (!hasChromeStorage()) {
        resolve({ ...DEFAULT_SETTINGS });
        return;
      }
      chrome.storage.local.get(null, (value) => {
        resolve(normalizeSettings(value || {}));
      });
    });
  }

  function hasChromeStorage() {
    return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
  }

  function normalizeSettings(value) {
    const merged = { ...DEFAULT_SETTINGS, ...(value && typeof value === "object" ? value : {}) };
    const cacheValue = Object.prototype.hasOwnProperty.call(merged, "apiCacheEntries")
      ? merged.apiCacheEntries
      : merged.responseCacheMax;
    return {
      enabled: Boolean(merged.enabled),
      apiTrimEnabled: Boolean(merged.apiTrimEnabled),
      visibleTurns: clampInt(merged.visibleTurns, 1, 100, DEFAULT_SETTINGS.visibleTurns),
      loadMoreBatch: clampInt(merged.loadMoreBatch, 1, 100, DEFAULT_SETTINGS.loadMoreBatch),
      prefetchBatches: clampInt(merged.prefetchBatches, 0, 30, DEFAULT_SETTINGS.prefetchBatches),
      apiCacheEntries: clampInt(cacheValue, 1, 2, DEFAULT_SETTINGS.apiCacheEntries),
      apiCacheMaxKb: clampInt(merged.apiCacheMaxKb, 128, 4096, DEFAULT_SETTINGS.apiCacheMaxKb),
      maintenanceEnabled: Boolean(merged.maintenanceEnabled),
      maintenanceIntervalSec: clampInt(merged.maintenanceIntervalSec, 10, 300, DEFAULT_SETTINGS.maintenanceIntervalSec),
      cssContainmentEnabled: Boolean(merged.cssContainmentEnabled ?? merged.contentVisibilityEnabled),
      showStatus: Boolean(merged.showStatus),
      debug: Boolean(merged.debug)
    };
  }

  function clampInt(value, min, max, fallback) {
    const n = Number.parseInt(String(value), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function writeSettingsBridge() {
    const raw = JSON.stringify(settings);
    try {
      localStorage.setItem(SETTINGS_KEY, raw);
    } catch {
      // Ignore blocked storage.
    }
    if (document.documentElement) {
      document.documentElement.setAttribute(SETTINGS_ATTR, raw);
    }
    try {
      window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: raw }));
    } catch {
      // Ignore event bridge failures.
    }
  }

  function listenForSettingsChanges() {
    if (!hasChromeStorage() || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      const next = { ...settings };
      let changed = false;
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (Object.prototype.hasOwnProperty.call(changes, key)) {
          next[key] = changes[key].newValue;
          changed = true;
        }
      }
      if (Object.prototype.hasOwnProperty.call(changes, "responseCacheMax")) {
        next.apiCacheEntries = changes.responseCacheMax.newValue;
        changed = true;
      }
      if (!changed) return;
      settings = normalizeSettings(next);
      writeSettingsBridge();
      ensureObserverTarget();
      restartMaintenanceLoop();
      scanAndApply();
    });
  }

  function listenForPopupMetrics() {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.onMessage) return;
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.type !== "cgpt-lb-get-metrics") return false;
      try {
        scanAndApply();
        sendResponse(collectMetricsForPopup());
      } catch (error) {
        sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
      }
      return true;
    });
  }

  function listenForTrimStats() {
    window.addEventListener(STATS_EVENT, (event) => {
      const raw = event && typeof event.detail === "string" ? event.detail : "";
      const parsed = parseStats(raw);
      if (!statsApplyToThisPage(parsed)) return;
      lastApiStats = parsed;
      apiTrimmedCurrentConversation = Boolean(parsed && parsed.trimmed);
      scheduleScan();
    });
  }

  function startNavigationWatcher() {
    window.addEventListener(LOCATION_EVENT, checkNavigation, { passive: true });
    window.addEventListener("popstate", checkNavigation, { passive: true });
    window.addEventListener("hashchange", checkNavigation, { passive: true });
    navigationTimer = window.setInterval(checkNavigation, 3000);
  }

  function startMaintenanceLoop() {
    stopMaintenanceLoop();
    if (!settings.enabled || !settings.maintenanceEnabled) return;
    const intervalMs = settings.maintenanceIntervalSec * 1000;
    maintenanceTimer = window.setInterval(() => scheduleMaintenance("interval"), intervalMs);
  }

  function restartMaintenanceLoop() {
    startMaintenanceLoop();
    scheduleMaintenance("settings");
  }

  function stopMaintenanceLoop() {
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    maintenanceTimer = 0;
    maintenanceScheduled = false;
  }

  function scheduleMaintenance(reason) {
    if (!settings.enabled || !settings.maintenanceEnabled || !isLikelyChatSurface() || document.hidden) return;
    if (maintenanceScheduled) return;
    maintenanceScheduled = true;

    const run = () => {
      maintenanceScheduled = false;
      runMaintenance(reason);
    };

    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(run, { timeout: 1500 });
    } else {
      window.setTimeout(run, 750);
    }
  }

  function runMaintenance(reason) {
    if (!settings.enabled || !settings.maintenanceEnabled || !isLikelyChatSurface()) return;
    lastMaintenanceAt = Date.now();
    dispatchMaintenanceToMain(reason);
    compactVolatileState();
    ensureObserverTarget();
    scanAndApply();
  }

  function dispatchMaintenanceToMain(reason) {
    try {
      window.dispatchEvent(new CustomEvent(MAINTENANCE_EVENT, {
        detail: JSON.stringify({ reason: String(reason || "interval"), timestamp: Date.now() })
      }));
    } catch {
      // Non-critical bridge failure.
    }
  }

  function compactVolatileState() {
    if (lastApiStats && (!statsApplyToThisPage(lastApiStats) || isStaleTimestamp(lastApiStats.timestamp, 180_000))) {
      lastApiStats = null;
      apiTrimmedCurrentConversation = false;
    }

    const currentTotal = lastDomMetrics.total || queryMessageTurns().length || 0;
    if (currentTotal < lastObservedTurnTotal) {
      extraVisibleMessages = Math.min(extraVisibleMessages, Math.max(0, currentTotal - settings.visibleTurns * 2));
    }
    lastObservedTurnTotal = currentTotal;
    pendingRelevantMutations = 0;
  }

  function isStaleTimestamp(timestamp, ttlMs) {
    const value = Number(timestamp);
    return !value || Date.now() - value > ttlMs;
  }

  function checkNavigation() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    extraVisibleMessages = 0;
    apiTrimmedCurrentConversation = false;
    lastApiStats = null;
    lastDomMetrics = { total: 0, hidden: 0, visible: 0 };
    hideLoadMore();
    ensureObserverTarget();
    scheduleScan(true);
    scheduleMaintenance("navigation");
  }

  function isLikelyChatSurface() {
    const path = location.pathname || "/";
    return path === "/" || path.startsWith("/c/") || path.includes("/c/") || path.startsWith("/share/") || path.startsWith("/g/");
  }

  function ensureObserverTarget() {
    if (!isLikelyChatSurface()) {
      showAllKnownTurns();
      stopObserver();
      removeStatusBadge();
      return;
    }

    const target = getMessageScope() || document.body || document.documentElement;
    if (!target || observerTarget === target) return;

    stopObserver();
    observerTarget = target;
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (isRelevantMutation(mutation)) {
          pendingRelevantMutations += 1;
          scheduleScan();
          return;
        }
      }
    });
    observer.observe(target, { childList: true, subtree: true });
    debug("observer target", target.tagName || target.nodeName);
  }

  function stopObserver() {
    if (observer) observer.disconnect();
    observer = null;
    observerTarget = null;
  }

  function isRelevantMutation(mutation) {
    if (mutation.type !== "childList") return false;
    if (mutation.target instanceof Element && isExtensionUi(mutation.target)) return false;

    for (const node of mutation.addedNodes) {
      if (isRelevantNode(node)) return true;
    }
    for (const node of mutation.removedNodes) {
      if (isRelevantNode(node)) return true;
    }
    return false;
  }

  function isRelevantNode(node) {
    if (!(node instanceof Element)) return false;
    if (isExtensionUi(node)) return false;
    if (node.matches && (node.matches(TURN_SELECTOR) || node.matches(ROLE_SELECTOR))) return true;
    return Boolean(node.querySelector && node.querySelector(`${TURN_SELECTOR}, ${ROLE_SELECTOR}`));
  }

  function scheduleScan(immediate) {
    if (!isLikelyChatSurface()) {
      showAllKnownTurns();
      stopObserver();
      return;
    }

    if (scanScheduled && !immediate) return;
    if (scanTimer) clearTimeout(scanTimer);

    scanScheduled = true;
    const now = Date.now();
    const delay = immediate ? 0 : Math.max(0, 550 - (now - lastScanAt));

    scanTimer = window.setTimeout(() => {
      scanTimer = 0;
      const run = () => {
        scanScheduled = false;
        lastScanAt = Date.now();
        scanAndApply();
        ensureObserverTarget();
      };
      if (!immediate && typeof requestIdleCallback === "function") {
        requestIdleCallback(run, { timeout: 800 });
      } else {
        run();
      }
    }, delay);
  }

  function scanAndApply() {
    consumeApiTrimSignal();
    const turns = queryMessageTurns();
    applyVisibility(turns);
  }

  function consumeApiTrimSignal() {
    const root = document.documentElement;
    if (!root) return;

    const stats = readApiStatsFromRoot();
    if (statsApplyToThisPage(stats)) {
      lastApiStats = stats || lastApiStats;
      if (stats && stats.trimmed === false) apiTrimmedCurrentConversation = false;
    }

    if (root.hasAttribute(TRIMMED_ATTR)) {
      apiTrimmedCurrentConversation = true;
      root.removeAttribute(TRIMMED_ATTR);
    }
  }

  function readApiStatsFromRoot() {
    const root = document.documentElement;
    if (!root) return null;
    return parseStats(root.getAttribute(STATS_ATTR));
  }

  function readApiStats() {
    const fromRoot = readApiStatsFromRoot();
    if (statsApplyToThisPage(fromRoot)) {
      lastApiStats = fromRoot || lastApiStats;
    }
    return lastApiStats && statsApplyToThisPage(lastApiStats) ? { ...lastApiStats } : null;
  }

  function parseStats(raw) {
    if (!raw || typeof raw !== "string") return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function statsApplyToThisPage(stats) {
    return !stats || !stats.pageUrl || stats.pageUrl === location.href;
  }

  function getMessageScope() {
    return (
      document.querySelector("main") ||
      document.querySelector("[data-scroll-root]") ||
      document.querySelector('[role="main"]') ||
      document.body ||
      document.documentElement
    );
  }

  function queryMessageTurns() {
    const scope = getMessageScope();
    const candidates = [];

    for (const el of safeQueryAll(TURN_SELECTOR, scope)) {
      const turn = normalizeTurnElement(el, scope);
      if (turn) candidates.push(turn);
    }

    for (const node of safeQueryAll(ROLE_SELECTOR, scope)) {
      const turn = normalizeTurnElement(node, scope);
      if (turn) candidates.push(turn);
    }

    // Last-resort fallback for ChatGPT DOM variants that keep role metadata off the wrapper
    // but still render assistant messages through markdown/prose blocks. This runs only
    // inside the main chat surface and is normalized upward to avoid hiding inner blocks.
    if (candidates.length === 0) {
      for (const node of safeQueryAll(".markdown, .prose", scope)) {
        const turn = normalizeTurnElement(node, scope);
        if (turn) candidates.push(turn);
      }
    }

    return removeNested(sortDocumentOrder(uniqueElements(candidates)))
      .filter((el) => isAttached(el) && !isExtensionUi(el) && isLikelyMessageTurn(el, scope));
  }

  function normalizeTurnElement(el, scope) {
    if (!(el instanceof HTMLElement)) return null;
    if (isExtensionUi(el)) return null;

    const direct = el.closest(TURN_CLOSEST_SELECTOR);
    if (direct instanceof HTMLElement && containsWithinScope(scope, direct)) return direct;

    return climbToStableMessageContainer(el, scope);
  }

  function climbToStableMessageContainer(el, scope) {
    let node = el instanceof HTMLElement ? el : null;
    let fallback = null;
    let depth = 0;

    while (node && node !== scope && node !== document.body && depth < 8) {
      if (!(node instanceof HTMLElement)) break;
      const hasRole = Boolean(node.querySelector && node.querySelector(ROLE_SELECTOR));
      const hasMessageId = Boolean(node.querySelector && node.querySelector("[data-message-id]"));
      const textLength = (node.textContent || "").trim().length;
      if ((hasRole || hasMessageId) && textLength > 0) fallback = node;
      node = node.parentElement;
      depth += 1;
    }

    return fallback;
  }

  function containsWithinScope(scope, el) {
    const root = scope && typeof scope.contains === "function" ? scope : document;
    return Boolean(root === el || root.contains(el));
  }

  function isLikelyMessageTurn(el, scope) {
    if (!(el instanceof HTMLElement)) return false;
    if (!containsWithinScope(scope, el)) return false;
    if (el.closest("nav, aside, header, footer, [data-testid='conversation-sidebar']")) return false;
    if (el.matches("nav, aside, header, footer")) return false;
    if (el.id === LOAD_MORE_ID || el.id === STATUS_ID) return false;

    const testId = String(el.getAttribute("data-testid") || "");
    if (testId.includes("conversation-turn")) return true;
    if (el.hasAttribute("data-turn-id")) return true;
    if (el.hasAttribute("data-message-id")) return true;
    if (el.querySelector && el.querySelector(ROLE_SELECTOR)) return true;
    if (el.querySelector && el.querySelector("[data-message-id]")) return true;

    const textLength = (el.textContent || "").trim().length;
    return textLength > 0 && Boolean(el.querySelector && el.querySelector(".markdown, .prose"));
  }

  function safeQueryAll(selector, scope) {
    try {
      const root = scope && typeof scope.querySelectorAll === "function" ? scope : document;
      return Array.from(root.querySelectorAll(selector)).filter((el) => el instanceof HTMLElement);
    } catch {
      return [];
    }
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements.filter((el) => el instanceof HTMLElement)));
  }

  function sortDocumentOrder(elements) {
    const ordered = elements.slice();
    ordered.sort((a, b) => {
      if (a === b) return 0;
      const pos = a.compareDocumentPosition(b);
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    return ordered;
  }

  function removeNested(elements) {
    const result = [];
    for (const el of elements) {
      if (!result.some((parent) => parent.contains(el))) result.push(el);
    }
    return result;
  }

  function isAttached(el) {
    return Boolean(document.documentElement && document.documentElement.contains(el));
  }

  function isExtensionUi(el) {
    return Boolean(el && el.closest && el.closest(`#${LOAD_MORE_ID}, #${STATUS_ID}`));
  }

  function applyVisibility(turns) {
    ensureUi();
    const total = turns.length;

    if (!settings.enabled || total === 0) {
      for (const el of turns) {
        removeContainment(el);
        showElement(el);
      }
      hideLoadMore();
      updateStatus(0, total);
      lastDomMetrics = { total, hidden: 0, visible: total };
      return;
    }

    const baseVisibleMessages = settings.visibleTurns * 2;
    const visibleLimit = Math.max(2, baseVisibleMessages + extraVisibleMessages);
    const hiddenCount = Math.max(0, total - visibleLimit);

    for (let i = 0; i < total; i += 1) {
      const el = turns[i];
      if (settings.cssContainmentEnabled) applyContainment(el);
      else removeContainment(el);

      if (i < hiddenCount) hideElement(el);
      else showElement(el);
    }

    updateLoadMore(hiddenCount, turns);
    updateStatus(hiddenCount, total);
    lastDomMetrics = { total, hidden: hiddenCount, visible: Math.max(0, total - hiddenCount) };
  }

  function showAllKnownTurns() {
    const turns = queryMessageTurns();
    for (const el of turns) {
      removeContainment(el);
      showElement(el);
    }
    hideLoadMore();
    lastDomMetrics = { total: turns.length, hidden: 0, visible: turns.length };
  }

  function applyContainment(el) {
    if (!el.classList.contains(CONTAINED_CLASS)) el.classList.add(CONTAINED_CLASS);
  }

  function removeContainment(el) {
    if (el.classList.contains(CONTAINED_CLASS)) el.classList.remove(CONTAINED_CLASS);
  }

  function hideElement(el) {
    if (el.classList.contains(HIDDEN_CLASS)) return;
    el.classList.add(HIDDEN_CLASS);
    el.setAttribute("aria-hidden", "true");
  }

  function showElement(el) {
    if (!el.classList.contains(HIDDEN_CLASS)) return;
    el.classList.remove(HIDDEN_CLASS);
    el.removeAttribute("aria-hidden");
  }

  function ensureUi() {
    if (!loadMoreButton || !document.documentElement.contains(loadMoreButton)) {
      loadMoreButton = document.createElement("button");
      loadMoreButton.id = LOAD_MORE_ID;
      loadMoreButton.type = "button";
      loadMoreButton.hidden = true;
    }

    if (!settings.showStatus) {
      removeStatusBadge();
      return;
    }

    if (!document.body) return;
    if (!statusBadge || !document.documentElement.contains(statusBadge)) {
      statusBadge = document.createElement("div");
      statusBadge.id = STATUS_ID;
      statusBadge.setAttribute("role", "status");
      statusBadge.setAttribute("aria-live", "polite");
      document.body.appendChild(statusBadge);
    }
  }

  function removeStatusBadge() {
    if (statusBadge && statusBadge.parentElement) statusBadge.remove();
    statusBadge = null;
  }

  function updateLoadMore(hiddenCount, turns) {
    if (!loadMoreButton) return;

    const firstVisible = turns.find((el) => !el.classList.contains(HIDDEN_CLASS));
    const container = firstVisible && firstVisible.parentElement;

    if (hiddenCount > 0) {
      const batchCount = Math.min(hiddenCount, settings.loadMoreBatch * 2);
      loadMoreButton.dataset.mode = "more";
      loadMoreButton.textContent = `이전 메시지 ${batchCount}개 더 보기 · 숨김 ${hiddenCount}개`;
      lastLoadMoreState = { visible: true, mode: "more", hiddenCount, reason: "hidden-dom" };
      loadMoreButton.onclick = () => {
        extraVisibleMessages += settings.loadMoreBatch * 2;
        scanAndApply();
        requestAnimationFrame(() => {
          if (loadMoreButton && !loadMoreButton.hidden) loadMoreButton.scrollIntoView({ block: "center", behavior: "smooth" });
        });
      };
      showLoadMore(container, firstVisible);
      return;
    }

    if (apiTrimmedCurrentConversation && settings.apiTrimEnabled) {
      loadMoreButton.dataset.mode = "full";
      loadMoreButton.textContent = "전체 대화 로드하기 · 느려질 수 있음";
      lastLoadMoreState = { visible: true, mode: "full", hiddenCount: 0, reason: "api-trimmed" };
      loadMoreButton.onclick = () => {
        try {
          localStorage.setItem(BYPASS_KEY, "true");
        } catch {
          // Ignore storage failures.
        }
        location.reload();
      };
      showLoadMore(container, firstVisible);
      return;
    }

    hideLoadMore();
  }

  function showLoadMore(container, beforeNode) {
    if (!loadMoreButton) return;

    // Prefer a body-level floating control. In recent ChatGPT layouts, inserting the
    // button into the message flex/virtual-scroll container can make it invisible or
    // clipped by an ancestor. Body-level placement keeps the control discoverable.
    if (document.body) {
      if (loadMoreButton.parentElement !== document.body) document.body.appendChild(loadMoreButton);
      loadMoreButton.dataset.floating = "true";
      loadMoreButton.hidden = false;
      loadMoreButton.removeAttribute("hidden");
      lastLoadMoreState.visible = true;
      lastLoadMoreState.reason = "body-floating";
      return;
    }

    if (!container) {
      const fallback = getMessageScope() || document.documentElement;
      if (fallback && loadMoreButton.parentElement !== fallback) fallback.prepend(loadMoreButton);
      loadMoreButton.dataset.floating = "false";
      loadMoreButton.hidden = false;
      loadMoreButton.removeAttribute("hidden");
      lastLoadMoreState.visible = true;
      lastLoadMoreState.reason = "fallback-prepend";
      return;
    }

    if (loadMoreButton.parentElement !== container || loadMoreButton.nextSibling !== beforeNode) {
      container.insertBefore(loadMoreButton, beforeNode || container.firstChild);
    }
    loadMoreButton.dataset.floating = "false";
    loadMoreButton.hidden = false;
    loadMoreButton.removeAttribute("hidden");
    lastLoadMoreState.visible = true;
    lastLoadMoreState.reason = "inline";
  }

  function hideLoadMore() {
    if (loadMoreButton) {
      loadMoreButton.hidden = true;
      loadMoreButton.setAttribute("hidden", "");
    }
    lastLoadMoreState = { visible: false, mode: "none", hiddenCount: 0, reason: "hidden" };
  }

  function updateStatus(hiddenCount, total) {
    if (!statusBadge) return;
    if (!settings.enabled || !settings.showStatus || total === 0) {
      statusBadge.hidden = true;
      return;
    }

    const visible = total - hiddenCount;
    const stats = readApiStats();
    const apiText = stats && stats.totalRenderableMessages
      ? ` · API ${stats.keptRenderableMessages}/${stats.totalRenderableMessages}`
      : apiTrimmedCurrentConversation
        ? " · API trim"
        : "";
    const kept = document.documentElement ? document.documentElement.getAttribute(KEPT_ATTR) : null;
    statusBadge.textContent = `표시 ${visible}/${total} · 숨김 ${hiddenCount}${apiText || (kept ? ` · API ${kept}` : "")}`;
    statusBadge.hidden = false;
  }

  function getMemorySnapshot() {
    const memory = typeof performance !== "undefined" && performance ? performance.memory : null;
    if (!memory) return null;
    return {
      usedJSHeapSize: numberOrNull(memory.usedJSHeapSize),
      totalJSHeapSize: numberOrNull(memory.totalJSHeapSize),
      jsHeapSizeLimit: numberOrNull(memory.jsHeapSizeLimit)
    };
  }

  function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function collectMetricsForPopup() {
    const turns = queryMessageTurns();
    const total = turns.length;
    const hidden = turns.filter((el) => el.classList.contains(HIDDEN_CLASS)).length;
    const visible = Math.max(0, total - hidden);
    lastDomMetrics = { total, hidden, visible };
    return {
      ok: true,
      url: location.href,
      routeActive: isLikelyChatSurface(),
      enabled: settings.enabled,
      apiTrimmedCurrentConversation,
      contentVersion: CONTENT_VERSION,
      mainWorldVersion: document.documentElement ? document.documentElement.getAttribute("data-cgpt-lb-main-version") : null,
      settings: { ...settings },
      dom: { ...lastDomMetrics, nodes: countDomNodes() },
      api: readApiStats(),
      memory: getMemorySnapshot(),
      css: {
        contentVisibilitySupported: Boolean(window.CSS && CSS.supports && CSS.supports("content-visibility", "auto"))
      },
      maintenance: {
        enabled: Boolean(settings.maintenanceEnabled),
        intervalSec: settings.maintenanceIntervalSec,
        lastRunAt: lastMaintenanceAt || null,
        pendingRelevantMutations,
        lastObservedTurnTotal
      },
      cache: {
        entries: settings.apiCacheEntries,
        maxKb: settings.apiCacheMaxKb
      },
      loadMore: {
        ...lastLoadMoreState,
        inDom: Boolean(loadMoreButton && document.documentElement && document.documentElement.contains(loadMoreButton)),
        text: loadMoreButton && !loadMoreButton.hidden ? loadMoreButton.textContent : ""
      },
      timestamp: Date.now()
    };
  }

  function countDomNodes() {
    try {
      return document.getElementsByTagName("*").length;
    } catch {
      return null;
    }
  }

  function debug(...args) {
    if (!settings.debug) return;
    try {
      console.debug("[ChatGPT Long Chat Loader]", ...args);
    } catch {
      // Ignore console failures.
    }
  }

  window.addEventListener("pagehide", cleanup, { once: true });
  window.addEventListener("beforeunload", cleanup, { once: true });

  function cleanup() {
    stopObserver();
    if (navigationTimer) clearInterval(navigationTimer);
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    if (scanTimer) clearTimeout(scanTimer);
    navigationTimer = 0;
    maintenanceTimer = 0;
    maintenanceScheduled = false;
    scanTimer = 0;
    lastDomMetrics = { total: 0, hidden: 0, visible: 0 };
  }
})();
