import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const DATA_DIR = path.join(ROOT, "data");
const DRAWS_PATH = path.join(DATA_DIR, "yeongeum720_draws.json");
const FREQ_PATH = path.join(DATA_DIR, "yeongeum720_freq.json");

// ✅ GitHub-hosted에서 동행복권(dhlottery) 차단이 자주 발생 → 공개 페이지(티스토리) 소스 사용
const TISTORY_SOURCE_URL = "https://signalfire85.tistory.com/277";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function ymdDotToISO(ymdDot) {
  // "2026.02.19" -> "2026-02-19"
  const m = String(ymdDot).match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    const s = await fs.readFile(filePath, "utf-8");
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, obj) {
  const s = JSON.stringify(obj, null, 2);
  await fs.writeFile(filePath, s, "utf-8");
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      // 너무 봇처럼 보이지 않게
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
      "accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "ko-KR,ko;q=0.9,en;q=0.8",
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
    redirect: "follow",
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Fetch failed ${res.status} ${res.statusText} :: ${url}\n${t.slice(0, 200)}`);
  }
  return await res.text();
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

async function fetchDrawsFromTistory() {
  const html = await fetchText(TISTORY_SOURCE_URL);
  const text = htmlToLooseText(html);
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const draws = [];
  for (let i = 0; i < lines.length; i++) {
    // 예: "303회 2026.02.19 1등 4 6 3 9 5 6 6 1"
    const m = lines[i].match(
      /^(\d{1,4})회\s+(\d{4}\.\d{2}\.\d{2})\s+1등\s+([1-5])\s+([0-9])\s+([0-9])\s+([0-9])\s+([0-9])\s+([0-9])\s+([0-9])\s+(\d+)$/
    );
    if (!m) continue;

    const round = Number(m[1]);
    const dateISO = ymdDotToISO(m[2]);
    if (!dateISO) continue;

    const group = Number(m[3]);
    const digits = [m[4], m[5], m[6], m[7], m[8], m[9]].map(Number);
    const firstWinCount = Number(m[10]);

    // 다음 줄: "보너스 각조 6 1 9 1 3 6 10"
    const bLine = lines[i + 1] || "";
    const b = bLine.match(
      /^보너스\s+각조\s+([0-9])\s+([0-9])\s+([0-9])\s+([0-9])\s+([0-9])\s+([0-9])\s+(\d+)$/
    );
    const bonusDigits = b
      ? [b[1], b[2], b[3], b[4], b[5], b[6]].map(Number)
      : null;
    const bonusWinCount = b ? Number(b[7]) : null;

    const numberStr = digits.join(""); // 6자리
    const last5Str = digits.slice(1).join(""); // 3등(끝 5자리) 기준

    // 2등은 “조만 다르고 6자리는 동일”이므로 별도 번호는 동일하게 저장
    draws.push({
      round,
      date: dateISO,
      first: {
        group,
        number: numberStr,
        digits,
        winners: firstWinCount,
      },
      // 2등: 각조(1~5) 중 1등 조 제외한 조들 + 동일 6자리
      second: {
        groups: [1, 2, 3, 4, 5].filter((g) => g !== group),
        number: numberStr,
      },
      // 3등: 끝 5자리
      third: {
        last5: last5Str,
      },
      bonus: bonusDigits
        ? {
            number: bonusDigits.join(""),
            digits: bonusDigits,
            winners: bonusWinCount,
          }
        : null,
      source: "tistory",
    });
  }

  if (draws.length === 0) {
    throw new Error(
      `티스토리 소스에서 파싱 결과가 0개입니다. (페이지 구조 변경 가능)\nURL: ${TISTORY_SOURCE_URL}`
    );
  }

  // round 내림차순 정렬
  draws.sort((a, b) => b.round - a.round);
  return draws;
}

function rankCounts(countsMapOrArr) {
  // countsMapOrArr: {digit:count} or number[]
  const entries = Array.isArray(countsMapOrArr)
    ? countsMapOrArr.map((c, i) => [i, c])
    : Object.entries(countsMapOrArr).map(([k, v]) => [Number(k), Number(v)]);

  entries.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0] - b[0];
  });

  return entries.map(([digit, count]) => ({ digit, count }));
}

function buildFreq(draws) {
  const groupCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

  const posNames = ["십만", "만", "천", "백", "십", "일"];
  const posCounts = Array.from({ length: 6 }, () => Array(10).fill(0));
  const overallCounts = Array(10).fill(0);

  const bonusPosCounts = Array.from({ length: 6 }, () => Array(10).fill(0));
  const bonusOverallCounts = Array(10).fill(0);

  const last5Counts = new Map();

  for (const d of draws) {
    const g = d.first.group;
    groupCounts[g]++;

    for (let i = 0; i < 6; i++) {
      const digit = d.first.digits[i];
      posCounts[i][digit]++;
      overallCounts[digit]++;
    }

    const last5 = d.third?.last5;
    if (last5) {
      last5Counts.set(last5, (last5Counts.get(last5) || 0) + 1);
    }

    if (d.bonus?.digits) {
      for (let i = 0; i < 6; i++) {
        const digit = d.bonus.digits[i];
        bonusPosCounts[i][digit]++;
        bonusOverallCounts[digit]++;
      }
    }
  }

  const positions = posCounts.map((arr, idx) => ({
    name: posNames[idx],
    counts: Object.fromEntries(arr.map((c, d) => [String(d), c])),
    ranked: rankCounts(arr),
  }));

  const bonusPositions = bonusPosCounts.map((arr, idx) => ({
    name: posNames[idx],
    counts: Object.fromEntries(arr.map((c, d) => [String(d), c])),
    ranked: rankCounts(arr),
  }));

  // last5 상위 20개만
  const last5Ranked = [...last5Counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([last5, count]) => ({ last5, count }));

  const rounds = draws.map((d) => d.round);
  const maxRound = Math.max(...rounds);
  const minRound = Math.min(...rounds);

  return {
    updatedAt: new Date().toISOString(),
    source: {
      primary: TISTORY_SOURCE_URL,
      note:
        "동행복권(dhlottery) GitHub-hosted 러너 차단이 자주 발생해 공개 페이지(티스토리)에서 파싱",
    },
    rounds: { min: minRound, max: maxRound, count: draws.length },
    group: {
      counts: groupCounts,
      ranked: rankCounts(
        Object.fromEntries(Object.entries(groupCounts).map(([k, v]) => [k, v]))
      ),
    },
    positions,
    overall: {
      counts: Object.fromEntries(overallCounts.map((c, d) => [String(d), c])),
      ranked: rankCounts(overallCounts),
    },
    bonus: {
      positions: bonusPositions,
      overall: {
        counts: Object.fromEntries(
          bonusOverallCounts.map((c, d) => [String(d), c])
        ),
        ranked: rankCounts(bonusOverallCounts),
      },
    },
    third: {
      last5Top: last5Ranked,
    },
  };
}

function generateRecommendations(freq, howMany, seedRound) {
  // ✅ 무작위 없이 “seedRound(최신회차)” 기반으로 순환 생성
  const groupRank = freq.group.ranked.map((x) => x.digit); // [group...]
  const posRank = freq.positions.map((p) => p.ranked.map((x) => x.digit)); // 6 x 10

  // 10개까지 커버하는 고정 패턴(무작위 X)
  const patterns = [
    { name: "상위", g: 0, o: [0, 0, 0, 0, 0, 0] },
    { name: "상위-교차", g: 1, o: [1, 0, 1, 0, 1, 0] },
    { name: "혼합-분산", g: 2, o: [0, 3, 1, 4, 2, 5] },
    { name: "중위", g: 0, o: [5, 5, 5, 5, 5, 5] },
    { name: "중위-교차", g: 3, o: [6, 5, 6, 5, 6, 5] },
    { name: "하위-스파이스", g: 4, o: [8, 7, 6, 8, 7, 6] },
    { name: "상위+보정", g: 1, o: [0, 1, 2, 1, 0, 2] },
    { name: "혼합-교대", g: 2, o: [2, 6, 1, 7, 0, 8] },
    { name: "끝자리강조", g: 0, o: [4, 4, 4, 4, 2, 0] },
    { name: "분산-깊게", g: 3, o: [3, 7, 4, 8, 5, 9] },
  ];

  const base = seedRound % 10;

  const sets = [];
  for (let i = 0; i < howMany; i++) {
    const pat = patterns[i % patterns.length];

    const group = groupRank[(pat.g + (seedRound % groupRank.length)) % groupRank.length];

    const digits = [];
    for (let p = 0; p < 6; p++) {
      const rankIdx = (pat.o[p] + base + i) % 10;
      digits.push(posRank[p][rankIdx]);
    }

    // 중복 세트 방지(동일하면 마지막 자리만 한 칸 이동)
    const key = `${group}-${digits.join("")}`;
    if (sets.some((s) => `${s.group}-${s.number}` === key)) {
      digits[5] = posRank[5][(digits[5] + 1) % 10];
    }

    sets.push({
      label: `${i + 1}`,
      mode: pat.name,
      group,
      digits,
      number: digits.join(""),
    });
  }
  return sets;
}

function toMarkdown(recos, freq) {
  const latest = freq.rounds.max;
  const updated = freq.updatedAt;

  const lines = [];
  lines.push(`### 연금복권720+ 빈도 기반 추천 (무작위 X)`);
  lines.push(`- 기준 데이터: 1등 조/6자리 + 보너스 (공개 페이지 파싱)`);
  lines.push(`- 최신회차(seed): **${latest}회**`);
  lines.push(`- 갱신시각: ${updated}`);
  lines.push("");
  for (const r of recos) {
    lines.push(`- **${r.label}. ${r.group}조 ${r.number}**  _(패턴: ${r.mode})_`);
  }
  lines.push("");
  lines.push(`> 주의: 과거 빈도는 미래 당첨을 보장하지 않습니다.`);
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const noWrite = args.includes("--no-write");
  const recommendIdx = args.indexOf("--recommend");
  const recommendN =
    recommendIdx >= 0 ? Math.max(1, Math.min(10, Number(args[recommendIdx + 1] || "5"))) : 0;

  await ensureDir(DATA_DIR);

  // 1) 티스토리에서 최신 목록 파싱
  const fetched = await fetchDrawsFromTistory();

  // 2) 기존 데이터와 병합(회차 기준)
  const existing = await readJson(DRAWS_PATH, { draws: [], updatedAt: null, source: null });
  const map = new Map();
  for (const d of existing.draws || []) map.set(d.round, d);
  for (const d of fetched) map.set(d.round, d);

  const merged = [...map.values()].sort((a, b) => b.round - a.round);

  const drawsObj = {
    updatedAt: new Date().toISOString(),
    source: { primary: TISTORY_SOURCE_URL },
    draws: merged,
  };

  const freq = buildFreq(merged);

  if (!noWrite) {
    await writeJson(DRAWS_PATH, drawsObj);
    await writeJson(FREQ_PATH, freq);
    console.log(`[OK] Updated: ${path.relative(ROOT, DRAWS_PATH)}, ${path.relative(ROOT, FREQ_PATH)}`);
    console.log(`[OK] Rounds: ${freq.rounds.min} ~ ${freq.rounds.max} (count=${freq.rounds.count})`);
  }

  if (recommendN > 0) {
    const seed = freq.rounds.max;
    const recos = generateRecommendations(freq, recommendN, seed);
    const md = toMarkdown(recos, freq);
    console.log(md);
  }
}

main().catch((e) => {
  console.error("Error:", e?.message || e);
  process.exit(1);
});
