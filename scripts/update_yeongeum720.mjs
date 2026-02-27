import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const DATA_DIR = path.join(ROOT, "data");
const DRAWS_PATH = path.join(DATA_DIR, "yeongeum720_draws.json");
const FREQ_PATH = path.join(DATA_DIR, "yeongeum720_freq.json");

// ✅ GitHub hosted runner에서 dhlottery 접근이 막히는 경우가 있어(대기/차단 HTML)
// ✅ 공개적으로 접근 가능한 “회차별 당첨번호 리스트” 페이지를 1차 소스로 사용
const PRIMARY_SOURCE_URL = "https://signalfire85.tistory.com/277";

function nowIso() {
  return new Date().toISOString();
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function ymdDotToIso(s) {
  // "2026.02.19" -> "2026-02-19"
  const m = String(s).match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
      "accept-language": "ko-KR,ko;q=0.9,en;q=0.7",
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Fetch failed: HTTP ${res.status} ${res.statusText}`);
  }
  return text;
}

function htmlToLooseText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function normalizeLine(s) {
  // 티스토리/웹뷰에서 링크 마크업이 텍스트로 풀리면서 "" 같은 형태가 됨
  // -> 이런 괄호/기호 제거
  return s
    .replace(/【\d+†/g, "")
    .replace(/】/g, "")
    .res+/g, " ")
    .trim();
}

async function fetchDrawsFromPrimary() {
  const html = await fetchText(PRIMARY_SOURCE_URL);
  const text = htmlToLooseText(html);
  const lines = text
    .split("\n")
    .map((l) => normalizeLine(l))
    .filter(Boolean);

  const draws = [];

  // 예시:
  // 303회 2026.02.19 1등 4 6 3 9 5 6 6 1
  // 보너스 각조 6 1 9 1 3 6 10
  const reFirst =
    /^(\d{1,4})회\s+(\d{4}\.\d{2}\.\d{2})\s+1등\s+([1-5])\s+([0-9])\s+([0-9])\s+([0-9])\s+([0-9])\s+([0-9])\s+([0-9])\s+(\d+)\s*$/;
  const reBonus =
    /^보너스\s+각조\s+([0-9])\s+([0-9])\s+([0-9])\s+([0-9])\s+([0-9])\s+([0-9])\s+(\d+)\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(reFirst);
    if (!m) continue;

    const round = Number(m[1]);
    const dateIso = ymdDotToIso(m[2]);

    const group = Number(m[3]);
    const digits = [m[4], m[5], m[6], m[7], m[8], m[9]].map(Number);
    const winners = Number(m[10]);

    let bonusDigits = null;
    let bonusWinners = null;

    const b = (lines[i + 1] || "").match(reBonus);
    if (b) {
      bonusDigits = [b[1], b[2], b[3], b[4], b[5], b[6]].map(Number);
      bonusWinners = Number(b[7]);
    }

    draws.push({
      round,
      date: dateIso,
      first: { group, digits, winners },
      bonus: bonusDigits ? { digits: bonusDigits, winners: bonusWinners } : null,
      source: PRIMARY_SOURCE_URL,
    });
  }

  if (!draws.length) {
    throw new Error(
      `Failed to parse draws from primary source: ${PRIMARY_SOURCE_URL}\n(페이지 구조가 바뀌었거나, 접근이 막혔을 수 있음)`
    );
  }

  // 회차 오름차순 정렬
  draws.sort((a, b) => a.round - b.round);

  // 중복 제거(round 기준)
  const map = new Map(draws.map((d) => [d.round, d]));
  return [...map.values()].sort((a, b) => a.round - b.round);
}

function makeEmptyDigitCount() {
  const o = {};
  for (let d = 0; d <= 9; d++) o[String(d)] = 0;
  return o;
}

function makeEmptyGroupCount() {
  const o = {};
  for (let g = 1; g <= 5; g++) o[String(g)] = 0;
  return o;
}

function inc(obj, k) {
  obj[k] = (obj[k] ?? 0) + 1;
}

function rankKeysByCount(countObj, numeric = true) {
  const keys = Object.keys(countObj);
  keys.sort((a, b) => {
    const da = countObj[a] ?? 0;
    const db = countObj[b] ?? 0;
    if (db !== da) return db - da;
    return numeric ? Number(a) - Number(b) : String(a).localeCompare(String(b));
  });
  return keys;
}

function buildFreq(draws) {
  const groupCounts = makeEmptyGroupCount();

  const digitCounts = {
    pos1: makeEmptyDigitCount(),
    pos2: makeEmptyDigitCount(),
    pos3: makeEmptyDigitCount(),
    pos4: makeEmptyDigitCount(),
    pos5: makeEmptyDigitCount(),
    pos6: makeEmptyDigitCount(),
  };

  const bonusDigitCounts = {
    pos1: makeEmptyDigitCount(),
    pos2: makeEmptyDigitCount(),
    pos3: makeEmptyDigitCount(),
    pos4: makeEmptyDigitCount(),
    pos5: makeEmptyDigitCount(),
    pos6: makeEmptyDigitCount(),
  };

  const tail5Counts = {
    pos2: makeEmptyDigitCount(),
    pos3: makeEmptyDigitCount(),
    pos4: makeEmptyDigitCount(),
    pos5: makeEmptyDigitCount(),
    pos6: makeEmptyDigitCount(),
  };

  for (const d of draws) {
    const g = String(d.first.group);
    inc(groupCounts, g);

    d.first.digits.forEach((x, i) => {
      const k = `pos${i + 1}`;
      inc(digitCounts[k], String(x));
      if (i >= 1) inc(tail5Counts[k], String(x));
    });

    if (d.bonus?.digits) {
      d.bonus.digits.forEach((x, i) => {
        const k = `pos${i + 1}`;
        inc(bonusDigitCounts[k], String(x));
      });
    }
  }

  return {
    generated_at: nowIso(),
    rounds: draws.length,
    max_round: draws.length ? Math.max(...draws.map((x) => x.round)) : null,
    group_counts: groupCounts,
    digit_counts: digitCounts,
    bonus_digit_counts: bonusDigitCounts,
    tail5_digit_counts: tail5Counts,
    source: {
      kind: "public-page-parse",
      url: PRIMARY_SOURCE_URL,
    },
  };
}

// ✅ 무작위 없이 “순환”만
function pickIndex(tier, pos, idx, len) {
  if (len <= 1) return 0;

  let span = len;
  if (tier === "top") span = Math.min(1, len);
  else if (tier === "topmix") span = Math.min(3, len);
  else if (tier === "mix") span = Math.min(6, len);
  else if (tier === "wide") span = len;

  const tailBias = pos >= 4 ? 0 : 1;
  const base = (idx + pos * 2 + tailBias) % span;
  return base;
}

function recommendFromFreq(freq, n, cycle) {
  const groupRank = rankKeysByCount(freq.group_counts, true).map(Number);

  const digitRank = {};
  for (let p = 1; p <= 6; p++) {
    const k = `pos${p}`;
    digitRank[k] = rankKeysByCount(freq.digit_counts[k], true).map(Number);
  }

  const tier = n === 1 ? "top" : n === 5 ? "topmix" : "mix";

  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = cycle + i;
    const group = groupRank[idx % groupRank.length];

    const digits = [];
    for (let p = 1; p <= 6; p++) {
      const r = digitRank[`pos${p}`];
      const pi = pickIndex(tier, p, idx, r.length);
      digits.push(r[pi]);
    }

    out.push({ group, digits });
  }
  return out;
}

function formatTicket(t) {
  return `${t.group}조 ${t.digits.join("")}`;
}

function formatMd(freq, rec1, rec5, rec10) {
  const maxRound = freq.max_round ?? "-";
  const gen = freq.generated_at ?? "-";
  return [
    `## 연금복권720+ 빈도 기반 추천 (비무작위)`,
    ``,
    `- 데이터 기준: 누적 ${freq.rounds}회 (최대 회차: ${maxRound})`,
    `- 생성 시각: ${gen}`,
    `- 소스: ${freq.source?.url ?? "-"}`,
    ``,
    `### ✅ 1개 추천`,
    rec1.map((t) => `- \`${formatTicket(t)}\``).join("\n"),
    ``,
    `### ✅ 5개 추천`,
    rec5.map((t) => `- \`${formatTicket(t)}\``).join("\n"),
    ``,
    `### ✅ 10개 추천`,
    rec10.map((t) => `- \`${formatTicket(t)}\``).join("\n"),
    ``,
    `> 참고: 연금720+의 2등은 1등과 조만 다른 동일 6자리, 3등은 끝 5자리 일치 조건입니다.`,
    `> 과거 빈도는 미래 당첨을 보장하지 않습니다.`,
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    noUpdate: false,
    recommend: 0,
    format: "text", // text | md
    cycle: 0,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-update") args.noUpdate = true;
    else if (a === "--recommend") args.recommend = Number(argv[++i] ?? "0");
    else if (a === "--format") args.format = String(argv[++i] ?? "text");
    else if (a === "--cycle") args.cycle = Number(argv[++i] ?? "0");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  await fs.mkdir(DATA_DIR, { recursive: true });

  // 기존 draws 로드(있으면 병합)
  let draws = [];
  if (await exists(DRAWS_PATH)) {
    const s = await fs.readFile(DRAWS_PATH, "utf-8");
    draws = safeJsonParse(s, []);
  }

  if (!args.noUpdate) {
    const fetched = await fetchDrawsFromPrimary();

    // 병합 (round 기준)
    const map = new Map();
    for (const d of draws) map.set(d.round, d);
    for (const d of fetched) map.set(d.round, d);
    draws = [...map.values()].sort((a, b) => a.round - b.round);

    await fs.writeFile(DRAWS_PATH, JSON.stringify(draws, null, 2), "utf-8");
  }

  // freq 생성/저장
  const freq = buildFreq(draws);
  await fs.writeFile(FREQ_PATH, JSON.stringify(freq, null, 2), "utf-8");

  // 이슈 댓글/콘솔 추천 출력
  if (args.recommend > 0) {
    const cycle = Number.isFinite(args.cycle) ? args.cycle : 0;
    const rec1 = recommendFromFreq(freq, 1, cycle);
    const rec5 = recommendFromFreq(freq, 5, cycle);
    const rec10 = recommendFromFreq(freq, 10, cycle);

    if (args.format === "md") console.log(formatMd(freq, rec1, rec5, rec10));
    else {
      console.log("[1개]", rec1.map(formatTicket).join(" / "));
      console.log("[5개]", rec5.map(formatTicket).join(" / "));
      console.log("[10개]", rec10.map(formatTicket).join(" / "));
    }
  }
}

main().catch((e) => {
  console.error("Error:", e?.message || e);
  process.exit(1);
});
