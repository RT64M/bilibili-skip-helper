const MESSAGE_TYPE = "skip-helper:analyze";
const STYLE_ID = "bilibili-skip-helper-style";
const DETECTION_VISIBLE_MS = 3000;
const PRE_AD_PROMPT_SEC = 2;
const AUTO_JUMP_SEC = 5;
const IN_AD_AUTO_JUMP_SEC = 3;
const POST_AD_REWATCH_GRACE_SEC = 20;
let state = {};
let scanTimer;
let lastHref = location.href;

install();

function install() {
  addStyle();
  scheduleScan();
  [600, 1500, 3000].forEach((delay) => setTimeout(scheduleScan, delay));
  new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(checkRoute, 1000);
}

function checkRoute() {
  if (lastHref === location.href) return;
  lastHref = location.href;
  reset();
  scheduleScan();
}

function scheduleScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, 250);
}

function scan() {
  const bvid = getBvid();
  const video = document.querySelector("video");
  if (!bvid || !video) return;

  const key = `${bvid}:${Math.floor(video.duration || 0)}`;
  if (state.key === key && state.video === video) return;
  reset();
  state = { key, bvid, video, prompted: false, skipped: false, dismissed: false };
  video.addEventListener("timeupdate", onTimeUpdate, { passive: true });
  video.addEventListener("seeking", onSeeking, { passive: true });
  video.addEventListener("seeked", onSeeked, { passive: true });

  chrome.runtime.sendMessage({ type: MESSAGE_TYPE, bvid, duration: video.duration }, (response) => {
    if (state.key !== key) return;
    if (chrome.runtime.lastError) return console.debug("[skip-helper]", chrome.runtime.lastError.message);
    if (!response?.ok) return console.debug("[skip-helper]", response?.error);
    state.candidate = response.data?.candidate;
    showDetectionResult(state.candidate);
    handleInAdEntry(true);
  });
}

function onTimeUpdate() {
  const { candidate, dismissed, prompted, skipped, video } = state;
  if (video) state.lastTime = video.currentTime;
  if (!candidate || dismissed || prompted || skipped || !video || state.autoSkipSuppressed) return;
  if (isInAdSegment(video.currentTime, candidate)) return handleInAdEntry(false);

  const trigger = Math.max(0, candidate.start - PRE_AD_PROMPT_SEC);
  if (video.currentTime >= trigger && video.currentTime < candidate.start) showAutoPrompt(candidate);
}

function onSeeking() {
  state.seekFrom = Number.isFinite(state.lastTime) ? state.lastTime : state.video?.currentTime;
}

function onSeeked() {
  applyManualReviewSuppression();
  handleInAdEntry(true);
  if (state.video) state.lastTime = state.video.currentTime;
}

function handleInAdEntry(force) {
  const { candidate, dismissed, skipped, video } = state;
  if (!candidate || dismissed || skipped || !video || state.autoSkipSuppressed || !isInAdSegment(video.currentTime, candidate)) return;
  if (!force && state.prompted) return;
  if (!force && state.promptKind === "inside") return;
  showInAdPrompt(candidate);
}

function applyManualReviewSuppression() {
  const { candidate, video } = state;
  if (!candidate || !video || !isInAdSegment(video.currentTime, candidate)) return;

  const from = state.seekFrom;
  const to = video.currentTime;
  const rewoundInsideAd = isInAdSegment(from, candidate) && to < from - 0.5;
  const returnedLongAfterAd = from >= candidate.target + POST_AD_REWATCH_GRACE_SEC;
  if (!rewoundInsideAd && !returnedLongAfterAd) return;

  state.autoSkipSuppressed = true;
  state.prompted = false;
  clearPromptTimers();
  clearToasts();
}

function isInAdSegment(time, candidate) {
  return time >= candidate.start && time < candidate.target - 1;
}

function showDetectionResult(candidate) {
  const box = toast();
  const text = document.createElement("div");
  text.className = "bsh-text";
  text.textContent = candidate
    ? `已识别广告时间段 ${formatTime(candidate.start)}-${formatTime(candidate.target)}，${candidate.votes} 条弹幕线索`
    : "未识别到广告时间段";
  box.append(text);
  document.body.append(box);
  state.detectionTimer = setTimeout(() => box.isConnected && box.remove(), DETECTION_VISIBLE_MS);
}

function showAutoPrompt(candidate) {
  clearPromptTimers();
  state.prompted = true;
  state.promptKind = "pre";
  let remaining = AUTO_JUMP_SEC;
  const box = toast();
  const text = document.createElement("div");
  text.className = "bsh-text";
  const updateText = () => {
    text.textContent = `即将跳过广告 ${formatTime(candidate.start)}-${formatTime(candidate.target)}，${remaining} 秒后跳到 ${formatTime(candidate.target)}`;
  };
  updateText();

  const actions = document.createElement("div");
  actions.className = "bsh-actions";
  actions.append(button("跳过", true, () => skip(candidate)), button("忽略", false, dismiss));
  box.append(text, actions);
  document.body.append(box);

  state.countdownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining > 0) updateText();
  }, 1000);
  state.autoJumpTimer = setTimeout(() => {
    if (state.candidate === candidate && !state.dismissed && !state.skipped) skip(candidate);
  }, AUTO_JUMP_SEC * 1000);
}

function showInAdPrompt(candidate) {
  clearPromptTimers();
  state.prompted = true;
  state.promptKind = "inside";
  let remaining = IN_AD_AUTO_JUMP_SEC;
  const box = toast();
  const text = document.createElement("div");
  text.className = "bsh-text";
  const updateText = () => {
    text.textContent = `已进入广告段，${remaining} 秒后跳到 ${formatTime(candidate.target)}`;
  };
  updateText();

  const actions = document.createElement("div");
  actions.className = "bsh-actions";
  actions.append(button("跳过", true, () => skip(candidate)), button("忽略", false, dismiss));
  box.append(text, actions);
  document.body.append(box);

  state.countdownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining > 0) updateText();
  }, 1000);
  state.autoJumpTimer = setTimeout(() => {
    if (state.candidate === candidate && !state.dismissed && !state.skipped && isInAdSegment(state.video.currentTime, candidate)) {
      skip(candidate);
    }
  }, IN_AD_AUTO_JUMP_SEC * 1000);
}

function skip(candidate) {
  clearPromptTimers();
  if (!state.video) return;
  const previous = state.video.currentTime;
  state.video.currentTime = candidate.target;
  state.skipped = true;
  showUndo(previous);
}

function showUndo(previous) {
  const box = toast();
  const text = document.createElement("div");
  text.className = "bsh-text";
  text.textContent = "已跳过广告片段";
  const actions = document.createElement("div");
  actions.className = "bsh-actions";
  actions.append(button("撤回", true, () => {
    state.video.currentTime = previous;
    dismiss();
  }));
  box.append(text, actions);
  document.body.append(box);
  setTimeout(() => box.isConnected && box.remove(), 5000);
}

function dismiss() {
  state.dismissed = true;
  clearPromptTimers();
  clearToasts();
}

function reset() {
  if (state.video) state.video.removeEventListener("timeupdate", onTimeUpdate);
  if (state.video) state.video.removeEventListener("seeking", onSeeking);
  if (state.video) state.video.removeEventListener("seeked", onSeeked);
  clearPromptTimers();
  clearToasts();
  state = {};
}

function toast() {
  clearTimeout(state.detectionTimer);
  state.detectionTimer = undefined;
  clearToasts();
  const box = document.createElement("div");
  box.className = "bsh-toast";
  box.setAttribute("role", "status");
  return box;
}

function clearPromptTimers() {
  clearInterval(state.countdownTimer);
  clearTimeout(state.autoJumpTimer);
  state.countdownTimer = undefined;
  state.autoJumpTimer = undefined;
  state.promptKind = undefined;
}

function clearToasts() {
  document.querySelectorAll(".bsh-toast").forEach((node) => node.remove());
}

function button(label, primary, onClick) {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  node.dataset.primary = String(primary);
  node.addEventListener("click", onClick);
  return node;
}

function getBvid() {
  return /\/video\/(BV[a-zA-Z0-9]+)/.exec(location.href)?.[1];
}

function formatTime(value) {
  const total = Math.max(0, Math.floor(value));
  const minute = Math.floor(total / 60);
  const second = total % 60;
  return `${minute}:${String(second).padStart(2, "0")}`;
}

function addStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .bsh-toast {
      position: fixed;
      z-index: 2147483647;
      right: 24px;
      top: 88px;
      max-width: 320px;
      color: #fff;
      background: rgba(17, 24, 39, .94);
      border: 1px solid rgba(255, 255, 255, .14);
      border-radius: 8px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, .28);
      font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 12px;
    }
    .bsh-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      margin-top: 10px;
    }
    .bsh-actions button {
      border: 0;
      border-radius: 6px;
      cursor: pointer;
      font: inherit;
      padding: 6px 10px;
    }
    .bsh-actions button[data-primary="true"] {
      background: #fb7185;
      color: #fff;
    }
  `;
  document.head.append(style);
}
