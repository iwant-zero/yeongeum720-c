import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const DATA_DIR = path.join(ROOT, "data");
const DRAWS_PATH = path.join(DATA_DIR, "yeongeum720_draws.json");
const FREQ_PATH = path.join(DATA_DIR, "yeongeum720_freq.json");

const DEFAULT_BASES = [
  // 가장 흔히 쓰는 회차별 결과 페이지 (HTML)
  "https://www.dhlottery.co.kr/gameResult.do?method=win720&Round=",
];

function nowIso() {
  return new Date().toISOString();
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      // 간단한 UA (차단 완화에 도움 되는 경우가 있음)
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
      "accept-language": "ko-KR,ko;q=0.9,en;q=0.7",
    },
  });

  const text = await res.text();
  return { status: res.status, text };
}

function detectBlock(html) {
  const signs = [
    "서비스 접속이 차단",
    "현재 접속하신 아이피에서는 접속이 불가능",
    "서비스 접근 대기 중",
    "접속량이 많아",
    "자동 접속됩니다",
  ];
  return signs.some((s) => html.includes(s));
}

function extractBallDigits(htmlFragment) {
  // 1) <span class="num ..."><span>3</span></span> 형태
  const a = [...htmlFragment.matchAll(/class="num[^"]*".*?>\s*<span[^>]*>\s*([0-9])\s*<\/span>/gis)].map(
    (m) => m[1]
  );
  if (a.length) return a.map((x) => Number(x));

  // 2) <span class="num ...">3</span> 형태(백업)
  const b = [...htmlFragment.matchAll(/<span[^>]*class="num[^"]*"[^>]*>\s*([0-9])\s*<\/span>/gis)].map(
    (m) => m[1]
  );
  return b.map((x) => Number(x));
}

function extractDateIso(html) {
  // "2026년 2월 13일" 같은 형태
  const m = html.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || !mo || !d) return null;
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}

function parseRoundHtml(round, html) {
  if (detectBlock(html)) {
    throw new Error(
      "동행복권 페이지가 '대기/차단' HTML을 반환했습니다. (GitHub 호스티드 러너에서 자주 발생)\n" +
        "→ self-hosted runner(집 PC)로 돌리거나, 다른 공개 데이터 소스를 추가해야 합니다."
    );
  }

  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) throw new Error(`round ${round}: <tbody>를 찾지 못했습니다.`);

  const tbody = tbodyMatch[1];
  const trs = tbody.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  if (trs.length < 2) throw new Error(`round ${round}: <tr>이 너무 적습니다.`);

  const firstRow = trs.find((tr) => /1등/.test(tr)) || trs[0];
  const bonusRow =
    trs.find((tr) => /보너스/.test(tr)) || trs[trs.length - 1];

  const firstNums = extractBallDigits(firstRow);
  if (firstNums.length < 7) {
    throw new Error(`round ${round}: 1등 숫자(조+6자리)를 파싱 실패했습니다.`);
  }

  const group = firstNums[0];
  const digits = firstNums.slice(1, 7);

  const bonusNums = extractBallDigits(bonusRow);
  const bonus = bonusNums.slice(0, 6);
  if (bonus.length < 6) {
    throw new Error(`round ${round}: 보너스 6자리를 파싱 실패했습니다.`);
  }

  const dateIso = extractDateIso(html);

  return {
    round,
    date: dateIso, // 없을 수도 있음
    first: { group, digits }, // group: 1~5, digits: [d1..d6]
    bonus: { digits: bonus }, // 각조 보너스 6자리
  };
}

function inc(obj, k) {
  obj[k] = (obj[k] ?? 0) + 1;
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

function rankKeysByCount(countObj, numeric = true) {
  const keys = Object.keys(countObj);
  keys.sort((a, b) => {
    const da = countObj[a] ?? 0;
    const db = countObj[b] ?? 0;
    if (db !== da) return db - da;
    // 동률이면 숫자 작은 순
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

  // 3등은 끝 5자리(참고용): pos2~pos6를 tail로도 집계
  const tail5Counts = {
    pos2: makeEmptyDigitCount(),
    pos3: makeEmptyDigitCount(),
    pos4: makeEmptyDigitCount(),
    pos5: makeEmptyDigitCount(),
    pos6: makeEmptyDigitCount(),
  };

  for (const d of draws) {
    const g = String(d.first.group);
    if (groupCounts[g] != null) inc(groupCounts, g);

    d.first.digits.forEach((x, i) => {
      const k = `pos${i + 1}`;
      inc(digitCounts[k], String(x));
      if (i >= 1) inc(tail5Counts[k], String(x)); // pos2~pos6
    });

    d.bonus.digits.forEach((x, i) => {
      const k = `pos${i + 1}`;
      inc(bonusDigitCounts[k], String(x));
    });
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
      kind: "html-scrape",
      bases: DEFAULT_BASES,
      hint:
        "연금복권720+ 회차별 결과 페이지(HTML)에서 1등(조+6자리)과 보너스(각조 6자리)를 파싱",
    },
  };
}

function pickIndex(tier, pos, idx, len) {
  // 무작위 없이 “회전”만: idx(사이클)로 순서를 바꿈
  if (len <= 1) return 0;

  // tier별로 사용 범위를 달리
  let span = len;
  if (tier === "top") span = Math.min(1, len);
  else if (tier === "topmix") span = Math.min(3, len); // 상위 3개
  else if (tier === "mix") span = Math.min(6, len); // 상위 6개
  else if (tier === "wide") span = len;

  // 자리(pos)가 뒤로 갈수록(끝자리) 더 상위 쪽에 머물게(3등/4등 영향 고려)
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
    `> 참고: 연금720+의 **2등은 1등과 조만 다른 동일 6자리**, **3등은 끝 5자리 일치** 조건입니다. :contentReference[oaicite:2]{index=2}`,
    `> 과거 빈도는 미래 당첨을 보장하지 않습니다.`,
  ].join("\n");
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv) {
  const args = {
    noUpdate: false,
    recommend: 0,
    format: "text", // text | md
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-update") args.noUpdate = true;
    else if (a === "--recommend") args.recommend = Number(argv[++i] ?? "0");
    else if (a === "--format") args.format = String(argv[++i] ?? "text");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  await fs.mkdir(DATA_DIR, { recursive: true });

  // draws 로드
  let draws = [];
  if (await exists(DRAWS_PATH)) {
    const s = await fs.readFile(DRAWS_PATH, "utf-8");
    draws = safeJsonParse(s, []);
  }

  // 업데이트(스크래핑)
  if (!args.noUpdate) {
    const haveMax = draws.length ? Math.max(...draws.map((d) => d.round)) : 0;
    let next = haveMax + 1;

    // 최초 실행이면 1회부터
    if (!haveMax) next = 1;

    let fetched = 0;

    // 최신까지 “가능한 만큼” 연속으로 시도하다가 실패(404/파싱실패)하면 종료
    while (true) {
      let ok = false;
      let lastErr = null;

      for (const base of DEFAULT_BASES) {
        const url = `${base}${next}`;
        try {
          const { status, text } = await fetchText(url);

          if (status === 404) {
            lastErr = new Error("404");
            ok = false;
            break;
          }

          if (status < 200 || status >= 300) {
            lastErr = new Error(`HTTP ${status}`);
            continue;
          }

          const parsed = parseRoundHtml(next, text);
          draws.push(parsed);
          ok = true;
          fetched++;
          break;
        } catch (e) {
          lastErr = e;
        }
      }

      if (!ok) {
        // 첫 회차부터 긁는 중이면(초기 세팅) 404가 나오기 전까지는 계속 가야 하는데,
        // 연금720은 1부터 시작하니 next가 너무 커졌다면 중단이 맞음.
        // 여기서는 “연속 업데이트” 목적이므로 실패하면 종료.
        if (lastErr && String(lastErr.message) !== "404") {
          // 차단/파싱실패 등은 원인을 드러내고 종료
          if (fetched === 0 && draws.length === 0) throw lastErr;
        }
        break;
      }

      next += 1;
      // 너무 빠른 연타 방지(서버 부담/차단 완화)
      await sleep(200);
    }

    // 정렬/중복 제거
    const map = new Map(draws.map((d) => [d.round, d]));
    draws = [...map.values()].sort((a, b) => a.round - b.round);

    await fs.writeFile(DRAWS_PATH, JSON.stringify(draws, null, 2), "utf-8");
  }

  // freq 생성
  const freq = buildFreq(draws);
  await fs.writeFile(FREQ_PATH, JSON.stringify(freq, null, 2), "utf-8");

  // 추천 출력(이슈용)
  if (args.recommend > 0) {
    const cycle = 0; // 이슈 댓글은 고정(비무작위)
    const rec1 = recommendFromFreq(freq, 1, cycle);
    const rec5 = recommendFromFreq(freq, 5, cycle);
    const rec10 = recommendFromFreq(freq, 10, cycle);

    if (args.format === "md") {
      console.log(formatMd(freq, rec1, rec5, rec10));
    } else {
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
