import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const DATA_DIR = path.join(ROOT, "data");
const DRAWS_PATH = path.join(DATA_DIR, "yeongeum720_draws.json");
const FREQ_PATH = path.join(DATA_DIR, "yeongeum720_freq.json");

// GitHub-hosted에서 dhlottery 차단이 생길 수 있어 공개 페이지(티스토리) 파싱
const PRIMARY_SOURCE_URL = "https://signalfire85.tistory.com/277";
const POS_NAMES = ["십만", "만", "천", "백", "십", "일"];

function nowIso() { return new Date().toISOString(); }

function ymdDotToIso(s) {
  const m = String(s).match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
      "accept-language": "ko-KR,ko;q=0.9,en;q=0.7",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status} ${res.statusText}`);
  return text;
}

function htmlToLooseText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
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

function normalizeAll(s) {
  return String(s)
    .replace(/【\d+†/g, "")
    .replace(/】/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchDrawsFromPrimary() {
  const html = await fetchText(PRIMARY_SOURCE_URL);
  const loose = htmlToLooseText(html);
  const text = normalizeAll(loose.replace(/\n/g, " "));

  // 303회 2026.02.19 1등 4 6 3 9 5 6 6 1
  const reFirst =
    /(\d{1,4})회\s*(\d{4}\.\d{2}\.\d{2})\s*1등\s*([1-5])\s*([0-9])\s*([0-9])\s*([0-9])\s*([0-9])\s*([0-9])\s*([0-9])\s*(\d+)/g;

  // 보너스 각조 6 1 9 1 3 6 10
  const reBonus =
    /보너스\s*각조\s*([0-9])\s*([0-9])\s*([0-9])\s*([0-9])\s*([0-9])\s*([0-9])\s*(\d+)/g;

  const firstMatches = [...text.matchAll(reFirst)].map((m) => ({
    index: m.index ?? 0,
    round: Number(m[1]),
    dateDot: m[2],
    group: Number(m[3]),
    digits: [m[4], m[5], m[6], m[7], m[8], m[9]].map(Number),
    winners: Number(m[10]),
    rawLen: m[0].length,
  }));

  const bonusMatches = [...text.matchAll(reBonus)].map((m) => ({
    index: m.index ?? 0,
    digits: [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number),
    winners: Number(m[7]),
    rawLen: m[0].length,
  }));

  if (!firstMatches.length) {
    throw new Error(`Failed to parse draws from primary source: ${PRIMARY_SOURCE_URL}`);
  }

  // 1등 다음에 나오는 가장 가까운 보너스 매칭(너무 멀면 무시)
  let b = 0;
  const draws = [];
  for (const f of firstMatches) {
    const dateIso = ymdDotToIso(f.dateDot);

    while (b < bonusMatches.length && bonusMatches[b].index < f.index) b++;

    let bonus = null;
    if (b < bonusMatches.length) {
      const c = bonusMatches[b];
      const dist = c.index - (f.index + f.rawLen);
      if (dist >= 0 && dist <= 250) {
        bonus = { digits: c.digits, winners: c.winners };
        b += 1;
      }
    }

    draws.push({
      round: f.round,
      date: dateIso,
      first: { group: f.group, digits: f.digits, winners: f.winners },
      bonus,
      source: PRIMARY_SOURCE_URL,
    });
  }

  const map = new Map(draws.map((d) => [d.round, d]));
  return [...map.values()].sort((a, b) => a.round - b.round);
}

function makeEmptyDigitCounts() {
  const o = {};
  for (let d = 0; d <= 9; d++) o[String(d)] = 0;
  return o;
}
function makeEmptyGroupCounts() {
  const o = {};
  for (let g = 1; g <= 5; g++) o[String(g)] = 0;
  return o;
}
function inc(obj, k) { obj[k] = (obj[k] ?? 0) + 1; }

function rankCounts(countsObj) {
  const keys = Object.keys(countsObj);
  keys.sort((a, b) => {
    const da = countsObj[a] ?? 0;
    const db = countsObj[b] ?? 0;
    if (db !== da) return db - da;
    return Number(a) - Number(b);
  });
  return keys.map((k) => ({ digit: Number(k), count: countsObj[k] ?? 0 }));
}

// index.html이 기대하는 스키마:
// freq.updatedAt
// freq.rounds.{min,max,count}
// freq.group.ranked / freq.positions[].ranked
function buildFreq(draws) {
  const groupCounts = makeEmptyGroupCounts();

  const posCounts = Array.from({ length: 6 }, () => makeEmptyDigitCounts());
  const overallCounts = makeEmptyDigitCounts();

  const bonusPosCounts = Array.from({ length: 6 }, () => makeEmptyDigitCounts());
  const bonusOverallCounts = makeEmptyDigitCounts();

  const last5Map = new Map();

  for (const d of draws) {
    inc(groupCounts, String(d.first.group));

    d.first.digits.forEach((digit, idx) => {
      inc(posCounts[idx], String(digit));
      inc(overallCounts, String(digit));
    });

    const last5 = d.first.digits.slice(1).join("");
    last5Map.set(last5, (last5Map.get(last5) || 0) + 1);

    if (d.bonus?.digits) {
      d.bonus.digits.forEach((digit, idx) => {
        inc(bonusPosCounts[idx], String(digit));
        inc(bonusOverallCounts, String(digit));
      });
    }
  }

  const rounds = draws.length
    ? { min: Math.min(...draws.map((x) => x.round)), max: Math.max(...draws.map((x) => x.round)), count: draws.length }
    : { min: null, max: null, count: 0 };

  const positions = posCounts.map((counts, idx) => ({
    name: POS_NAMES[idx],
    counts,
    ranked: rankCounts(counts),
  }));

  const bonusPositions = bonusPosCounts.map((counts, idx) => ({
    name: POS_NAMES[idx],
    counts,
    ranked: rankCounts(counts),
  }));

  const last5Top = [...last5Map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([last5, count]) => ({ last5, count }));

  return {
    updatedAt: nowIso(),
    source: { primary: PRIMARY_SOURCE_URL },
    rounds,
    group: { counts: groupCounts, ranked: rankCounts(groupCounts) },
    positions,
    overall: { counts: overallCounts, ranked: rankCounts(overallCounts) },
    bonus: { positions: bonusPositions, overall: { counts: bonusOverallCounts, ranked: rankCounts(bonusOverallCounts) } },
    third: { last5Top },
  };
}

// ─────────────────────────────────────────────────────────
// 추천(이슈 댓글용) : UI 규칙과 동일 + 2등/3등 힌트 포함

function ranksFromFreq(freq) {
  return {
    groupRank: (freq.group?.ranked || []).map(x => x.digit),
    posRank: (freq.positions || []).map(p => (p.ranked || []).map(x => x.digit)),
  };
}

function makeHints(group, digits) {
  const number = digits.join("");
  const last5 = number.slice(1);
  const secondGroups = [1,2,3,4,5].filter(g => g !== group);
  return { number, last5, secondGroups };
}

function recommend1TopCycle(freq, cycle=1) {
  const { groupRank, posRank } = ranksFromFreq(freq);

  const gLen = groupRank.length || 1;
  const group = groupRank[cycle % gLen] ?? 1;

  const digits = [];
  for (let p = 0; p < 6; p++) {
    const r = posRank[p] || [0,1,2,3,4,5,6,7,8,9];
    const span = Math.min(3, r.length || 1);
    const idx = (cycle + p) % span;
    digits.push(r[idx] ?? r[0] ?? 0);
  }

  return [{ label: "1", mode: "Top3 순환", group, digits, ...makeHints(group, digits) }];
}

function recommend5TopMix(freq, cycle=1) {
  const { groupRank, posRank } = ranksFromFreq(freq);
  const topSpan = 3;
  const gSpan = Math.min(2, groupRank.length || 2);

  const patterns = [
    [0,0,0,0,0,0],
    [1,0,1,0,1,0],
    [0,1,0,1,0,1],
    [2,1,2,1,2,1],
    [1,2,1,2,1,2],
  ];

  const out = [];
  const base = cycle % topSpan;

  for (let i=0;i<5;i++) {
    const pat = patterns[i];
    const group = groupRank[(i + cycle) % gSpan] ?? (groupRank[0] ?? 1);

    const digits = [];
    for (let p=0;p<6;p++) {
      const r = posRank[p] || [0,1,2,3,4,5,6,7,8,9];
      const span = Math.min(topSpan, r.length || 1);
      const idx = (pat[p] + base + i) % span;
      digits.push(r[idx] ?? 0);
    }

    out.push({ label: String(i+1), mode: "상위 혼합", group, digits, ...makeHints(group, digits) });
  }
  return out;
}

function recommend10Spread(freq, cycle=1) {
  const { groupRank, posRank } = ranksFromFreq(freq);

  const patterns = [
    [0,0,0,0,0,0],
    [1,1,1,1,1,1],
    [2,2,2,2,2,2],
    [3,4,3,4,3,4],
    [4,3,4,3,4,3],
    [5,6,5,6,5,6],
    [6,5,6,5,6,5],
    [7,8,7,8,7,8],
    [8,7,8,7,8,7],
    [9,9,9,9,9,9],
  ];

  const out = [];
  const base = cycle % 10;
  const gLen = groupRank.length || 5;

  for (let i=0;i<10;i++) {
    const pat = patterns[i];
    const group = groupRank[(i + cycle) % gLen] ?? 1;

    const digits = [];
    for (let p=0;p<6;p++) {
      const r = posRank[p] || [0,1,2,3,4,5,6,7,8,9];
      const idx = (pat[p] + base + p + i) % (r.length || 1);
      digits.push(r[idx] ?? 0);
    }

    out.push({ label: String(i+1), mode: "상~중~하 분산", group, digits, ...makeHints(group, digits) });
  }
  return out;
}

function formatTicketLine(t) {
  const second = t.secondGroups.map(g => `${g}조 ${t.number}`).join(" · ");
  return [
    `- **${t.group}조 ${t.number}** _(패턴: ${t.mode})_`,
    `  - 2등(조만 변경): ${second}`,
    `  - 3등(끝 5자리): \`${t.last5}\``,
  ].join("\n");
}

function formatMd(freq, rec1, rec5, rec10) {
  const maxRound = freq.rounds?.max ?? "-";
  const gen = freq.updatedAt ?? "-";
  const src = freq.source?.primary ?? "-";

  return [
    `## 연금복권720+ 빈도 기반 추천 (무작위 X)`,
    ``,
    `- 데이터: 누적 ${freq.rounds?.count ?? 0}회 (최대 회차: ${maxRound})`,
    `- 생성 시각: ${gen}`,
    `- 소스: ${src}`,
    ``,
    `### ✅ 1개 추천 (Top3 순환)`,
    rec1.map(formatTicketLine).join("\n"),
    ``,
    `### ✅ 5개 추천 (상위 혼합)`,
    rec5.map(formatTicketLine).join("\n"),
    ``,
    `### ✅ 10개 추천 (상~중~하 분산)`,
    rec10.map(formatTicketLine).join("\n"),
    ``,
    `> 과거 빈도는 미래 당첨을 보장하지 않습니다.`,
  ].join("\n");
}

function parseArgs(argv) {
  const args = { noUpdate: false, recommend: 0, format: "text", cycle: 1 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-update") args.noUpdate = true;
    else if (a === "--recommend") args.recommend = Number(argv[++i] ?? "0");
    else if (a === "--format") args.format = String(argv[++i] ?? "text");
    else if (a === "--cycle") args.cycle = Number(argv[++i] ?? "1");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  await fs.mkdir(DATA_DIR, { recursive: true });

  // 기존 draws(배열) 로드
  let draws = [];
  if (await exists(DRAWS_PATH)) {
    const s = await fs.readFile(DRAWS_PATH, "utf-8");
    draws = safeJsonParse(s, []);
  }

  // 업데이트 + 저장
  if (!args.noUpdate) {
    const fetched = await fetchDrawsFromPrimary();
    const map = new Map();
    for (const d of draws) map.set(d.round, d);
    for (const d of fetched) map.set(d.round, d);
    draws = [...map.values()].sort((a, b) => a.round - b.round);

    await fs.writeFile(DRAWS_PATH, JSON.stringify(draws, null, 2), "utf-8");
  }

  // freq 생성/저장
  const freq = buildFreq(draws);
  await fs.writeFile(FREQ_PATH, JSON.stringify(freq, null, 2), "utf-8");

  // 추천 출력(이슈/콘솔)
  if (args.recommend > 0) {
    const cycle = Number.isFinite(args.cycle) ? args.cycle : 1;

    const rec1 = recommend1TopCycle(freq, cycle);
    const rec5 = recommend5TopMix(freq, cycle);
    const rec10 = recommend10Spread(freq, cycle);

    if (args.format === "md") {
      console.log(formatMd(freq, rec1, rec5, rec10));
    } else {
      console.log("[1개]", rec1.map(t => `${t.group}조 ${t.number}`).join(" / "));
      console.log("[5개]", rec5.map(t => `${t.group}조 ${t.number}`).join(" / "));
      console.log("[10개]", rec10.map(t => `${t.group}조 ${t.number}`).join(" / "));
    }
  }
}

main().catch((e) => {
  console.error("Error:", e?.message || e);
  process.exit(1);
});
