import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const DATA_DIR = path.join(ROOT, "data");
const DRAWS_PATH = path.join(DATA_DIR, "yeongeum720_draws.json");
const FREQ_PATH = path.join(DATA_DIR, "yeongeum720_freq.json");

// GitHub hosted runner에서 dhlottery 차단이 나올 수 있어 공개 페이지(티스토리) 기반 파싱
const PRIMARY_SOURCE_URL = "https://signalfire85.tistory.com/277";

const POS_NAMES = ["십만", "만", "천", "백", "십", "일"];

function nowIso() {
  return new Date().toISOString();
}

function ymdDotToIso(s) {
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
  // "" 같은 표시 제거 + 공백 정리
  return String(s)
    .replace(/【\d+†/g, "")
    .replace(/】/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * ✅ 핵심 변경:
 * - 라인 단위가 아니라, "전체 텍스트"에서 정규식 matchAll로 스캔
 * - 줄바꿈이 없든 있든(=GitHub에서 HTML이 한 줄로 와도) 파싱됨
 */
async function fetchDrawsFromPrimary() {
  const html = await fetchText(PRIMARY_SOURCE_URL);
  const loose = htmlToLooseText(html);

  // 줄바꿈을 공백으로 치환해도 되게 통합 텍스트로 만든다
  const text = normalizeAll(loose.replace(/\n/g, " "));

  // 303회 2026.02.19 1등 4 6 3 9 5 6 6 1
  // 공백/콤마 유무에 상관없이 동작하도록 \s*로 구성
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
    throw new Error(
      `Failed to parse draws from primary source: ${PRIMARY_SOURCE_URL}\n(페이지 구조가 바뀌었거나, Actions에서 받은 HTML이 달라졌을 수 있음)`
    );
  }

  // 1등 라인 다음에 나오는 “가장 가까운 보너스”를 매칭
  let b = 0;
  const draws = [];
  for (const f of firstMatches) {
    const dateIso = ymdDotToIso(f.dateDot);

    // f 이후에 등장하는 bonus 중 가장 가까운 것 선택
    while (b < bonusMatches.length && bonusMatches[b].index < f.index) b++;

    let bonus = null;
    if (b < bonusMatches.length) {
      const candidate = bonusMatches[b];

      // 너무 멀리 떨어진 보너스는 다른 구간일 수 있으니 안전장치(거리 제한)
      const fEnd = f.index + f.rawLen;
      const dist = candidate.index - fEnd;

      if (dist >= 0 && dist <= 200) {
        bonus = { digits: candidate.digits, winners: candidate.winners };
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

  // 중복 제거 + 오름차순 정렬
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

function inc(obj, k) {
  obj[k] = (obj[k] ?? 0) + 1;
}

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

    // 3등(끝 5자리) 참고용
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
    ? {
        min: Math.min(...draws.map((x) => x.round)),
        max: Math.max(...draws.map((x) => x.round)),
        count: draws.length,
      }
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
    bonus: {
      positions: bonusPositions,
      overall: { counts: bonusOverallCounts, ranked: rankCounts(bonusOverallCounts) },
    },
    third: { last5Top },
  };
}

// 추천(이슈 댓글용): 무작위 없이 “순환(cycle)”만
function pickIndex(tier, pos, idx, len) {
  if (len <= 1) return 0;
  let span = len;
  if (tier === "top") span = Math.min(1, len);
  else if (tier === "topmix") span = Math.min(3, len);
  else if (tier === "mix") span = Math.min(6, len);

  const tailBias = pos >= 4 ? 0 : 1;
  return (idx + pos * 2 + tailBias) % span;
}

function recommendFromFreq(freq, n, cycle) {
  if (!freq.rounds?.count) {
    throw new Error("추천할 데이터가 없습니다. 먼저 update 워크플로우로 data/*.json을 생성하세요.");
  }

  const groupRank = freq.group.ranked.map((x) => x.digit);
  const posRank = freq.positions.map((p) => p.ranked.map((x) => x.digit)); // 6 x 10
  const tier = n === 1 ? "top" : n === 5 ? "topmix" : "mix";

  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = cycle + i;
    const group = groupRank[idx % groupRank.length];

    const digits = [];
    for (let p = 0; p < 6; p++) {
      const r = posRank[p];
      const pi = pickIndex(tier, p + 1, idx, r.length);
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
  const maxRound = freq.rounds?.max ?? "-";
  const gen = freq.updatedAt ?? "-";
  const src = freq.source?.primary ?? "-";
  return [
    `## 연금복권720+ 빈도 기반 추천 (비무작위)`,
    ``,
    `- 데이터 기준: 누적 ${freq.rounds?.count ?? 0}회 (최대 회차: ${maxRound})`,
    `- 생성 시각: ${gen}`,
    `- 소스: ${src}`,
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
    `> 참고: 2등은 1등과 조만 다른 동일 6자리, 3등은 끝 5자리 일치 조건입니다.`,
    `> 과거 빈도는 미래 당첨을 보장하지 않습니다.`,
  ].join("\n");
}

function parseArgs(argv) {
  const args = { noUpdate: false, recommend: 0, format: "text", cycle: 0 };
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
