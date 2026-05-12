(() => {
  "use strict";

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
  const GITHUB_REPO = "ch040602/Chatgpt-web-booster_chrome_extentsion";

  const ids = Object.keys(DEFAULT_SETTINGS);
  const NUMBER_SETTING_IDS = new Set([
    "visibleTurns",
    "loadMoreBatch",
    "prefetchBatches",
    "apiCacheEntries",
    "apiCacheMaxKb",
    "maintenanceIntervalSec"
  ]);
  const TEXT_SETTING_IDS = new Set([]);
  const saved = document.getElementById("saved");
  const metricMain = document.getElementById("metricMain");
  const metricSub = document.getElementById("metricSub");
  const metricLines = document.getElementById("metricLines");
  const refreshMetrics = document.getElementById("refreshMetrics");
  const openReadme = document.getElementById("openReadme");
  const openReadmeKo = document.getElementById("openReadmeKo");
  const exportDebugLog = document.getElementById("exportDebugLog");
  const clearDebugLog = document.getElementById("clearDebugLog");
  const checkGitUpdate = document.getElementById("checkGitUpdate");
  const downloadGitUpdate = document.getElementById("downloadGitUpdate");
  const openGitRelease = document.getElementById("openGitRelease");
  const openExtensionsPage = document.getElementById("openExtensionsPage");
  const reloadExtension = document.getElementById("reloadExtension");
  const gitUpdateStatus = document.getElementById("gitUpdateStatus");
  const gitUpdateLines = document.getElementById("gitUpdateLines");
  const DEBUG_LOG_KEY = "cgptLongChatLoader.debugLog.v1";
  const GITHUB_API_ROOT = "https://api.github.com/repos";
  let latestUpdateInfo = null;
  const README_URLS = Object.freeze({
    en: "https://github.com/ch040602/Chatgpt-web-booster_chrome_extentsion/blob/main/README.md",
    ko: "https://github.com/ch040602/Chatgpt-web-booster_chrome_extentsion/blob/main/README.ko.md"
  });

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
    if (openReadme) openReadme.addEventListener("click", () => openExternalPage(README_URLS.en));
    if (openReadmeKo) openReadmeKo.addEventListener("click", () => openExternalPage(README_URLS.ko));
    if (exportDebugLog) exportDebugLog.addEventListener("click", exportDebugLogFile);
    if (clearDebugLog) clearDebugLog.addEventListener("click", clearDebugLogEntries);
    if (checkGitUpdate) checkGitUpdate.addEventListener("click", checkGitHubUpdate);
    if (downloadGitUpdate) downloadGitUpdate.addEventListener("click", downloadLatestUpdate);
    if (openGitRelease) openGitRelease.addEventListener("click", openLatestReleasePage);
    if (openExtensionsPage) openExtensionsPage.addEventListener("click", openChromeExtensionsPage);
    if (reloadExtension) reloadExtension.addEventListener("click", () => chrome.runtime.reload());

    renderUpdateIdle();
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

  function storageGetKeys(keys) {
    return new Promise((resolve) => {
      if (!hasChromeStorage()) return resolve({});
      chrome.storage.local.get(keys, (value) => resolve(value || {}));
    });
  }

  function storageRemove(key) {
    return new Promise((resolve) => {
      if (!hasChromeStorage() || !chrome.storage.local.remove) return resolve(false);
      chrome.storage.local.remove(key, () => resolve(!chrome.runtime.lastError));
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
      else el.value = String(settings[id] ?? "");
    }
  }

  async function saveFromForm() {
    const next = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.type === "checkbox") next[id] = el.checked;
      else if (NUMBER_SETTING_IDS.has(id)) next[id] = clampInt(el.value, Number(el.min), Number(el.max), DEFAULT_SETTINGS[id]);
      else if (TEXT_SETTING_IDS.has(id)) next[id] = normalizeGitHubRepo(el.value, DEFAULT_SETTINGS[id]);
      else next[id] = el.value;
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
      safeNetworkMode: merged.safeNetworkMode === false ? false : true,
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
    appendMetricLine("응답 진행 보호", formatLiveReply(metrics.liveReply));
    appendMetricLine("Live API rewrite", formatLiveTrimBypass(metrics.liveTrimBypass));
    appendMetricLine("Thinking shield", formatThinkingShield(metrics));
    appendMetricLine("보안 안전 잠금", formatSafetyLock(metrics.safetyLock));
    appendMetricLine("Safe original pass", formatSafeBypass(metrics.safeBypass));
    appendMetricLine("Trim 상태", formatTrimState(metrics.trimState));
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
    const placement = loadMore.placement && loadMore.placement !== "none" ? ` · ${loadMore.placement}` : "";
    return `${mode} · ${loadMore.reason || "표시"}${placement}`;
  }

  function formatLiveReply(liveReply) {
    if (!liveReply || !liveReply.active) return "대기";
    const age = positiveNumber(liveReply.ageSec) ? ` · ${formatNumber(liveReply.ageSec)}초 전` : "";
    const count = positiveNumber(liveReply.protectedCount) ? ` · 최근 ${formatNumber(liveReply.protectedCount)}개 보호` : "";
    const recovery = liveReply.streamRecovery ? ` · 복구 대기 ${formatNumber(liveReply.streamRecoveryAgeSec || 0)}초` : "";
    return `활성 · ${liveReply.reason || "reply"}${age}${count}${recovery}`;
  }

  function formatLiveTrimBypass(state) {
    if (!state || !state.active) return "대기";
    return `원본 통과 · ${formatNumber(state.remainingSec)}초 · ${state.reason || "active reply"}`;
  }

  function formatThinkingShield(metrics) {
    const live = metrics && metrics.liveReply ? metrics.liveReply : {};
    const bypass = metrics && metrics.liveTrimBypass ? metrics.liveTrimBypass : {};
    const reason = String(live.reason || bypass.reason || "");
    const active = Boolean((live.active || bypass.active) && /think|reason|thought|analysis|analyz|추론|생각|분석/i.test(reason));
    if (!active) return "대기";
    const remaining = positiveNumber(bypass.remainingSec) ? ` · ${formatNumber(bypass.remainingSec)}초 원본 통과` : "";
    return `활성 · ${reason}${remaining}`;
  }

  function formatSafetyLock(lock) {
    if (!lock || !lock.active) return "대기";
    return `활성 · ${formatNumber(lock.remainingSec)}초 · ${lock.reason || "safety"}`;
  }

  function formatSafeBypass(state) {
    if (!state || !state.active) return "대기";
    const age = positiveNumber(state.ageSec) ? ` · ${formatNumber(state.ageSec)}초 전` : "";
    return `원본 통과 · ${state.reason || "safe mode"}${age}`;
  }

  function formatTrimState(trimState) {
    if (!trimState || !trimState.active) return "없음";
    const source = trimState.statsSource === "session-marker" ? "marker" : trimState.statsSource === "live-or-recent" ? "live" : trimState.statsSource || "active";
    const age = positiveNumber(trimState.ageSec) ? ` · ${formatNumber(trimState.ageSec)}초` : "";
    return `${trimState.remembered ? "보존됨" : "감지됨"} · ${source}${age}`;
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
    const maxKb = positiveNumber(settings.apiCacheMaxKb) || positiveNumber(cache.maxKb) || 512;
    let suffix = settings.safeNetworkMode ? " · safe initial-only" : "";
    if (cache && cache.suspended) suffix += ` · 일시중지 ${formatNumber(cache.suspendedForSec)}초 · ${cache.suspendedReason || "active"}`;
    else if (api && api.cacheHit) suffix += " · hit";
    else if (api && api.cacheStored) suffix += " · 저장됨";
    else if (api && api.cacheEligible === false) suffix += " · 미저장";
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


  function renderUpdateIdle() {
    latestUpdateInfo = null;
    setUpdateStatus("수동 확인 전", "업데이트 확인 버튼을 누르면 고정된 저장소를 확인합니다.");
    clearUpdateLines();
    setDownloadButtonEnabled(false);
  }

  async function checkGitHubUpdate() {
    const repo = GITHUB_REPO;

    setDownloadButtonEnabled(false);
    setUpdateStatus("확인 중", "GitHub release와 main branch manifest를 확인합니다.");
    clearUpdateLines();

    try {
      const info = await fetchUpdateInfo(repo);
      latestUpdateInfo = info;
      renderUpdateInfo(info);
      return info;
    } catch (error) {
      latestUpdateInfo = null;
      setUpdateStatus("확인 실패", String(error && error.message ? error.message : error));
      clearUpdateLines();
      setDownloadButtonEnabled(false);
      return null;
    }
  }

  async function fetchUpdateInfo(repo) {
    const currentVersion = getCurrentVersion();
    const repoInfo = await fetchGitHubJson(`${GITHUB_API_ROOT}/${repo}`);
    const defaultBranch = repoInfo.default_branch || "main";

    const [releaseResult, manifestResult] = await Promise.allSettled([
      fetchLatestRelease(repo),
      fetchMainManifest(repo, defaultBranch)
    ]);

    const release = releaseResult.status === "fulfilled" ? releaseResult.value : null;
    const mainManifest = manifestResult.status === "fulfilled" ? manifestResult.value : null;
    const candidates = [];

    if (release && release.ok) {
      const releaseVersion = extractVersionFromStrings([
        release.data.name,
        release.data.tag_name,
        release.data.body,
        ...((release.data.assets || []).map((asset) => asset && asset.name))
      ]);
      const download = selectReleaseDownload(repo, release.data);
      candidates.push({
        source: "release",
        label: "latest release",
        version: releaseVersion,
        htmlUrl: release.data.html_url || `https://github.com/${repo}/releases/latest`,
        publishedAt: release.data.published_at || release.data.created_at || "",
        downloadUrl: download.url,
        downloadName: download.name,
        downloadKind: download.kind,
        raw: release.data
      });
    }

    if (mainManifest && mainManifest.ok) {
      candidates.push({
        source: "main",
        label: `${defaultBranch} branch`,
        version: mainManifest.manifest.version || "",
        htmlUrl: `https://github.com/${repo}`,
        publishedAt: repoInfo.pushed_at || repoInfo.updated_at || "",
        downloadUrl: `https://github.com/${repo}/archive/refs/heads/${encodeURIComponent(defaultBranch)}.zip`,
        downloadName: `${repo.split("/")[1]}-${defaultBranch}.zip`,
        downloadKind: "source zip",
        raw: mainManifest.manifest
      });
    }

    const versioned = candidates.filter((candidate) => candidate.version);
    const best = versioned.length
      ? versioned.sort((a, b) => compareVersions(b.version, a.version))[0]
      : candidates[0] || null;
    const compare = best && best.version ? compareVersions(best.version, currentVersion) : 0;

    return {
      repo,
      currentVersion,
      defaultBranch,
      release: release && release.ok ? release.data : null,
      releaseError: releaseResult.status === "rejected" ? String(releaseResult.reason && releaseResult.reason.message ? releaseResult.reason.message : releaseResult.reason) : null,
      mainManifest: mainManifest && mainManifest.ok ? mainManifest.manifest : null,
      mainError: manifestResult.status === "rejected" ? String(manifestResult.reason && manifestResult.reason.message ? manifestResult.reason.message : manifestResult.reason) : null,
      candidates,
      best,
      updateAvailable: Boolean(best && best.version && compare > 0),
      compare
    };
  }

  async function fetchLatestRelease(repo) {
    try {
      const data = await fetchGitHubJson(`${GITHUB_API_ROOT}/${repo}/releases/latest`);
      return { ok: true, data };
    } catch (error) {
      if (String(error && error.message ? error.message : error).includes("404")) return { ok: false, error: "no release" };
      throw error;
    }
  }

  async function fetchMainManifest(repo, branch) {
    const encodedPath = "manifest.json";
    const data = await fetchGitHubJson(`${GITHUB_API_ROOT}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`);
    if (!data || data.type !== "file" || !data.content) throw new Error("manifest.json not found on default branch");
    const decoded = decodeBase64Utf8(data.content);
    return { ok: true, manifest: JSON.parse(decoded) };
  }

  async function fetchGitHubJson(url) {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${response.statusText}`);
    return response.json();
  }

  function renderUpdateInfo(info) {
    clearUpdateLines();
    const best = info && info.best ? info.best : null;
    if (!best) {
      setUpdateStatus("업데이트 정보 없음", "GitHub release 또는 main branch manifest를 찾지 못했습니다.");
      appendUpdateLine("현재 버전", info ? info.currentVersion : getCurrentVersion());
      setDownloadButtonEnabled(false);
      return;
    }

    if (info.updateAvailable) {
      setUpdateStatus("업데이트 있음", `${best.label} ${best.version} 사용 가능`);
    } else if (best.version && info.compare < 0) {
      setUpdateStatus("로컬이 더 최신", `설치 버전 ${info.currentVersion} / 원격 ${best.version}`);
    } else if (best.version) {
      setUpdateStatus("최신 상태", `설치 버전 ${info.currentVersion} / 원격 ${best.version}`);
    } else {
      setUpdateStatus("버전 비교 불가", "다운로드 URL은 찾았지만 원격 버전을 파싱하지 못했습니다.");
    }

    appendUpdateLine("현재 버전", info.currentVersion);
    appendUpdateLine("선택된 원격", `${best.label}${best.version ? ` · ${best.version}` : ""}`);
    appendUpdateLine("Release", formatReleaseSummary(info.release));
    appendUpdateLine("main manifest", info.mainManifest && info.mainManifest.version ? info.mainManifest.version : (info.mainError || "미감지"));
    appendUpdateLine("다운로드", best.downloadUrl ? `${best.downloadKind || "zip"} · ${best.downloadName || "latest"}` : "없음");
    appendUpdateLine("주의", "다운로드 후 압축 해제 및 Load unpacked 교체 필요");
    setDownloadButtonEnabled(Boolean(best.downloadUrl));
  }

  function formatReleaseSummary(release) {
    if (!release) return "미감지";
    const version = extractVersionFromStrings([release.name, release.tag_name, release.body]) || release.tag_name || release.name || "release";
    const date = release.published_at ? ` · ${formatDateShort(release.published_at)}` : "";
    return `${version}${date}`;
  }

  function selectReleaseDownload(repo, release) {
    const assets = Array.isArray(release && release.assets) ? release.assets : [];
    const zipAssets = assets
      .filter((asset) => asset && asset.browser_download_url && /\.zip(?:$|[?#])/i.test(asset.name || asset.browser_download_url))
      .sort((a, b) => scoreAsset(b) - scoreAsset(a));
    if (zipAssets.length) {
      const asset = zipAssets[0];
      return { url: asset.browser_download_url, name: asset.name || "latest.zip", kind: "release asset" };
    }
    if (release && release.zipball_url) {
      const name = `${repo.split("/")[1]}-${release.tag_name || "latest"}-source.zip`.replace(/[^\w.-]+/g, "-");
      return { url: release.zipball_url, name, kind: "source zip" };
    }
    return { url: "", name: "", kind: "" };
  }

  function scoreAsset(asset) {
    const name = String(asset && asset.name ? asset.name : "").toLowerCase();
    let score = 0;
    if (name.includes("chatgpt")) score += 4;
    if (name.includes("long")) score += 2;
    if (name.includes("loader")) score += 3;
    if (name.includes("chrome")) score += 3;
    if (name.includes("extension") || name.includes("extentsion")) score += 2;
    if (name.includes("source")) score -= 3;
    return score;
  }

  async function downloadLatestUpdate() {
    let info = latestUpdateInfo;
    if (!info || !info.best || !info.best.downloadUrl) info = await checkGitHubUpdate();
    const best = info && info.best ? info.best : null;
    if (!best || !best.downloadUrl) {
      setUpdateStatus("다운로드 불가", "GitHub release asset 또는 source ZIP URL을 찾지 못했습니다.");
      return;
    }

    const filename = sanitizeFilename(best.downloadName || `chatgpt-long-chat-loader-${best.version || "latest"}.zip`);
    if (chrome.downloads && chrome.downloads.download) {
      chrome.downloads.download({ url: best.downloadUrl, filename, saveAs: true }, (downloadId) => {
        if (chrome.runtime.lastError) {
          setUpdateStatus("다운로드 실패", chrome.runtime.lastError.message || "downloads API error");
          return;
        }
        setUpdateStatus("다운로드 시작", `download id: ${downloadId}. 압축 해제 후 확장 관리에서 교체하세요.`);
      });
    } else {
      openExternalPage(best.downloadUrl);
      setUpdateStatus("다운로드 페이지 열림", "downloads API를 사용할 수 없어 URL을 새 탭으로 열었습니다.");
    }
  }

  function openLatestReleasePage() {
    const repo = GITHUB_REPO;
    const url = latestUpdateInfo && latestUpdateInfo.best && latestUpdateInfo.best.htmlUrl
      ? latestUpdateInfo.best.htmlUrl
      : `https://github.com/${repo}/releases/latest`;
    openExternalPage(url);
  }

  function openChromeExtensionsPage() {
    try {
      chrome.tabs.create({ url: "chrome://extensions/" }, () => {
        if (chrome.runtime.lastError) setUpdateStatus("관리 페이지 열기 실패", chrome.runtime.lastError.message);
      });
    } catch (error) {
      setUpdateStatus("관리 페이지 열기 실패", String(error && error.message ? error.message : error));
    }
  }

  function setUpdateStatus(main, detail) {
    if (!gitUpdateStatus) return;
    gitUpdateStatus.textContent = detail ? `${main} · ${detail}` : main;
  }

  function clearUpdateLines() {
    if (gitUpdateLines) gitUpdateLines.textContent = "";
  }

  function appendUpdateLine(label, value) {
    if (!gitUpdateLines) return;
    const row = document.createElement("div");
    row.className = "status-line";
    const left = document.createElement("span");
    left.textContent = label;
    const right = document.createElement("strong");
    right.textContent = value || "—";
    row.append(left, right);
    gitUpdateLines.appendChild(row);
  }

  function setDownloadButtonEnabled(enabled) {
    if (downloadGitUpdate) downloadGitUpdate.disabled = !enabled;
  }

  function getCurrentVersion() {
    try {
      return chrome.runtime.getManifest().version || "0.0.0";
    } catch {
      return "0.0.0";
    }
  }

  function getSettingValue(id) {
    const el = document.getElementById(id);
    if (!el) return DEFAULT_SETTINGS[id];
    return el.type === "checkbox" ? el.checked : el.value;
  }

  function normalizeGitHubRepo(value, fallback) {
    let text = String(value || "").trim();
    if (!text) text = fallback;
    text = text.replace(/^https?:\/\/github\.com\//i, "").replace(/^github\.com\//i, "");
    text = text.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
    const parts = text.split("/").filter(Boolean);
    if (parts.length >= 2) text = `${parts[0]}/${parts[1]}`;
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) return text;
    return fallback;
  }

  function extractVersionFromStrings(values) {
    for (const value of values) {
      const text = String(value || "");
      const match = text.match(/(?:^|[^0-9A-Za-z])v?(\d+(?:\.\d+){1,3})(?:[-+][0-9A-Za-z.-]+)?/);
      if (match) return match[1];
    }
    return "";
  }

  function compareVersions(a, b) {
    const left = parseVersionParts(a);
    const right = parseVersionParts(b);
    for (let i = 0; i < Math.max(left.length, right.length, 4); i += 1) {
      const diff = (left[i] || 0) - (right[i] || 0);
      if (diff > 0) return 1;
      if (diff < 0) return -1;
    }
    return 0;
  }

  function parseVersionParts(value) {
    const match = String(value || "").match(/\d+(?:\.\d+){0,3}/);
    if (!match) return [0, 0, 0, 0];
    return match[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
  }

  function decodeBase64Utf8(value) {
    const clean = String(value || "").replace(/\s+/g, "");
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  }

  function sanitizeFilename(value) {
    const filename = String(value || "latest.zip").replace(/[\\/:*?"<>|]+/g, "-").replace(/^\.+/, "");
    return filename.toLowerCase().endsWith(".zip") ? filename : `${filename}.zip`;
  }

  function formatDateShort(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" });
  }

  function openExternalPage(url) {
    chrome.tabs.create({ url });
  }

  async function exportDebugLogFile() {
    const value = await storageGetKeys([DEBUG_LOG_KEY]);
    const entries = Array.isArray(value[DEBUG_LOG_KEY]) ? value[DEBUG_LOG_KEY] : [];
    const exportedAt = new Date();
    const payload = {
      schemaVersion: 1,
      exportedAt: exportedAt.toISOString(),
      extension: "ChatGPT Long Chat Loader",
      purpose: "Debug log export for GPT-assisted issue analysis",
      entries
    };
    downloadTextFile(
      `chatgpt-long-chat-loader-debug-${formatTimestampForFile(exportedAt)}.json`,
      JSON.stringify(payload, null, 2),
      "application/json"
    );
  }

  async function clearDebugLogEntries() {
    await storageRemove(DEBUG_LOG_KEY);
    if (saved) {
      saved.textContent = "디버그 로그 비움";
      clearTimeout(clearDebugLogEntries.timer);
      clearDebugLogEntries.timer = setTimeout(() => { saved.textContent = ""; }, 900);
    }
  }

  function downloadTextFile(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function formatTimestampForFile(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate())
    ].join("") + "-" + [
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds())
    ].join("");
  }
})();
