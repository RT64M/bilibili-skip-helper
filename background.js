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
const CHINESE_DIGITS = new Map([
  ["零", "0"], ["〇", "0"], ["○", "0"], ["一", "1"], ["壹", "1"], ["二", "2"], ["两", "2"], ["贰", "2"],
  ["三", "3"], ["叁", "3"], ["四", "4"], ["肆", "4"], ["五", "5"], ["伍", "5"], ["六", "6"], ["陆", "6"],
  ["七", "7"], ["柒", "7"], ["八", "8"], ["捌", "8"], ["九", "9"], ["玖", "9"]
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== MESSAGE_TYPE) return false;
  if (sender.id !== chrome.runtime.id) return false;
  analyzeVideo(message.bvid, message.duration, message.debug === true)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
  return true;
});

async function analyzeVideo(bvid, pageDuration, debug = false) {
  const id = String(bvid);
  if (id.length > 32 || !/^BV[a-zA-Z0-9]+$/.test(id)) return {};

  const info = await getJson(`${API_BASE}/x/web-interface/view?bvid=${encodeURIComponent(id)}`);
  const video = info.data || {};
  const cid = video.cid || (video.pages || []).find((page) => page.cid)?.cid;
  const duration = finite(pageDuration) || finite(video.duration) || 0;
  if (!cid) return {};

  const xml = await getText(`${API_BASE}/x/v1/dm/list.so?oid=${encodeURIComponent(cid)}`);
  const lines = parseDanmaku(xml);
  const analysis = findCandidate(lines, duration, debug);
  return {
    candidate: analysis.candidate,
    ...(debug ? { debug: { bvid: id, cid, duration, xmlLength: xml.length, ...analysis.debug } } : {})
  };
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

function findCandidate(lines, duration, debug = false) {
  const votes = [];
  const debugInfo = debug ? {
    totalLines: lines.length,
    timeCodedLines: 0,
    signalLines: 0,
    negativeLines: 0,
    acceptedVotes: 0,
    rejected: {
      noTime: 0,
      noSignal: 0,
      jumpTooShort: 0,
      jumpTooLong: 0,
      beyondDuration: 0
    },
    clusters: []
  } : undefined;

  for (const line of lines) {
    const text = compact(line.text);
    if (!text) continue;
    if (hasAny(text, NEGATIVE_WORDS)) {
      if (debugInfo) debugInfo.negativeLines += 1;
      continue;
    }
    const times = extractTimes(text);
    const hasJumpSignal = hasAny(text, JUMP_WORDS);
    const hasAdSignal = hasAny(text, AD_WORDS);
    const hasEndSignal = hasAny(text, END_WORDS);
    if (debugInfo && times.length) debugInfo.timeCodedLines += 1;
    if (debugInfo && (hasJumpSignal || hasAdSignal || hasEndSignal)) debugInfo.signalLines += 1;
    if (!times.length) {
      if (debugInfo) debugInfo.rejected.noTime += 1;
      continue;
    }
    if (!(hasJumpSignal || hasAdSignal || hasEndSignal)) {
      if (debugInfo) debugInfo.rejected.noSignal += 1;
      continue;
    }

    for (const target of times) {
      const jump = target - line.time;
      if (jump < RULES.minJumpSec) {
        if (debugInfo) debugInfo.rejected.jumpTooShort += 1;
        continue;
      }
      if (jump > RULES.maxJumpSec) {
        if (debugInfo) debugInfo.rejected.jumpTooLong += 1;
        continue;
      }
      if (duration && target > duration + 2) {
        if (debugInfo) debugInfo.rejected.beyondDuration += 1;
        continue;
      }
      if (debugInfo) debugInfo.acceptedVotes += 1;
      votes.push({ target, lineTime: line.time, text: line.text });
    }
  }

  const clusters = clusterVotes(votes);
  if (debugInfo) {
    debugInfo.clusters = clusters.map((cluster) => ({
      target: Math.round(average(cluster, "target")),
      votes: cluster.length,
      lineStart: Math.floor(Math.min(...cluster.map((vote) => vote.lineTime))),
      lineEnd: Math.floor(Math.max(...cluster.map((vote) => vote.lineTime))),
      evidence: [...new Set(cluster.map((vote) => vote.text))].slice(0, 3)
    }));
  }
  const best = clusters
    .filter((cluster) => cluster.length >= RULES.minVotes)
    .sort((a, b) => b.length - a.length || average(a, "target") - average(b, "target"))[0];
  if (!best) return { candidate: undefined, debug: debugInfo };

  const target = Math.round(average(best, "target"));
  const starts = best.map((vote) => vote.lineTime).sort((a, b) => a - b);
  const rawStart = Math.max(0, Math.floor(starts[Math.floor(starts.length / 4)] || 0));
  const start = Math.min(rawStart + RULES.startDelaySec, Math.max(0, target - RULES.minJumpSec));
  return {
    candidate: {
    start,
    rawStart,
    target,
    votes: best.length,
    evidence: [...new Set(best.map((vote) => vote.text))].slice(0, 3)
    },
    debug: debugInfo
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
    const time = parseCompactTimeCode(match[1]);
    if (time !== undefined) times.add(time);
  }
  for (const match of text.matchAll(/[零〇○一壹二两贰三叁四肆五伍六陆七柒八捌九玖]{3,4}/gu)) {
    const time = parseCompactTimeCode(chineseDigitsToAscii(match[0]));
    if (time !== undefined) times.add(time);
  }
  return [...times].filter((time) => Number.isSafeInteger(time) && time >= 0);
}

function parseCompactTimeCode(value) {
  if (!/^\d{3,4}$/.test(value)) return undefined;
  const minute = Number(value.slice(0, -2));
  const second = Number(value.slice(-2));
  return second < 60 ? minute * 60 + second : undefined;
}

function chineseDigitsToAscii(value) {
  return [...value].map((char) => CHINESE_DIGITS.get(char) || "").join("");
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
    const value = code.startsWith("#x")
      ? Number.parseInt(code.slice(2), 16)
      : code.startsWith("#")
        ? Number.parseInt(code.slice(1), 10)
        : NaN;
    if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return entity;
    if (value >= 0xd800 && value <= 0xdfff) return entity;
    try {
      return String.fromCodePoint(value);
    } catch {
      return entity;
    }
  });
}
