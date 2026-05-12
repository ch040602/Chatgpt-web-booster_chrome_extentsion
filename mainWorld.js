(() => {
  "use strict";

  const MAIN_WORLD_VERSION = "1.1.0";
  const FETCH_PATCH_FLAG = "__CGPT_LONG_CHAT_LOADER_FETCH_PATCHED_V110__";
  const HISTORY_PATCH_FLAG = "__CGPT_LONG_CHAT_LOADER_HISTORY_PATCHED__";
  const SETTINGS_KEY = "cgptLongChatLoader.settings";
  const SETTINGS_ATTR = "data-cgpt-lb-settings";
  const TRIMMED_ATTR = "data-cgpt-lb-api-trimmed";
  const KEPT_ATTR = "data-cgpt-lb-api-kept";
  const STATS_ATTR = "data-cgpt-lb-api-stats";
  const MAIN_VERSION_ATTR = "data-cgpt-lb-main-version";
  const BYPASS_KEY = "cgptLongChatLoader.bypassOnce";
  const SETTINGS_EVENT = "cgpt-lb-settings";
  const STATS_EVENT = "cgpt-lb-trim-stats";
  const DEBUG_EVENT = "cgpt-lb-debug-log";
  const LOCATION_EVENT = "cgpt-lb-locationchange";
  const MAINTENANCE_EVENT = "cgpt-lb-maintenance";
  const ACTIVE_STATE_EVENT = "cgpt-lb-active-state";
  const CACHE_SUSPENDED_UNTIL_ATTR = "data-cgpt-lb-cache-suspended-until";
  const CACHE_SUSPENDED_REASON_ATTR = "data-cgpt-lb-cache-suspended-reason";
  const LIVE_TRIM_BYPASS_UNTIL_ATTR = "data-cgpt-lb-live-trim-bypass-until";
  const LIVE_TRIM_BYPASS_REASON_ATTR = "data-cgpt-lb-live-trim-bypass-reason";
  const SAFETY_LOCK_KEY = "cgptLongChatLoader.safetyLockUntil";
  const SAFETY_LOCK_ATTR = "data-cgpt-lb-safety-lock-until";
  const SAFE_BYPASS_REASON_ATTR = "data-cgpt-lb-safe-bypass-reason";
  const DEBUG_PREFIX = "[ChatGPT Long Chat Loader]";
  const RESPONSE_CACHE_HARD_MAX = 2;
  const RESPONSE_CACHE_TTL_MS = 60_000;
  const STATS_TTL_MS = 180_000;
  const CACHE_MEMORY_PRESSURE_RATIO = 0.75;
  const CACHE_SUSPEND_AFTER_MUTATION_MS = 5 * 60 * 1000;
  const CACHE_SUSPEND_AFTER_ACTIVE_MS = 6 * 60 * 1000;
  const THINKING_BYPASS_MS = 15 * 60 * 1000;
  const SAFETY_LOCK_MS = 30 * 60 * 1000;
  const LIVE_TRIM_BYPASS_AFTER_MUTATION_MS = 6 * 60 * 1000;
  const LIVE_TRIM_BYPASS_AFTER_ACTIVE_MS = 6 * 60 * 1000;

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    apiTrimEnabled: true,
    safeNetworkMode: true,
    visibleTurns: 3,
    loadMoreBatch: 4,
    prefetchBatches: 1,
    apiCacheEntries: 1,
    apiCacheMaxKb: 512,
    maintenanceEnabled: true,
    maintenanceIntervalSec: 45,
    cssContainmentEnabled: true,
    showStatus: false,
    debug: false
  });

  const responseCache = new Map();
  let settingsFromBridge = null;
  let cacheSuspendedUntil = 0;
  let cacheSuspendedReason = "";
  let liveTrimBypassUntil = 0;
  let liveTrimBypassReason = "";
  const initialTrimDoneRoutes = new Set();

  markMainWorldVersion();
  installLocationChangePatch();

  if (window[FETCH_PATCH_FLAG]) return;
  window[FETCH_PATCH_FLAG] = true;

  window.addEventListener(SETTINGS_EVENT, (event) => {
    const raw = event && typeof event.detail === "string" ? event.detail : null;
    if (!raw) return;
    try {
      settingsFromBridge = normalizeSettings(JSON.parse(raw));
      pruneCache(settingsFromBridge.apiCacheEntries);
    } catch {
      settingsFromBridge = null;
    }
  });

  window.addEventListener(MAINTENANCE_EVENT, handleMaintenanceEvent);
  window.addEventListener(ACTIVE_STATE_EVENT, handleActiveStateEvent);
  window.addEventListener(LOCATION_EVENT, () => {
    responseCache.clear();
    cacheSuspendedUntil = 0;
    cacheSuspendedReason = "";
    liveTrimBypassUntil = 0;
    liveTrimBypassReason = "";
    clearTrimSignal();
    updateCacheSuspensionAttributes();
    updateLiveTrimBypassAttributes();
    updateSafetyLockAttributes();
  }, { passive: true });
  window.addEventListener("pagehide", () => responseCache.clear(), { once: true });

  const originalFetch = window.fetch;
  if (typeof originalFetch !== "function") return;

  window.fetch = async function patchedFetch(input, init) {
    const requestUrl = getRequestUrl(input);
    const requestMethod = getRequestMethod(input, init);

    if (isConversationMutation(requestUrl, requestMethod)) {
      const settings = readSettings();
      suspendResponseCache("conversation mutation", CACHE_SUSPEND_AFTER_MUTATION_MS, settings);
      beginLiveTrimBypass("conversation mutation", LIVE_TRIM_BYPASS_AFTER_MUTATION_MS, settings);
      debug(settings, "cache and live trim bypass after conversation mutation", requestMethod, requestUrl);
      return originalFetch.call(this, input, init);
    }

    if (!isConversationGet(requestUrl, requestMethod)) {
      return originalFetch.call(this, input, init);
    }

    const settings = readSettings();
    refreshCacheSuspensionState();
    updateSafetyLockAttributes();
    if (!settings.enabled || !settings.apiTrimEnabled) {
      clearTrimSignal();
      return originalFetch.call(this, input, init);
    }

    if (isSafetyLockActive()) {
      responseCache.clear();
      clearTrimSignal();
      signalSafeBypass("security notice safety lock", requestUrl);
      debug(settings, "safety lock active; returning original conversation response", requestUrl);
      return originalFetch.call(this, input, init);
    }

    if (consumeBypassFlag()) {
      responseCache.clear();
      clearTrimSignal();
      debug(settings, "bypass once: full conversation load", requestUrl);
      return originalFetch.call(this, input, init);
    }

    if (isLiveTrimBypassActive()) {
      responseCache.clear();
      if (settings.safeNetworkMode) markInitialTrimDoneForCurrentRoute(requestUrl);
      signalLiveTrimBypass("live reply protection", requestUrl);
      signalSafeBypass(liveTrimBypassReason || "live reply protection", requestUrl);
      debug(settings, "live trim bypass: returning original conversation response", requestUrl, liveTrimBypassReason);
      return originalFetch.call(this, input, init);
    }

    if (settings.safeNetworkMode && isInitialTrimDoneForCurrentRoute(requestUrl)) {
      responseCache.clear();
      clearTrimSignal();
      signalSafeBypass("safe mode post-initial original pass", requestUrl);
      debug(settings, "safe mode post-initial original pass", requestUrl);
      return originalFetch.call(this, input, init);
    }

    const keepRenderableMessages = calculateKeepRenderableMessages(settings);
    const cacheKey = `${requestUrl}::keep=${keepRenderableMessages}`;
    const cacheSuspended = isResponseCacheSuspended();
    const cached = cacheSuspended ? null : getCached(settings, cacheKey);
    if (cached) {
      const stats = {
        ...cached.stats,
        cacheHit: true,
        timestamp: Date.now(),
        pageUrl: location.href
      };
      stats.cacheEligible = shouldStoreCache(settings, cached.body, stats);
      signalStats(stats);
      debug(settings, "cache hit", cacheKey);
      return buildResponse(cached.meta, cached.body, true);
    }

    const response = await originalFetch.call(this, input, init);
    if (!response || !response.ok || !shouldAttemptJsonTrim(response)) {
      return response;
    }

    const meta = responseMeta(response);
    let text = "";
    try {
      // Read the original body once. Using response.clone().text() keeps an extra body alive and raises peak memory.
      text = await response.text();
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    } catch (error) {
      debug(settings, "could not read conversation response body", error);
      return response;
    }

    const rawLooksJson = /^[\s\uFEFF]*[\[{]/.test(text);
    if (!rawLooksJson && matchesUnusualActivityText(text)) {
      setSafetyLock("unusual-activity-response", SAFETY_LOCK_MS);
      responseCache.clear();
      clearTrimSignal();
      signalSafeBypass("unusual activity response", requestUrl);
      debug(settings, "unusual activity response detected; entering safety lock", requestUrl);
      return buildResponse(meta, text, false);
    }

    let body = text;
    let jsonLike = false;
    let stats = null;
    const originalChars = approximateLength(text);

    try {
      const data = JSON.parse(text);
      jsonLike = true;
      if (isUnusualActivityErrorPayload(data)) {
        setSafetyLock("unusual-activity-response", SAFETY_LOCK_MS);
        responseCache.clear();
        clearTrimSignal();
        signalSafeBypass("unusual activity response", requestUrl);
        debug(settings, "unusual activity JSON payload detected; entering safety lock", requestUrl);
        return buildResponse(meta, text, true);
      }
      const trimResult = trimChatGptConversation(data, keepRenderableMessages);

      if (trimResult.trimmed) {
        body = JSON.stringify(trimResult.data);
      }

      const trimmedChars = trimResult.trimmed ? approximateLength(body) : originalChars;
      stats = {
        trimmed: Boolean(trimResult.trimmed),
        totalRenderableMessages: trimResult.totalRenderableMessages || 0,
        keptRenderableMessages: trimResult.keptRenderableMessages || trimResult.totalRenderableMessages || 0,
        totalVisibleMessages: trimResult.totalRenderableMessages || 0,
        keptVisibleMessages: trimResult.keptRenderableMessages || trimResult.totalRenderableMessages || 0,
        totalMappingNodes: trimResult.totalMappingNodes || 0,
        keptMappingNodes: trimResult.keptMappingNodes || trimResult.totalMappingNodes || 0,
        originalChars,
        trimmedChars,
        originalBytes: originalChars,
        trimmedBytes: trimmedChars,
        keepRenderableMessages,
        keepVisibleMessages: keepRenderableMessages,
        cacheHit: false,
        cacheEligible: false,
        cacheStored: false,
        cacheMaxKb: settings.apiCacheMaxKb,
        timestamp: Date.now(),
        pageUrl: location.href,
        requestUrl,
        activeGeneration: Boolean(trimResult.activeGeneration),
        protectedNodeCount: trimResult.protectedNodeCount || 0,
        effectiveCurrentNodeChanged: Boolean(trimResult.effectiveCurrentNodeChanged),
        thinkingOrReasoningActive: Boolean(trimResult.thinkingOrReasoningActive),
        safeNetworkMode: Boolean(settings.safeNetworkMode),
        initialOnly: Boolean(settings.safeNetworkMode),
        cacheSuspended: Boolean(cacheSuspended || isResponseCacheSuspended())
      };

      if (stats.activeGeneration || stats.effectiveCurrentNodeChanged || stats.thinkingOrReasoningActive) {
        const activeReason = stats.thinkingOrReasoningActive ? "thinking or reasoning active" : "active generation";
        const activeTtl = stats.thinkingOrReasoningActive ? THINKING_BYPASS_MS : CACHE_SUSPEND_AFTER_ACTIVE_MS;
        suspendResponseCache(activeReason, activeTtl, settings);
        beginLiveTrimBypass(activeReason, activeTtl, settings);
        stats.cacheSuspended = true;
        stats.liveTrimBypass = true;
        signalLiveTrimBypass(activeReason, requestUrl);
        signalSafeBypass(activeReason, requestUrl);
        if (settings.safeNetworkMode) markInitialTrimDoneForCurrentRoute(requestUrl);
        debug(settings, activeReason + " detected; returning original conversation response", requestUrl);
        return buildResponse(meta, text, jsonLike);
      }

      stats.cacheEligible = shouldStoreCache(settings, body, stats);
      signalStats(stats);
      debug(
        settings,
        trimResult.trimmed
          ? `trimmed renderable messages ${stats.totalRenderableMessages} -> ${stats.keptRenderableMessages}; mapping ${stats.totalMappingNodes} -> ${stats.keptMappingNodes}`
          : `no trim needed; renderable messages ${stats.totalRenderableMessages}`,
        requestUrl
      );
    } catch (error) {
      clearTrimSignal();
      debug(settings, "conversation trim failed; returning unmodified body", error);
    }

    const rewritten = buildResponse(meta, body, jsonLike);
    text = "";

    if (stats && settings.safeNetworkMode) markInitialTrimDoneForCurrentRoute(requestUrl);

    if (stats && stats.trimmed) {
      stats.cacheStored = putCached(settings, cacheKey, { body, stats, meta });
      if (stats.cacheStored) signalStats(stats);
    }

    return rewritten;
  };


  function markMainWorldVersion() {
    const apply = () => {
      try {
        if (document.documentElement) document.documentElement.setAttribute(MAIN_VERSION_ATTR, MAIN_WORLD_VERSION);
      } catch {
        // Non-critical bridge failure.
      }
    };
    apply();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", apply, { once: true });
    }
  }

  function installLocationChangePatch() {
    if (window[HISTORY_PATCH_FLAG]) return;
    window[HISTORY_PATCH_FLAG] = true;

    const dispatch = () => {
      try {
        window.dispatchEvent(new CustomEvent(LOCATION_EVENT, { detail: location.href }));
      } catch {
        // Non-critical.
      }
    };

    for (const method of ["pushState", "replaceState"]) {
      const original = history && history[method];
      if (typeof original !== "function") continue;
      try {
        history[method] = function patchedHistoryMethod(...args) {
          const result = original.apply(this, args);
          dispatch();
          return result;
        };
      } catch {
        // Some environments may expose a non-writable history method.
      }
    }

    window.addEventListener("popstate", dispatch, { passive: true });
    window.addEventListener("hashchange", dispatch, { passive: true });
  }

  function getRequestUrl(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.toString();
    if (input && typeof input.url === "string") return input.url;
    return "";
  }

  function getRequestMethod(input, init) {
    const method =
      (init && init.method) ||
      (input && typeof input === "object" && "method" in input ? input.method : null) ||
      "GET";
    return String(method).toUpperCase();
  }

  function isConversationGet(url, method) {
    if (method !== "GET" || !url) return false;
    if (!isSupportedHost(location.hostname)) return false;

    let parsed;
    try {
      parsed = new URL(url, location.href);
    } catch {
      return false;
    }

    if (!isSupportedHost(parsed.hostname)) return false;
    const path = parsed.pathname || "";
    if (path.includes("/backend-api/conversations")) return false;
    return /^\/backend-api\/(?:f\/)?conversation\/[^/]+/.test(path);
  }


  function isConversationMutation(url, method) {
    if (!url || method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
    if (!isSupportedHost(location.hostname)) return false;

    let parsed;
    try {
      parsed = new URL(url, location.href);
    } catch {
      return false;
    }

    if (!isSupportedHost(parsed.hostname)) return false;
    const path = parsed.pathname || "";
    return /^\/backend-api\/(?:f\/)?conversation(?:\/.*)?$/.test(path);
  }

  function isSupportedHost(hostname) {
    return hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com") || hostname === "chat.openai.com";
  }

  function shouldAttemptJsonTrim(response) {
    const contentType = String(response.headers && response.headers.get("content-type") || "").toLowerCase();
    if (!contentType) return true;
    if (contentType.includes("json")) return true;
    if (contentType.includes("text/plain")) return true;
    return false;
  }

  function normalizeSettings(value) {
    const merged = { ...DEFAULT_SETTINGS, ...(value && typeof value === "object" ? value : {}) };
    const cacheValue = Object.prototype.hasOwnProperty.call(merged, "apiCacheEntries")
      ? merged.apiCacheEntries
      : merged.responseCacheMax;
    return {
      enabled: Boolean(merged.enabled),
      apiTrimEnabled: Boolean(merged.apiTrimEnabled),
      safeNetworkMode: merged.safeNetworkMode === false ? false : true,
      visibleTurns: clampInt(merged.visibleTurns, 1, 100, DEFAULT_SETTINGS.visibleTurns),
      loadMoreBatch: clampInt(merged.loadMoreBatch, 1, 100, DEFAULT_SETTINGS.loadMoreBatch),
      prefetchBatches: clampInt(merged.prefetchBatches, 0, 30, DEFAULT_SETTINGS.prefetchBatches),
      apiCacheEntries: clampInt(cacheValue, 1, RESPONSE_CACHE_HARD_MAX, DEFAULT_SETTINGS.apiCacheEntries),
      apiCacheMaxKb: clampInt(merged.apiCacheMaxKb, 128, 4096, DEFAULT_SETTINGS.apiCacheMaxKb),
      maintenanceEnabled: Boolean(merged.maintenanceEnabled),
      maintenanceIntervalSec: clampInt(merged.maintenanceIntervalSec, 10, 300, DEFAULT_SETTINGS.maintenanceIntervalSec),
      cssContainmentEnabled: Boolean(merged.cssContainmentEnabled ?? merged.contentVisibilityEnabled),
      showStatus: Boolean(merged.showStatus),
      debug: Boolean(merged.debug)
    };
  }

  function readSettings() {
    if (settingsFromBridge) return settingsFromBridge;

    const attr = document.documentElement && document.documentElement.getAttribute(SETTINGS_ATTR);
    if (attr) {
      try {
        settingsFromBridge = normalizeSettings(JSON.parse(attr));
        return settingsFromBridge;
      } catch {
        // Continue to localStorage/defaults.
      }
    }

    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return normalizeSettings(JSON.parse(raw));
    } catch {
      // Ignore blocked or corrupted storage.
    }
    return { ...DEFAULT_SETTINGS };
  }

  function clampInt(value, min, max, fallback) {
    const n = Number.parseInt(String(value), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function calculateKeepRenderableMessages(settings) {
    const visible = settings.visibleTurns * 2;
    const buffered = settings.loadMoreBatch * settings.prefetchBatches * 2;
    return Math.max(2, visible + buffered);
  }

  function consumeBypassFlag() {
    try {
      if (localStorage.getItem(BYPASS_KEY) === "true") {
        localStorage.removeItem(BYPASS_KEY);
        return true;
      }
    } catch {
      // Ignore storage failures.
    }
    return false;
  }

  function currentRouteKeyFromUrl(url) {
    try {
      const parsed = new URL(url || location.href, location.href);
      return `${parsed.hostname}${parsed.pathname}`;
    } catch {
      return String(location.pathname || location.href || "");
    }
  }

  function isInitialTrimDoneForCurrentRoute(url) {
    return initialTrimDoneRoutes.has(currentRouteKeyFromUrl(url));
  }

  function markInitialTrimDoneForCurrentRoute(url) {
    initialTrimDoneRoutes.add(currentRouteKeyFromUrl(url));
  }

  function matchesUnusualActivityText(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!text) return false;
    if (text.includes("unusual-activity") || text.includes("suspicious-activity")) return true;
    if (text.includes("unusual activity has been detected") && text.includes("try again later")) return true;
    if (text.includes("we detect suspicious activity") || text.includes("unusual activity detected")) return true;
    if (text.includes("비정상") && text.includes("활동")) return true;
    if (text.includes("의심스러운") && text.includes("활동")) return true;
    return false;
  }

  function isUnusualActivityErrorPayload(data) {
    if (!data || typeof data !== "object") return false;
    if (data.mapping && typeof data.mapping === "object") return false;
    const candidates = [
      data.message,
      data.detail,
      data.title,
      data.error,
      data.error && data.error.message,
      data.error && data.error.detail,
      data.error && data.error.title
    ];
    return candidates.some((value) => {
      if (!value) return false;
      if (typeof value === "object") {
        try { return matchesUnusualActivityText(JSON.stringify(value)); } catch { return false; }
      }
      return matchesUnusualActivityText(value);
    });
  }

  function setSafetyLock(reason, ttlMs) {
    const until = Date.now() + Math.max(60_000, Number(ttlMs) || SAFETY_LOCK_MS);
    try { localStorage.setItem(SAFETY_LOCK_KEY, String(until)); } catch { /* ignore */ }
    if (document.documentElement) {
      document.documentElement.setAttribute(SAFETY_LOCK_ATTR, String(until));
      document.documentElement.setAttribute(SAFE_BYPASS_REASON_ATTR, String(reason || "safety lock"));
      document.documentElement.setAttribute("data-cgpt-lb-safe-bypass-at", String(Date.now()));
    }
  }

  function isSafetyLockActive() {
    let until = 0;
    try { until = Number(localStorage.getItem(SAFETY_LOCK_KEY) || 0); } catch { until = 0; }
    if (until && Date.now() < until) {
      updateSafetyLockAttributes(until);
      return true;
    }
    if (until && Date.now() >= until) {
      try { localStorage.removeItem(SAFETY_LOCK_KEY); } catch { /* ignore */ }
    }
    updateSafetyLockAttributes(0);
    return false;
  }

  function updateSafetyLockAttributes(until) {
    const root = document.documentElement;
    if (!root) return;
    const value = Number(until || 0);
    if (value && Date.now() < value) root.setAttribute(SAFETY_LOCK_ATTR, String(value));
    else root.removeAttribute(SAFETY_LOCK_ATTR);
  }

  function signalSafeBypass(reason, requestUrl) {
    const root = document.documentElement;
    if (!root) return;
    try {
      root.setAttribute(SAFE_BYPASS_REASON_ATTR, String(reason || "safe original pass"));
      root.setAttribute("data-cgpt-lb-safe-bypass-at", String(Date.now()));
      if (requestUrl) root.setAttribute("data-cgpt-lb-safe-bypass-url", String(requestUrl));
    } catch {
      // Ignore bridge failures.
    }
  }

  function isThinkingReason(value) {
    const text = String(value || "").toLowerCase();
    return /think|reason|thought|analysis|analyz|추론|생각|분석/.test(text);
  }

  function signalStats(stats) {
    const root = document.documentElement;
    if (!root || !stats) return;

    if (stats.trimmed) {
      root.setAttribute(TRIMMED_ATTR, "true");
      root.setAttribute(KEPT_ATTR, String(stats.keptRenderableMessages || stats.keptVisibleMessages || ""));
    } else {
      root.removeAttribute(TRIMMED_ATTR);
      root.removeAttribute(KEPT_ATTR);
    }

    try {
      const raw = JSON.stringify(stats);
      root.setAttribute(STATS_ATTR, raw);
      window.dispatchEvent(new CustomEvent(STATS_EVENT, { detail: raw }));
    } catch {
      root.removeAttribute(STATS_ATTR);
    }
  }

  function parseJsonDetail(detail) {
    if (!detail) return null;
    if (typeof detail === "object") return detail;
    if (typeof detail !== "string") return null;
    try {
      const parsed = JSON.parse(detail);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function handleActiveStateEvent(event) {
    const settings = readSettings();
    const detail = parseJsonDetail(event && event.detail);
    if (!detail || !detail.active) {
      refreshCacheSuspensionState();
      retireLiveTrimBypass("active reply idle", 30_000);
      return;
    }
    const reasonText = String(detail.reason || "active reply");
    if (matchesUnusualActivityText(reasonText)) {
      setSafetyLock("unusual-activity-notice", SAFETY_LOCK_MS);
    }
    const maxTtl = isThinkingReason(reasonText) ? THINKING_BYPASS_MS : CACHE_SUSPEND_AFTER_MUTATION_MS;
    const fallbackTtl = isThinkingReason(reasonText) ? THINKING_BYPASS_MS : CACHE_SUSPEND_AFTER_ACTIVE_MS;
    const ttl = clampInt(detail.ttlMs, 30_000, maxTtl, fallbackTtl);
    suspendResponseCache(reasonText, ttl, settings);
    beginLiveTrimBypass(reasonText, ttl, settings);
    debug(settings, "cache suspended after active-state signal", reasonText);
  }

  function handleMaintenanceEvent(event) {
    const settings = readSettings();
    let detail = null;
    detail = parseJsonDetail(event && event.detail);

    if (!settings.enabled || !settings.maintenanceEnabled || isMemoryPressureHigh()) {
      responseCache.clear();
    } else if (detail && detail.mode === "clear-cache") {
      responseCache.clear();
    } else {
      pruneCache(settings.apiCacheEntries);
    }

    clearStaleTrimSignal();
  }

  function clearStaleTrimSignal() {
    const root = document.documentElement;
    if (!root) return;
    const raw = root.getAttribute(STATS_ATTR);
    if (!raw) return;
    try {
      const stats = JSON.parse(raw);
      const timestamp = Number(stats && stats.timestamp);
      if (timestamp && Date.now() - timestamp <= STATS_TTL_MS && (!stats.pageUrl || stats.pageUrl === location.href)) return;
    } catch {
      // Corrupt stats should not stay attached to the page root.
    }
    clearTrimSignal();
  }

  function clearTrimSignal() {
    const root = document.documentElement;
    if (!root) return;
    root.removeAttribute(TRIMMED_ATTR);
    root.removeAttribute(KEPT_ATTR);
    root.removeAttribute(STATS_ATTR);
  }

  function suspendResponseCache(reason, ttlMs, settings) {
    const ttl = Math.max(30_000, Number(ttlMs) || CACHE_SUSPEND_AFTER_ACTIVE_MS);
    cacheSuspendedUntil = Math.max(cacheSuspendedUntil || 0, Date.now() + ttl);
    cacheSuspendedReason = String(reason || "active reply");
    if (responseCache.size) responseCache.clear();
    updateCacheSuspensionAttributes();
    if (settings) debug(settings, "response cache suspended", cacheSuspendedReason, `${Math.round(ttl / 1000)}s`);
  }

  function isResponseCacheSuspended() {
    refreshCacheSuspensionState();
    return Date.now() < cacheSuspendedUntil;
  }

  function refreshCacheSuspensionState() {
    if (cacheSuspendedUntil && Date.now() >= cacheSuspendedUntil) {
      cacheSuspendedUntil = 0;
      cacheSuspendedReason = "";
      updateCacheSuspensionAttributes();
    }
  }

  function updateCacheSuspensionAttributes() {
    const root = document.documentElement;
    if (!root) return;
    if (cacheSuspendedUntil && Date.now() < cacheSuspendedUntil) {
      root.setAttribute(CACHE_SUSPENDED_UNTIL_ATTR, String(cacheSuspendedUntil));
      root.setAttribute(CACHE_SUSPENDED_REASON_ATTR, cacheSuspendedReason || "active reply");
    } else {
      root.removeAttribute(CACHE_SUSPENDED_UNTIL_ATTR);
      root.removeAttribute(CACHE_SUSPENDED_REASON_ATTR);
    }
  }

  function beginLiveTrimBypass(reason, ttlMs, settings) {
    const ttl = Math.max(30_000, Number(ttlMs) || LIVE_TRIM_BYPASS_AFTER_ACTIVE_MS);
    liveTrimBypassUntil = Math.max(liveTrimBypassUntil || 0, Date.now() + ttl);
    liveTrimBypassReason = String(reason || "active reply");
    if (responseCache.size) responseCache.clear();
    updateLiveTrimBypassAttributes();
    if (settings) debug(settings, "live trim bypass enabled", liveTrimBypassReason, `${Math.round(ttl / 1000)}s`);
  }

  function clearLiveTrimBypass(reason) {
    if (!liveTrimBypassUntil && !liveTrimBypassReason) return;
    liveTrimBypassUntil = 0;
    liveTrimBypassReason = "";
    updateLiveTrimBypassAttributes();
    debug(readSettings(), "live trim bypass cleared", reason || "idle");
  }

  function retireLiveTrimBypass(reason, graceMs) {
    if (!liveTrimBypassUntil || Date.now() >= liveTrimBypassUntil) {
      clearLiveTrimBypass(reason);
      return;
    }
    const nextUntil = Date.now() + Math.max(5_000, Number(graceMs) || 30_000);
    if (liveTrimBypassUntil > nextUntil) {
      liveTrimBypassUntil = nextUntil;
      liveTrimBypassReason = String(reason || "active reply idle");
      updateLiveTrimBypassAttributes();
      debug(readSettings(), "live trim bypass retiring", liveTrimBypassReason, `${Math.round((liveTrimBypassUntil - Date.now()) / 1000)}s`);
    }
  }

  function isLiveTrimBypassActive() {
    refreshLiveTrimBypassState();
    return Date.now() < liveTrimBypassUntil;
  }

  function refreshLiveTrimBypassState() {
    if (liveTrimBypassUntil && Date.now() >= liveTrimBypassUntil) {
      liveTrimBypassUntil = 0;
      liveTrimBypassReason = "";
      updateLiveTrimBypassAttributes();
    }
  }

  function signalLiveTrimBypass(reason, requestUrl) {
    updateLiveTrimBypassAttributes();
    try {
      const root = document.documentElement;
      if (!root) return;
      root.setAttribute(LIVE_TRIM_BYPASS_REASON_ATTR, String(reason || liveTrimBypassReason || "active reply"));
      if (requestUrl) root.setAttribute("data-cgpt-lb-live-trim-bypass-url", String(requestUrl));
    } catch {
      // Non-critical bridge failure.
    }
  }

  function updateLiveTrimBypassAttributes() {
    const root = document.documentElement;
    if (!root) return;
    if (liveTrimBypassUntil && Date.now() < liveTrimBypassUntil) {
      root.setAttribute(LIVE_TRIM_BYPASS_UNTIL_ATTR, String(liveTrimBypassUntil));
      root.setAttribute(LIVE_TRIM_BYPASS_REASON_ATTR, liveTrimBypassReason || "active reply");
    } else {
      root.removeAttribute(LIVE_TRIM_BYPASS_UNTIL_ATTR);
      root.removeAttribute(LIVE_TRIM_BYPASS_REASON_ATTR);
      root.removeAttribute("data-cgpt-lb-live-trim-bypass-url");
    }
  }

  function putCached(settings, key, value) {
    const max = settings.apiCacheEntries;
    if (max <= 0 || !shouldStoreCache(settings, value && value.body, value && value.stats)) {
      pruneCache(max);
      return false;
    }
    responseCache.delete(key);
    responseCache.set(key, {
      ...value,
      cachedAt: Date.now(),
      bodyChars: approximateLength(value && value.body)
    });
    pruneCache(max);
    return responseCache.has(key);
  }

  function getCached(settings, key) {
    const max = settings.apiCacheEntries;
    if (max <= 0 || isMemoryPressureHigh()) {
      if (responseCache.size) responseCache.clear();
      return null;
    }
    const entry = responseCache.get(key);
    if (!entry) {
      pruneCache(max);
      return null;
    }
    if (isExpiredCacheEntry(entry) || !isCacheEntryWithinLimit(settings, entry)) {
      responseCache.delete(key);
      pruneCache(max);
      return null;
    }
    responseCache.delete(key);
    responseCache.set(key, entry);
    pruneCache(max);
    return entry;
  }

  function pruneCache(max) {
    const cap = Math.max(0, Math.min(RESPONSE_CACHE_HARD_MAX, Number(max) || 0));
    if (isMemoryPressureHigh()) {
      responseCache.clear();
      return;
    }
    for (const [key, entry] of responseCache) {
      if (isExpiredCacheEntry(entry)) responseCache.delete(key);
    }
    while (responseCache.size > cap) {
      const oldestKey = responseCache.keys().next().value;
      responseCache.delete(oldestKey);
    }
  }

  function shouldStoreCache(settings, body, stats) {
    if (!settings || settings.apiCacheEntries <= 0 || !body || isMemoryPressureHigh() || isResponseCacheSuspended()) return false;
    if (stats && !stats.trimmed) return false;
    if (stats && (stats.activeGeneration || stats.effectiveCurrentNodeChanged || stats.thinkingOrReasoningActive)) return false;
    return approximateLength(body) <= maxCacheChars(settings);
  }

  function isCacheEntryWithinLimit(settings, entry) {
    if (!entry || typeof entry.body !== "string") return false;
    return approximateLength(entry.body) <= maxCacheChars(settings);
  }

  function isExpiredCacheEntry(entry) {
    const cachedAt = Number(entry && entry.cachedAt);
    return !cachedAt || Date.now() - cachedAt > RESPONSE_CACHE_TTL_MS;
  }

  function maxCacheChars(settings) {
    return Math.max(1, settings.apiCacheMaxKb || DEFAULT_SETTINGS.apiCacheMaxKb) * 1024;
  }

  function isMemoryPressureHigh() {
    const memory = typeof performance !== "undefined" && performance.memory;
    if (!memory || !memory.jsHeapSizeLimit || !memory.usedJSHeapSize) return false;
    return memory.usedJSHeapSize / memory.jsHeapSizeLimit >= CACHE_MEMORY_PRESSURE_RATIO;
  }

  function responseMeta(response) {
    return {
      status: response.status,
      statusText: response.statusText,
      headers: Array.from(new Headers(response.headers).entries()),
      url: response.url
    };
  }

  function buildResponse(originalOrMeta, body, jsonLike) {
    const meta = originalOrMeta instanceof Response ? responseMeta(originalOrMeta) : originalOrMeta;
    const headers = new Headers(meta.headers || []);
    if (jsonLike) headers.set("content-type", "application/json; charset=utf-8");
    headers.delete("content-length");
    headers.delete("content-encoding");

    const response = new Response(body, {
      status: meta.status,
      statusText: meta.statusText,
      headers
    });
    defineResponseUrl(response, meta.url);
    return response;
  }

  function defineResponseUrl(response, url) {
    try {
      Object.defineProperty(response, "url", { value: url || location.href });
    } catch {
      // Non-critical.
    }
  }

  function approximateLength(value) {
    // Avoid TextEncoder/Blob here: both can allocate another full-size buffer.
    return String(value || "").length;
  }

  function trimChatGptConversation(data, keepRenderableMessages) {
    if (!data || typeof data !== "object") return emptyTrimResult(data);

    const mapping = data.mapping;
    const currentNode = data.current_node;
    if (!mapping || typeof mapping !== "object" || !currentNode || !mapping[currentNode]) {
      return emptyTrimResult(data, countOwnProperties(mapping));
    }

    const totalMappingNodes = countOwnProperties(mapping);
    const thinkingOrReasoningIds = collectThinkingOrReasoningNodeIds(mapping);
    const activeGenerationIds = uniqueIds([...collectActiveGenerationNodeIds(mapping), ...thinkingOrReasoningIds]);
    const thinkingOrReasoningActive = thinkingOrReasoningIds.length > 0;
    const effectiveCurrentNode = chooseEffectiveCurrentNode(mapping, currentNode, activeGenerationIds);
    const effectiveCurrentNodeChanged = effectiveCurrentNode !== currentNode;
    const chain = buildCurrentChain(mapping, effectiveCurrentNode);
    if (!chain.length) return emptyTrimResult(data, totalMappingNodes);

    const renderableIds = chain.filter((id) => isRenderableChatNode(mapping[id]));
    const totalRenderableMessages = renderableIds.length;
    const recentSupplementCount = Math.max(4, Math.min(12, Math.ceil(Math.max(keepRenderableMessages, 2) / 2)));
    const recentSupplementIds = collectRecentRenderableNodeIds(mapping, recentSupplementCount);
    const protectedIds = new Set([...activeGenerationIds, ...recentSupplementIds]);

    const activeGeneration = activeGenerationIds.length > 0;
    const protectedOutsideChain = [...protectedIds].some((id) => !chain.includes(id));

    if (totalRenderableMessages <= keepRenderableMessages && !effectiveCurrentNodeChanged && !protectedOutsideChain) {
      return {
        trimmed: false,
        data,
        totalRenderableMessages,
        keptRenderableMessages: totalRenderableMessages,
        totalMappingNodes,
        keptMappingNodes: totalMappingNodes,
        activeGeneration,
        thinkingOrReasoningActive,
        protectedNodeCount: protectedIds.size,
        effectiveCurrentNodeChanged: false
      };
    }

    const keptIds = new Set();
    const cutoffRenderableId = renderableIds[Math.max(0, renderableIds.length - keepRenderableMessages)];
    const cutoffIndex = cutoffRenderableId ? Math.max(0, chain.indexOf(cutoffRenderableId)) : Math.max(0, chain.length - keepRenderableMessages);

    for (let i = 0; i < cutoffIndex; i += 1) {
      const id = chain[i];
      if (shouldKeepBeforeCutoff(mapping[id], i)) keptIds.add(id);
    }

    for (let i = cutoffIndex; i < chain.length; i += 1) {
      keptIds.add(chain[i]);
    }

    // During generation ChatGPT may expose the partial assistant response as a child
    // or recent branch before it updates current_node. Keep those nodes and a short
    // ancestor bridge so the UI can continue showing streaming progress.
    for (const id of protectedIds) {
      addNodeWithAncestorBridge(mapping, keptIds, id, 12);
    }

    if (keptIds.size >= totalMappingNodes && !effectiveCurrentNodeChanged) {
      return {
        trimmed: false,
        data,
        totalRenderableMessages,
        keptRenderableMessages: totalRenderableMessages,
        totalMappingNodes,
        keptMappingNodes: totalMappingNodes,
        activeGeneration,
        thinkingOrReasoningActive,
        protectedNodeCount: protectedIds.size,
        effectiveCurrentNodeChanged: false
      };
    }

    const newMapping = buildTrimmedMapping(mapping, keptIds);
    const result = { ...data, mapping: newMapping };
    if (newMapping[effectiveCurrentNode]) result.current_node = effectiveCurrentNode;
    if ("root" in result) result.root = chooseRootNode(result.root, newMapping, keptIds, effectiveCurrentNode);

    return {
      trimmed: true,
      data: result,
      totalRenderableMessages,
      keptRenderableMessages: countRenderableNodes(newMapping),
      totalMappingNodes,
      keptMappingNodes: countOwnProperties(newMapping),
      activeGeneration,
      thinkingOrReasoningActive,
      protectedNodeCount: protectedIds.size,
      effectiveCurrentNodeChanged
    };
  }

  function buildTrimmedMapping(mapping, keptIds) {
    const parentById = new Map();
    const childrenById = new Map();
    const orderedIds = Object.keys(mapping).filter((id) => keptIds.has(id));

    for (const id of orderedIds) {
      const node = mapping[id];
      const parent = nearestKeptAncestor(mapping, node && node.parent, keptIds);
      parentById.set(id, parent);
      if (parent) {
        const children = childrenById.get(parent) || [];
        if (!children.includes(id)) children.push(id);
        childrenById.set(parent, children);
      }
    }

    const newMapping = {};
    for (const id of orderedIds) {
      const originalNode = mapping[id];
      if (!originalNode || typeof originalNode !== "object") continue;
      newMapping[id] = {
        ...originalNode,
        parent: parentById.get(id) || null,
        children: childrenById.get(id) || []
      };
    }
    return newMapping;
  }

  function nearestKeptAncestor(mapping, parentId, keptIds) {
    let id = parentId || null;
    const visited = new Set();
    while (id && mapping[id] && !visited.has(id)) {
      if (keptIds.has(id)) return id;
      visited.add(id);
      id = mapping[id].parent || null;
    }
    return null;
  }

  function chooseRootNode(originalRoot, newMapping, keptIds, effectiveCurrentNode) {
    if (originalRoot && newMapping[originalRoot]) return originalRoot;
    for (const id of keptIds) {
      if (newMapping[id] && !newMapping[id].parent) return id;
    }
    return effectiveCurrentNode;
  }

  function addNodeWithAncestorBridge(mapping, keptIds, startId, maxDepth) {
    let id = startId;
    let depth = 0;
    const visited = new Set();
    while (id && mapping[id] && !visited.has(id) && depth <= maxDepth) {
      keptIds.add(id);
      visited.add(id);
      const parent = mapping[id].parent || null;
      if (!parent || keptIds.has(parent)) break;
      id = parent;
      depth += 1;
    }
  }

  function collectActiveGenerationNodeIds(mapping) {
    const ids = [];
    for (const id of Object.keys(mapping || {})) {
      if (isActiveGenerationNode(mapping[id])) ids.push(id);
    }
    return sortNodeIdsByTime(mapping, ids);
  }

  function collectThinkingOrReasoningNodeIds(mapping) {
    const ids = [];
    for (const id of Object.keys(mapping || {})) {
      if (isThinkingOrReasoningNode(mapping[id])) ids.push(id);
    }
    return sortNodeIdsByTime(mapping, ids);
  }

  function uniqueIds(ids) {
    const seen = new Set();
    const result = [];
    for (const id of ids || []) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
    return result;
  }

  function collectRecentRenderableNodeIds(mapping, limit) {
    const ids = [];
    for (const id of Object.keys(mapping || {})) {
      if (isRenderableChatNode(mapping[id])) ids.push(id);
    }
    return sortNodeIdsByTime(mapping, ids).slice(-Math.max(0, limit || 0));
  }

  function sortNodeIdsByTime(mapping, ids) {
    return ids
      .map((id, index) => ({ id, index, time: getNodeSortTime(mapping[id]) }))
      .sort((a, b) => (a.time - b.time) || (a.index - b.index))
      .map((entry) => entry.id);
  }

  function getNodeSortTime(node) {
    const message = node && node.message;
    const candidates = [
      message && message.update_time,
      message && message.create_time,
      node && node.update_time,
      node && node.create_time
    ];
    for (const value of candidates) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  }

  function chooseEffectiveCurrentNode(mapping, currentNode, activeGenerationIds) {
    const activeDescendants = activeGenerationIds.filter((id) => pathContainsNode(mapping, id, currentNode));
    if (activeDescendants.length) return activeDescendants[activeDescendants.length - 1];

    const current = mapping[currentNode];
    const currentRole = current && current.message && current.message.author && current.message.author.role;
    if (currentRole === "user") {
      const candidateIds = [];
      for (const id of Object.keys(mapping || {})) {
        const node = mapping[id];
        const role = node && node.message && node.message.author && node.message.author.role;
        if (role === "assistant" && isRenderableChatNode(node) && pathContainsNode(mapping, id, currentNode)) {
          candidateIds.push(id);
        }
      }
      const sorted = sortNodeIdsByTime(mapping, candidateIds);
      if (sorted.length) return sorted[sorted.length - 1];
    }

    return currentNode;
  }

  function pathContainsNode(mapping, startId, targetId) {
    if (!startId || !targetId) return false;
    let id = startId;
    const visited = new Set();
    let depth = 0;
    while (id && mapping[id] && !visited.has(id) && depth < 256) {
      if (id === targetId) return true;
      visited.add(id);
      id = mapping[id].parent || null;
      depth += 1;
    }
    return false;
  }

  function isActiveGenerationNode(node) {
    if (!node || typeof node !== "object") return false;
    const message = node.message;
    if (!message || typeof message !== "object") return false;
    const role = message.author && message.author.role;
    if (role !== "assistant") return false;
    const metadata = message.metadata || {};
    if (metadata.is_visually_hidden_from_conversation === true || metadata.is_hidden_from_ui === true) return false;

    const status = String(message.status || node.status || metadata.status || metadata.state || "").toLowerCase();
    if (status && !/(finish|finished|success|complete|completed|done)/i.test(status)) return true;
    if (message.end_turn === false) return true;
    if (metadata.is_complete === false || metadata.complete === false || metadata.done === false) return true;
    if (metadata.finish_details === null && status && !status.includes("success")) return true;
    if (isThinkingOrReasoningNode(node)) return true;
    return false;
  }

  function isThinkingOrReasoningNode(node) {
    if (!node || typeof node !== "object") return false;
    const message = node.message;
    if (!message || typeof message !== "object") return false;
    const role = message.author && message.author.role;
    if (role !== "assistant") return false;
    const metadata = message.metadata || {};
    if (metadata.is_visually_hidden_from_conversation === true || metadata.is_hidden_from_ui === true) return false;

    const status = String(message.status || node.status || metadata.status || metadata.state || "").toLowerCase();
    const content = message.content || {};
    const contentType = String(content.content_type || content.type || "").toLowerCase();
    const metadataText = safeStringify(metadata).toLowerCase();
    const markerText = `${contentType} ${status} ${metadataText}`;
    const hasThinkingMarker = /think|thinking|thought|reason|reasoning|analysis|analyz/.test(markerText);
    if (!hasThinkingMarker) return false;

    // Treat thinking/reasoning nodes as live only when they look unfinished or current.
    if (status && !/(finish|finished|success|complete|completed|done)/.test(status)) return true;
    if (message.end_turn === false) return true;
    if (metadata.is_complete === false || metadata.complete === false || metadata.done === false) return true;
    if (metadata.finish_details === null && status && !status.includes("success")) return true;
    if (/thinking|reasoning|thought|analysis/.test(contentType) && message.end_turn !== true && !/(finish|finished|success|complete|completed|done)/.test(status)) return true;
    return false;
  }

  function safeStringify(value) {
    try {
      return JSON.stringify(value || {});
    } catch {
      return "";
    }
  }

  function countRenderableNodes(mapping) {
    let count = 0;
    for (const id of Object.keys(mapping || {})) {
      if (isRenderableChatNode(mapping[id])) count += 1;
    }
    return count;
  }

  function emptyTrimResult(data, totalMappingNodes = 0) {
    return {
      trimmed: false,
      data,
      totalRenderableMessages: 0,
      keptRenderableMessages: 0,
      totalMappingNodes,
      keptMappingNodes: totalMappingNodes
    };
  }

  function countOwnProperties(value) {
    if (!value || typeof value !== "object") return 0;
    let count = 0;
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) count += 1;
    }
    return count;
  }

  function buildCurrentChain(mapping, currentNode) {
    const reversed = [];
    const visited = new Set();
    let id = currentNode;

    while (id && mapping[id] && !visited.has(id)) {
      visited.add(id);
      reversed.push(id);
      id = mapping[id].parent || null;
    }

    return reversed.reverse();
  }

  function shouldKeepBeforeCutoff(node, index) {
    if (index === 0) return true;
    if (!node || typeof node !== "object") return false;
    const message = node.message;
    if (!message || typeof message !== "object") return true;
    const role = message.author && message.author.role;
    return role === "system" || role === "developer";
  }

  function isRenderableChatNode(node) {
    if (!node || typeof node !== "object") return false;
    const message = node.message;
    if (!message || typeof message !== "object") return false;
    const role = message.author && message.author.role;
    if (role !== "user" && role !== "assistant") return false;

    const metadata = message.metadata || {};
    if (metadata.is_visually_hidden_from_conversation === true) return false;
    if (metadata.is_hidden_from_ui === true) return false;

    const contentType = message.content && message.content.content_type;
    if (contentType === "model_editable_context" || contentType === "user_editable_context") return false;
    return true;
  }

  function debug(settings, ...args) {
    if (!settings || !settings.debug) return;
    try {
      console.debug(DEBUG_PREFIX, ...args);
    } catch {
      // Ignore console failures.
    }
    try {
      window.dispatchEvent(new CustomEvent(DEBUG_EVENT, {
        detail: {
          source: "mainWorld",
          version: MAIN_WORLD_VERSION,
          args: args.map(safeDebugValue)
        }
      }));
    } catch {
      // Ignore event bridge failures.
    }
  }

  function safeDebugValue(value) {
    if (value instanceof Error || (value && typeof value === "object" && typeof value.message === "string" && typeof value.name === "string")) {
      return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ""}`;
    }
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
})();
