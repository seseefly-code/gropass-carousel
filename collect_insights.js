// collect_insights.js — Threads 게시물 + insights 수집
//
// 사용법:
//   node collect_insights.js [--days=30]
//
// 흐름:
//   1. .threads-token.json에서 토큰 + user_id 로드
//   2. GET /{user-id}/threads → 최근 N일 게시물 목록
//   3. 각 게시물별 GET /{thread-id}/insights → views/likes/replies/reposts/quotes
//   4. .post_state.json의 history와 permalink 매칭 → slot/type/topic 메타 부착
//   5. data/insights/<YYYY-MM-DD>.json 저장 + data/insights/latest.json 업데이트

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '.threads-token.json');
const STATE_FILE = path.join(__dirname, '.post_state.json');
const INSIGHTS_DIR = path.join(__dirname, 'data', 'insights');

const API = 'https://graph.threads.net/v1.0';

function parseArgs() {
  const args = { days: 30 };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--days=')) args.days = parseInt(a.slice('--days='.length), 10);
  }
  return args;
}

async function loadToken() {
  const raw = await fs.readFile(TOKEN_FILE, 'utf-8');
  // BOM 방어
  const cleaned = raw.replace(/^﻿/, '');
  const data = JSON.parse(cleaned);
  return { token: data.access_token, userId: data.user_id };
}

async function loadHistory() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8');
    const state = JSON.parse(raw);
    return state.history || [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function fetchThreads(userId, token, sinceUnix) {
  const all = [];
  let url = new URL(`${API}/${userId}/threads`);
  url.searchParams.set(
    'fields',
    'id,permalink,timestamp,text,media_type,is_quote_post'
  );
  url.searchParams.set('since', String(sinceUnix));
  url.searchParams.set('limit', '100');
  url.searchParams.set('access_token', token);

  while (true) {
    const r = await fetch(url.toString());
    const data = await r.json();
    if (!r.ok || data.error) {
      throw new Error(`/threads 실패: ${JSON.stringify(data.error || data)}`);
    }
    if (Array.isArray(data.data)) all.push(...data.data);
    if (data.paging?.next) {
      url = new URL(data.paging.next);
    } else break;
  }
  return all;
}

const INSIGHT_METRICS = ['views', 'likes', 'replies', 'reposts', 'quotes'];

async function fetchInsights(threadId, token) {
  const url = new URL(`${API}/${threadId}/insights`);
  url.searchParams.set('metric', INSIGHT_METRICS.join(','));
  url.searchParams.set('access_token', token);
  const r = await fetch(url.toString());
  const data = await r.json();
  if (!r.ok) {
    // 일부 게시물은 insights 권한 부족 또는 너무 최근(< 24h)이라 빈 데이터 가능
    return { error: data.error?.message || 'insights unavailable' };
  }
  const out = {};
  for (const m of data.data || []) {
    const v = m.values?.[0]?.value;
    out[m.name] = typeof v === 'number' ? v : 0;
  }
  return out;
}

function attachMeta(thread, history) {
  // permalink 또는 thread id 매칭
  const match = history.find(
    (h) => h.media_id === thread.id || h.permalink === thread.permalink
  );
  if (match) {
    return {
      slot: match.slot,
      type: match.type,
      topic: match.topic,
      char_count: match.char_count,
    };
  }
  // 매칭 실패 — text 첫 줄로 기록만
  return {
    slot: 'unknown',
    type: 'unknown',
    topic: thread.text ? thread.text.split('\n')[0].slice(0, 80) : '',
    char_count: thread.text?.length || 0,
  };
}

async function main() {
  const { days } = parseArgs();
  const sinceUnix = Math.floor((Date.now() - days * 86400 * 1000) / 1000);

  console.log('━'.repeat(60));
  console.log('Threads Insights 수집');
  console.log('━'.repeat(60));
  console.log(`  기간    : 최근 ${days}일`);
  console.log(`  since   : ${new Date(sinceUnix * 1000).toISOString()}`);

  const { token, userId } = await loadToken();
  const history = await loadHistory();

  console.log(`  user_id : ${userId}`);
  console.log(`  history : ${history.length}건 (메타 매칭용)`);
  console.log('');

  console.log('Step 1. 게시물 목록 조회...');
  const threads = await fetchThreads(userId, token, sinceUnix);
  console.log(`  → ${threads.length}건`);
  console.log('');

  console.log('Step 2. 각 게시물 insights 수집...');
  const enriched = [];
  for (let i = 0; i < threads.length; i++) {
    const t = threads[i];
    const insights = await fetchInsights(t.id, token);
    const meta = attachMeta(t, history);
    enriched.push({
      id: t.id,
      permalink: t.permalink,
      timestamp: t.timestamp,
      text: t.text || '',
      media_type: t.media_type,
      is_quote_post: t.is_quote_post,
      insights,
      meta,
    });
    if ((i + 1) % 10 === 0 || i + 1 === threads.length) {
      process.stdout.write(`  ${i + 1}/${threads.length} `);
    }
    // rate limit 방어 (200ms gap)
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log('\n');

  // 저장
  await fs.mkdir(INSIGHTS_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const out = {
    collected_at: new Date().toISOString(),
    user_id: userId,
    days,
    count: enriched.length,
    threads: enriched,
  };
  const dailyPath = path.join(INSIGHTS_DIR, `${today}.json`);
  const latestPath = path.join(INSIGHTS_DIR, 'latest.json');
  await fs.writeFile(dailyPath, JSON.stringify(out, null, 2), 'utf-8');
  await fs.writeFile(latestPath, JSON.stringify(out, null, 2), 'utf-8');

  // 빠른 요약
  const valid = enriched.filter((e) => typeof e.insights.views === 'number');
  const totalViews = valid.reduce((s, e) => s + (e.insights.views || 0), 0);
  const totalLikes = valid.reduce((s, e) => s + (e.insights.likes || 0), 0);
  const totalReplies = valid.reduce((s, e) => s + (e.insights.replies || 0), 0);
  const matched = enriched.filter((e) => e.meta.type !== 'unknown').length;

  console.log('━'.repeat(60));
  console.log('수집 완료');
  console.log('━'.repeat(60));
  console.log(`  저장      : ${dailyPath}`);
  console.log(`            : ${latestPath}`);
  console.log(`  게시물    : ${enriched.length}건`);
  console.log(`  메타 매칭 : ${matched}건 (${enriched.length - matched}건은 history 미매칭)`);
  console.log(`  insights OK: ${valid.length}건`);
  console.log(`  합계 views : ${totalViews.toLocaleString()}`);
  console.log(`  합계 likes : ${totalLikes}`);
  console.log(`  합계 replies: ${totalReplies}`);
  console.log('');
}

main().catch((err) => {
  console.error('\n❌ 수집 실패:', err.message);
  process.exit(1);
});
