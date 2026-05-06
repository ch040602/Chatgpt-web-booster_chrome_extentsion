(() => {
  "use strict";

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

  const ids = Object.keys(DEFAULT_SETTINGS);
  const saved = document.getElementById("saved");
  const metricMain = document.getElementById("metricMain");
  const metricSub = document.getElementById("metricSub");
  const metricLines = document.getElementById("metricLines");
  const refreshMetrics = document.getElementById("refreshMetrics");
  const openReadme = document.getElementById("openReadme");
  const openReadmeKo = document.getElementById("openReadmeKo");

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    const settings = normalize(await storageGetAll());
    renderSettings(settings);
    await storageSet(settings);

    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.addEventListener("change", saveFromForm);
      if (el.type === "number") el.addEventListener("input", saveFromForm);
    }

    if (refreshMetrics) refreshMetrics.addEventListener("click", requestMetricsOnce);
    if (openReadme) openReadme.addEventListener("click", () => openExtensionPage("README.md"));
    if (openReadmeKo) openReadmeKo.addEventListener("click", () => openExtensionPage("README.ko.md"));

    requestMetricsOnce();
  }

  function storageGetAll() {
    return new Promise((resolve) => {
      if (!hasChromeStorage()) return resolve({});
      chrome.storage.local.get(null, (value) => resolve(value || {}));
    });
  }

  function storageSet(value) {
    return new Promise((resolve) => {
      if (!hasChromeStorage()) return resolve(false);
      chrome.storage.local.set(value, () => resolve(!chrome.runtime.lastError));
    });
  }

  function hasChromeStorage() {
    return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
  }

  function renderSettings(settings) {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.type === "checkbox") el.checked = Boolean(settings[id]);
      else el.value = String(settings[id]);
    }
  }

  async function saveFromForm() {
    const next = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.type === "checkbox") next[id] = el.checked;
      else next[id] = clampInt(el.value, Number(el.min), Number(el.max), DEFAULT_SETTINGS[id]);
    }

    const normalized = normalize(next);
    renderSettings(normalized);
    await storageSet(normalized);
    if (saved) {
      saved.textContent = "저장됨";
      clearTimeout(saveFromForm.timer);
      saveFromForm.timer = setTimeout(() => { saved.textContent = ""; }, 900);
    }
    scheduleMetricRefresh();
  }

  function normalize(value) {
    const source = value && typeof value === "object" ? value : {};
    const nested = source.settings && typeof source.settings === "object" ? source.settings : {};
    const merged = { ...DEFAULT_SETTINGS, ...nested, ...source };
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

  function scheduleMetricRefresh() {
    clearTimeout(scheduleMetricRefresh.timer);
    scheduleMetricRefresh.timer = setTimeout(requestMetricsOnce, 250);
  }

  async function requestMetricsOnce() {
    setMetricState("계산 중", "현재 활성 ChatGPT 탭에서 snapshot을 한 번 가져옵니다.");
    clearMetricLines();

    if (!chrome.tabs || !chrome.runtime) {
      renderMetricUnavailable("현재 브라우저에서 탭 측정을 사용할 수 없습니다.");
      return;
    }

    const tab = await getActiveTab();
    const tabId = tab && tab.id;
    if (!tabId) {
      renderMetricUnavailable("활성 탭을 찾지 못했습니다.");
      return;
    }

    let result = await sendMetricsMessage(tabId);
    if (!result.response || !result.response.ok) {
      const injected = await injectContentScripts(tab);
      if (injected.ok) {
        await delay(160);
        result = await sendMetricsMessage(tabId);
      } else if (injected.error && !isProbablyChatGptUrl(tab.url)) {
        renderMetricUnavailable("ChatGPT 탭에서 확장 아이콘을 눌러야 계산됩니다.");
        return;
      }
    }

    if (!result.response || !result.response.ok) {
      const detail = result.error ? ` · ${result.error}` : "";
      renderMetricUnavailable(`content script 응답 없음${detail}. ChatGPT 탭을 새로고침한 뒤 다시 여세요.`);
      return;
    }

    renderMetrics(result.response);
  }

  function getActiveTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(tabs && tabs[0] ? tabs[0] : null);
      });
    });
  }

  function sendMetricsMessage(tabId) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: "cgpt-lb-get-metrics" }, (response) => {
        const error = chrome.runtime.lastError ? chrome.runtime.lastError.message : "";
        resolve({ response, error });
      });
    });
  }

  async function injectContentScripts(tab) {
    if (!chrome.scripting || !tab || !tab.id) return { ok: false, error: "scripting API unavailable" };
    if (tab.url && !isProbablyChatGptUrl(tab.url)) return { ok: false, error: "not a ChatGPT tab" };

    await insertCss(tab.id, "content.css");
    return executeScript(tab.id, "content.js");
  }

  function insertCss(tabId, file) {
    return new Promise((resolve) => {
      try {
        chrome.scripting.insertCSS({ target: { tabId }, files: [file] }, () => {
          resolve({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError && chrome.runtime.lastError.message });
        });
      } catch (error) {
        resolve({ ok: false, error: String(error && error.message ? error.message : error) });
      }
    });
  }

  function executeScript(tabId, file) {
    return new Promise((resolve) => {
      try {
        chrome.scripting.executeScript({ target: { tabId }, files: [file] }, () => {
          resolve({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError && chrome.runtime.lastError.message });
        });
      } catch (error) {
        resolve({ ok: false, error: String(error && error.message ? error.message : error) });
      }
    });
  }

  function isProbablyChatGptUrl(url) {
    if (!url) return true;
    try {
      const parsed = new URL(url);
      return parsed.hostname === "chatgpt.com" || parsed.hostname.endsWith(".chatgpt.com") || parsed.hostname === "chat.openai.com";
    } catch {
      return false;
    }
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function renderMetricUnavailable(message) {
    setMetricState("계산 불가", message);
    clearMetricLines();
  }

  function renderMetrics(metrics) {
    clearMetricLines();
    const estimate = estimateImprovement(metrics);

    if (!metrics.routeActive) {
      setMetricState("대화 화면 아님", "ChatGPT 새 채팅 또는 대화 화면에서 계산됩니다.");
      appendMetricLine("현재 URL", shortenUrl(metrics.url));
      appendMetricLine("content script", metrics.contentVersion || "감지됨");
      return;
    }

    if (estimate) {
      setMetricState(
        `${estimate.multiplierLow.toFixed(1)}~${estimate.multiplierHigh.toFixed(1)}배`,
        `초기 파싱·렌더링·layout 작업 약 ${estimate.reductionPct}% 감소 추정`
      );
    } else {
      setMetricState("기준 부족", "API trim 기록 또는 숨김 DOM이 감지되면 추정치를 계산합니다.");
    }

    appendMetricLine("API 메시지", formatApiMessages(metrics.api));
    appendMetricLine("API 크기(추정)", formatApiSize(metrics.api));
    appendMetricLine("DOM 메시지", formatDom(metrics.dom));
    appendMetricLine("더보기 버튼", formatLoadMore(metrics.loadMore));
    appendMetricLine("응답 micro-cache", formatCache(metrics));
    appendMetricLine("API patch", formatApiPatch(metrics));
    appendMetricLine("CSS containment", formatCss(metrics));
    appendMetricLine("자동 정리", formatMaintenance(metrics.maintenance));
    appendMetricLine("JS heap", formatMemory(metrics.memory));
    appendMetricLine("DOM nodes", formatNumber(metrics.dom && metrics.dom.nodes));
    appendMetricLine("계산 시점", "팝업 열림 상태");
  }

  function estimateImprovement(metrics) {
    const api = metrics && metrics.api ? metrics.api : null;
    const dom = metrics && metrics.dom ? metrics.dom : null;
    const parts = [];

    const originalChars = positiveNumber(api && (api.originalChars || api.originalBytes));
    const trimmedChars = positiveNumber(api && (api.trimmedChars || api.trimmedBytes));
    if (originalChars > 0 && trimmedChars > 0) {
      parts.push({ value: clamp01(1 - trimmedChars / originalChars), weight: 0.50 });
    }

    const totalMessages = positiveNumber(api && (api.totalRenderableMessages || api.totalVisibleMessages));
    const keptMessages = positiveNumber(api && (api.keptRenderableMessages || api.keptVisibleMessages));
    if (totalMessages > 0 && keptMessages > 0) {
      parts.push({ value: clamp01(1 - keptMessages / totalMessages), weight: 0.35 });
    }

    if (dom && positiveNumber(dom.total) > 0) {
      parts.push({ value: clamp01((positiveNumber(dom.hidden) || 0) / dom.total), weight: parts.length ? 0.15 : 1.0 });
    }

    if (!parts.length) return null;

    let weighted = 0;
    let weight = 0;
    for (const part of parts) {
      weighted += part.value * part.weight;
      weight += part.weight;
    }
    let reduction = weight ? weighted / weight : 0;

    if (metrics.settings && metrics.settings.cssContainmentEnabled && dom && dom.total > dom.visible) {
      reduction = Math.min(0.95, reduction + 0.03);
    }

    if (reduction < 0.03) return null;

    const lowReduction = clamp01(reduction * 0.70);
    const highReduction = clamp01(Math.min(0.95, reduction * 1.15 + 0.03));
    return {
      reductionPct: Math.round(reduction * 100),
      multiplierLow: 1 / Math.max(0.05, 1 - lowReduction),
      multiplierHigh: 1 / Math.max(0.05, 1 - highReduction)
    };
  }

  function setMetricState(main, sub) {
    if (metricMain) metricMain.textContent = main;
    if (metricSub) metricSub.textContent = sub;
  }

  function clearMetricLines() {
    if (metricLines) metricLines.textContent = "";
  }

  function appendMetricLine(label, value) {
    if (!metricLines) return;
    const row = document.createElement("div");
    row.className = "metric-line";
    const left = document.createElement("span");
    left.textContent = label;
    const right = document.createElement("strong");
    right.textContent = value;
    row.append(left, right);
    metricLines.appendChild(row);
  }

  function positiveNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  function formatApiMessages(api) {
    if (!api) return "미감지";
    const total = positiveNumber(api.totalRenderableMessages || api.totalVisibleMessages);
    const kept = positiveNumber(api.keptRenderableMessages || api.keptVisibleMessages);
    if (!total) return "미감지";
    return `${formatNumber(kept || total)}/${formatNumber(total)}`;
  }

  function formatApiSize(api) {
    if (!api) return "미감지";
    const original = positiveNumber(api.originalChars || api.originalBytes);
    const trimmed = positiveNumber(api.trimmedChars || api.trimmedBytes) || original;
    if (!original) return "미감지";
    const saved = Math.max(0, original - trimmed);
    const pct = Math.round((saved / original) * 100);
    return `${formatApproxBytes(trimmed)} / ${formatApproxBytes(original)} · -${pct}%`;
  }

  function formatDom(dom) {
    if (!dom || !positiveNumber(dom.total)) return "미감지";
    return `${formatNumber(dom.visible)}/${formatNumber(dom.total)} 표시 · 숨김 ${formatNumber(dom.hidden)}`;
  }

  function formatLoadMore(loadMore) {
    if (!loadMore || !loadMore.inDom) return "없음";
    if (!loadMore.visible) return "숨김";
    const mode = loadMore.mode === "full" ? "전체 로드" : loadMore.mode === "more" ? "더보기" : loadMore.mode;
    return `${mode} · ${loadMore.reason || "표시"}`;
  }

  function formatCss(metrics) {
    const supported = Boolean(metrics && metrics.css && metrics.css.contentVisibilitySupported);
    const enabled = Boolean(metrics && metrics.settings && metrics.settings.cssContainmentEnabled);
    if (!supported) return "브라우저 미지원";
    return enabled ? "켜짐" : "꺼짐";
  }

  function formatCache(metrics) {
    const settings = metrics && metrics.settings ? metrics.settings : {};
    const api = metrics && metrics.api ? metrics.api : null;
    const cache = metrics && metrics.cache ? metrics.cache : {};
    const entries = positiveNumber(settings.apiCacheEntries) || positiveNumber(cache.entries) || 1;
    const maxKb = positiveNumber(settings.apiCacheMaxKb) || positiveNumber(cache.maxKb) || 1024;
    let suffix = "";
    if (api && api.cacheHit) suffix = " · hit";
    else if (api && api.cacheStored) suffix = " · 저장됨";
    else if (api && api.cacheEligible === false) suffix = " · 미저장";
    return `${entries}개 · 항목당 ~${formatNumber(maxKb)}KB${suffix}`;
  }

  function formatApiPatch(metrics) {
    if (!metrics) return "미감지";
    if (metrics.mainWorldVersion) return `MAIN ${metrics.mainWorldVersion}`;
    return "미감지 · 탭 새로고침 필요";
  }

  function formatMaintenance(maintenance) {
    if (!maintenance || !maintenance.enabled) return "꺼짐";
    const last = Number(maintenance.lastRunAt);
    if (!last) return `${maintenance.intervalSec || 30}초 주기 · 대기`;
    const ageSec = Math.max(0, Math.round((Date.now() - last) / 1000));
    return `${maintenance.intervalSec || 30}초 주기 · ${ageSec}초 전`;
  }

  function formatMemory(memory) {
    if (!memory || !positiveNumber(memory.usedJSHeapSize)) return "미지원";
    const used = formatApproxBytes(memory.usedJSHeapSize);
    const total = positiveNumber(memory.totalJSHeapSize) ? formatApproxBytes(memory.totalJSHeapSize) : null;
    return total ? `${used} / ${total}` : `${used} 사용`;
  }

  function formatApproxBytes(value) {
    const n = Number(value) || 0;
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${Math.round(n)} B`;
  }

  function formatNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return Math.round(n).toLocaleString("ko-KR");
  }

  function shortenUrl(url) {
    if (!url) return "—";
    try {
      const parsed = new URL(url);
      return parsed.pathname || "/";
    } catch {
      return String(url).slice(0, 48);
    }
  }

  function openExtensionPage(path) {
    const url = chrome.runtime.getURL(path);
    chrome.tabs.create({ url });
  }
})();
