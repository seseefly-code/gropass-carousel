// analyze_performance.js — 수집된 insights → 카테고리/슬롯/시간대별 성과 분석
//
// 사용법:
//   node analyze_performance.js [--days=14] [--slack]
//
// 흐름:
//   1. data/insights/latest.json 로드
//   2. 카테고리별, 슬롯별, 일자별 평균 engagement 계산
//   3. TOP 5 / BOTTOM 5 게시물
//   4. 보고서 출력 + (옵션) Slack 발송 + data/reports/<date>.md 저장
//
// 환경변수:
//   SLACK_WEBHOOK_URL — 옵션. --slack 플래그 시 webhook으로 보고

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSIGHTS_LATEST = path.join(__dirname, 'data', 'insights', 'latest.json');
const REPORTS_DIR = path.join(__dirname, 'data', 'reports');

function parseArgs() {
  const args = { days: 14, slack: false };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--days=')) args.days = parseInt(a.slice('--days='.length), 10);
    else if (a === '--slack') args.slack = true;
  }
  return args;
}

function fmt(n) {
  return typeof n === 'number' ? n.toLocaleString() : '-';
}

function avg(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function score(t) {
  // engagement weight: views(1) + likes(3) + replies(8) + reposts(15) + quotes(20)
  const i = t.insights || {};
  return (
    (i.views || 0) * 1 +
    (i.likes || 0) * 3 +
    (i.replies || 0) * 8 +
    (i.reposts || 0) * 15 +
    (i.quotes || 0) * 20
  );
}

function groupBy(arr, keyFn) {
  const out = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(item);
  }
  return out;
}

function summarizeGroup(items) {
  const valid = items.filter((t) => typeof t.insights?.views === 'number');
  if (valid.length === 0) {
    return { count: items.length, valid: 0, avgViews: 0, avgLikes: 0, avgReplies: 0, avgScore: 0 };
  }
  return {
    count: items.length,
    valid: valid.length,
    avgViews: Math.round(avg(valid.map((t) => t.insights.views || 0))),
    avgLikes: avg(valid.map((t) => t.insights.likes || 0)).toFixed(1),
    avgReplies: avg(valid.map((t) => t.insights.replies || 0)).toFixed(1),
    avgScore: Math.round(avg(valid.map(score))),
  };
}

function buildReport(threads, days) {
  const since = new Date(Date.now() - days * 86400 * 1000);
  const recent = threads.filter((t) => new Date(t.timestamp) >= since);

  const lines = [];
  lines.push(`# Threads 성과 분석 — 최근 ${days}일`);
  lines.push('');
  lines.push(`기간: ${since.toISOString().slice(0, 10)} ~ ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`전체 게시물: ${recent.length}건`);
  lines.push('');

  // 카테고리별
  lines.push('## 카테고리별 평균 성과');
  lines.push('');
  lines.push('| 카테고리 | 건수 | 평균 조회 | 평균 좋아요 | 평균 답글 | 종합 점수 |');
  lines.push('|---|---|---|---|---|---|');
  const byType = [...groupBy(recent, (t) => t.meta?.type || 'unknown')]
    .map(([k, v]) => ({ key: k, ...summarizeGroup(v) }))
    .sort((a, b) => b.avgScore - a.avgScore);
  for (const r of byType) {
    lines.push(`| ${r.key} | ${r.count} | ${fmt(r.avgViews)} | ${r.avgLikes} | ${r.avgReplies} | ${fmt(r.avgScore)} |`);
  }
  lines.push('');

  // 슬롯별 (시간대)
  lines.push('## 슬롯별 평균 성과');
  lines.push('');
  lines.push('| 슬롯 | 건수 | 평균 조회 | 평균 좋아요 | 종합 점수 |');
  lines.push('|---|---|---|---|---|');
  const bySlot = [...groupBy(recent, (t) => t.meta?.slot || 'unknown')]
    .map(([k, v]) => ({ key: k, ...summarizeGroup(v) }))
    .sort((a, b) => b.avgScore - a.avgScore);
  for (const r of bySlot) {
    lines.push(`| ${r.key} | ${r.count} | ${fmt(r.avgViews)} | ${r.avgLikes} | ${fmt(r.avgScore)} |`);
  }
  lines.push('');

  // TOP 5
  lines.push('## TOP 5 게시물 (종합 점수)');
  lines.push('');
  const sorted = [...recent].sort((a, b) => score(b) - score(a));
  for (const t of sorted.slice(0, 5)) {
    const i = t.insights || {};
    const head = (t.text || '').split('\n')[0].slice(0, 60);
    lines.push(`- **${t.meta?.type || 'unknown'}/${t.meta?.slot || '-'}** · ${head}…`);
    lines.push(`  views ${fmt(i.views)} / likes ${fmt(i.likes)} / replies ${fmt(i.replies)} / reposts ${fmt(i.reposts)}`);
    lines.push(`  ${t.permalink || ''}`);
  }
  lines.push('');

  // BOTTOM 5
  lines.push('## BOTTOM 5 게시물 (개선 후보)');
  lines.push('');
  const validSorted = recent
    .filter((t) => typeof t.insights?.views === 'number')
    .sort((a, b) => score(a) - score(b));
  for (const t of validSorted.slice(0, 5)) {
    const i = t.insights || {};
    const head = (t.text || '').split('\n')[0].slice(0, 60);
    lines.push(`- **${t.meta?.type || 'unknown'}/${t.meta?.slot || '-'}** · ${head}…`);
    lines.push(`  views ${fmt(i.views)} / likes ${fmt(i.likes)}`);
  }
  lines.push('');

  // 가중치 권장
  lines.push('## 다음 주 가중치 추천');
  lines.push('');
  const top = byType[0];
  const bottom = byType[byType.length - 1];
  if (top && bottom && top.key !== bottom.key) {
    lines.push(`- 잘 되는 카테고리: **${top.key}** (점수 ${top.avgScore}) → 빈도 ↑`);
    lines.push(`- 부진한 카테고리: **${bottom.key}** (점수 ${bottom.avgScore}) → 빈도 ↓ 또는 카피 리뉴얼`);
  } else {
    lines.push('- 데이터 부족 — 1~2주 더 누적 후 재평가 권장');
  }
  lines.push('');

  return { md: lines.join('\n'), byType, bySlot };
}

async function postSlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    console.log('  (SLACK_WEBHOOK_URL 미설정 — Slack 발송 skip)');
    return;
  }
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) {
    console.warn('  Slack 발송 실패:', r.status);
  } else {
    console.log('  ✅ Slack 발송 완료');
  }
}

async function main() {
  const { days, slack } = parseArgs();

  let raw;
  try {
    raw = await fs.readFile(INSIGHTS_LATEST, 'utf-8');
  } catch (e) {
    console.error(`❌ ${INSIGHTS_LATEST} 없음 — node collect_insights.js 먼저 실행`);
    process.exit(1);
  }
  const data = JSON.parse(raw);

  const { md, byType } = buildReport(data.threads || [], days);

  console.log(md);

  // 저장
  await fs.mkdir(REPORTS_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(REPORTS_DIR, `${today}.md`);
  await fs.writeFile(reportPath, md, 'utf-8');
  console.log(`\n저장: ${reportPath}`);

  // 가중치 추천 데이터 저장 (auto_post.js가 읽음)
  const weightsPath = path.join(REPORTS_DIR, 'weights.json');
  const weights = {};
  // 점수를 정규화: max=1.0, min=0.3 (최소 가중치 보장)
  if (byType.length > 0) {
    const max = Math.max(...byType.map((b) => b.avgScore));
    const min = Math.min(...byType.map((b) => b.avgScore));
    const range = max - min || 1;
    for (const b of byType) {
      const norm = (b.avgScore - min) / range;
      // 0.3 ~ 1.0 매핑
      weights[b.key] = Math.round((0.3 + 0.7 * norm) * 100) / 100;
    }
  }
  await fs.writeFile(
    weightsPath,
    JSON.stringify(
      { computed_at: new Date().toISOString(), days, weights },
      null,
      2
    ),
    'utf-8'
  );
  console.log(`가중치: ${weightsPath}`);

  if (slack) {
    // Slack용 짧은 버전 (TOP 3 카테고리 + BOTTOM 1)
    const lines = [];
    lines.push(`*Threads 주간 성과 (최근 ${days}일, ${data.threads?.length || 0}건)*`);
    lines.push('');
    lines.push('*카테고리별 점수 TOP 3*');
    for (const b of byType.slice(0, 3)) {
      lines.push(`  • ${b.key}: 평균 조회 ${fmt(b.avgViews)} (점수 ${fmt(b.avgScore)})`);
    }
    if (byType.length > 3) {
      const last = byType[byType.length - 1];
      lines.push(`*개선 후보*: ${last.key} (점수 ${fmt(last.avgScore)})`);
    }
    lines.push('');
    lines.push(`상세: \`data/reports/${today}.md\``);
    await postSlack(lines.join('\n'));
  }
}

main().catch((e) => {
  console.error('\n❌ 분석 실패:', e.message);
  process.exit(1);
});
