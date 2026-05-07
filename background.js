const MESSAGE_TYPE = "skip-helper:analyze";
const API_BASE = "https://api.bilibili.com";
const RULES = {
  minVotes: 3,
  clusterSec: 6,
  minJumpSec: 10,
  maxJumpSec: 300,
  startDelaySec: 5
};

const AD_WORDS = ["广告", "广子", "恰饭", "商单", "赞助", "推广", "口播", "植入", "ad", "sponsor"];
const JUMP_WORDS = ["空降", "指路", "省流", "跳到", "跳转", "跳过", "快进", "传送", "拉到", "工程"];
const END_WORDS = ["结束", "完了", "正片", "回来", "回归", "感谢空降", "谢谢空降", "感谢指路", "谢谢指路"];
const NEGATIVE_WORDS = ["别跳", "不要跳", "不用跳", "没广告", "不是广告", "别空降", "不要空降"];

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== MESSAGE_TYPE) return false;
  analyzeVideo(message.bvid, message.duration)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
  return true;
});

async function analyzeVideo(bvid, pageDuration) {
  if (!/^BV[a-zA-Z0-9]+$/.test(String(bvid))) return {};

  const info = await getJson(`${API_BASE}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
  const video = info.data || {};
  const cid = video.cid || (video.pages || []).find((page) => page.cid)?.cid;
  const duration = finite(pageDuration) || finite(video.duration) || 0;
  if (!cid) return {};

  const xml = await getText(`${API_BASE}/x/v1/dm/list.so?oid=${encodeURIComponent(cid)}`);
  return { candidate: findCandidate(parseDanmaku(xml), duration) };
}

async function getJson(url) {
  const response = await fetch(url, { cache: "no-store", credentials: "omit" });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  const data = await response.json();
  if (data.code !== 0) throw new Error(data.message || `Bilibili API code ${data.code}`);
  return data;
}

async function getText(url) {
  const response = await fetch(url, { cache: "no-store", credentials: "omit" });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.text();
}

function parseDanmaku(xml) {
  const lines = [];
  const pattern = /<d\s+[^>]*p="([^"]+)"[^>]*>([\s\S]*?)<\/d>/gu;
  for (const match of xml.matchAll(pattern)) {
    const time = Number(match[1].split(",")[0]);
    const text = decodeXml(match[2]).trim();
    if (Number.isFinite(time) && text) lines.push({ time, text });
  }
  return lines;
}

function findCandidate(lines, duration) {
  const votes = [];
  for (const line of lines) {
    const text = compact(line.text);
    if (!text || hasAny(text, NEGATIVE_WORDS)) continue;
    const times = extractTimes(text);
    const hasJumpSignal = hasAny(text, JUMP_WORDS);
    const hasAdSignal = hasAny(text, AD_WORDS);
    const hasEndSignal = hasAny(text, END_WORDS);
    if (!times.length || !(hasJumpSignal || hasAdSignal || hasEndSignal)) continue;

    for (const target of times) {
      const jump = target - line.time;
      if (jump < RULES.minJumpSec || jump > RULES.maxJumpSec) continue;
      if (duration && target > duration + 2) continue;
      votes.push({ target, lineTime: line.time, text: line.text });
    }
  }

  const clusters = clusterVotes(votes);
  const best = clusters
    .filter((cluster) => cluster.length >= RULES.minVotes)
    .sort((a, b) => b.length - a.length || average(a, "target") - average(b, "target"))[0];
  if (!best) return undefined;

  const target = Math.round(average(best, "target"));
  const starts = best.map((vote) => vote.lineTime).sort((a, b) => a - b);
  const rawStart = Math.max(0, Math.floor(starts[Math.floor(starts.length / 4)] || 0));
  const start = Math.min(rawStart + RULES.startDelaySec, Math.max(0, target - RULES.minJumpSec));
  return {
    start,
    rawStart,
    target,
    votes: best.length,
    evidence: [...new Set(best.map((vote) => vote.text))].slice(0, 3)
  };
}

function clusterVotes(votes) {
  const clusters = [];
  for (const vote of [...votes].sort((a, b) => a.target - b.target)) {
    const last = clusters[clusters.length - 1];
    if (!last || Math.abs(vote.target - average(last, "target")) > RULES.clusterSec) clusters.push([vote]);
    else last.push(vote);
  }
  return clusters;
}

function extractTimes(text) {
  const times = new Set();
  for (const match of text.matchAll(/(?<!\d)(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)(?!\d)/gu)) {
    const hour = match[1] === undefined ? 0 : Number(match[1]);
    times.add(hour * 3600 + Number(match[2]) * 60 + Number(match[3]));
  }
  for (const match of text.matchAll(/(?<!\d)(\d{3,4})(?!\d)/gu)) {
    const value = match[1];
    const minute = Number(value.slice(0, -2));
    const second = Number(value.slice(-2));
    if (second < 60) times.add(minute * 60 + second);
  }
  return [...times].filter((time) => Number.isSafeInteger(time) && time >= 0);
}

function compact(text) {
  return String(text).toLocaleLowerCase().replace(/\s+/g, "").replace(/[，。！？、,.!?]/gu, "");
}

function hasAny(text, words) {
  return words.some((word) => text.includes(compact(word)));
}

function average(items, key) {
  return items.reduce((sum, item) => sum + item[key], 0) / Math.max(1, items.length);
}

function finite(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : undefined;
}

function decodeXml(text) {
  return text.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/giu, (entity, body) => {
    const code = body.toLowerCase();
    if (code === "amp") return "&";
    if (code === "lt") return "<";
    if (code === "gt") return ">";
    if (code === "quot") return '"';
    if (code === "apos") return "'";
    if (code.startsWith("#x")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
    return entity;
  });
}
