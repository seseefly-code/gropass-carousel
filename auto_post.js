// auto_post.js — 슬롯에 맞춰 1개 포스트 자동 생성 + 즉시 게시
//
// 사용법:
//   node auto_post.js --slot=morning           08:00 KST 마감알림 (D-1~D-7 자금)
//   node auto_post.js --slot=noon              12:00 KST 숫자팩트
//   node auto_post.js --slot=afternoon         15:00 KST 자금해설 (신선 공고)
//   node auto_post.js --slot=evening           19:00 KST 솔직인사이트 ↔ 케이스스터디
//   node auto_post.js --slot=night             22:00 KST 공감페인 → 오해풀기 → 트렌드
//   node auto_post.js --slot=morning --dry-run 게시 없이 생성만 (state도 안 바뀜)
//
// State (.post_state.json):
//   - evening_index, night_index : 회전 카운터
//   - topic_pool_indexes         : 타입별 풀 인덱스 (다음 회전 시 어디부터 픽할지)
//   - used_announcements         : 이미 사용한 pblancId 배열 (중복 게시 방지)
//   - history                    : 최근 게시 100개 (디버그용)

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { loadLatest, sortByDeadline, getAnnouncementsContext } from './lib/announcements.js';
import { generateThread } from './generate_thread.js';
import { postBody } from './post_thread.js';
import { verifyThread, summarizeVerdict, buildAlertMessage } from './verify_thread.js';
import { readQueue, selectFromQueue } from './lib/post_queue.js';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '.post_state.json');
export const POOL_FILE = path.join(__dirname, 'topic_pool.json');
const QUEUE_FILE = path.join(__dirname, '.post_queue.json');

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const EVENING_TYPES = ['솔직인사이트', '케이스스터디'];
const NIGHT_TYPES = ['공감페인', '오해풀기', '트렌드'];
export const SLOTS = [
  'early_morning', // 07:00 — 긴급 마감알림 (D-1~3)
  'morning',       // 08:00 — 마감알림 (D-4~14)
  'late_morning',  // 10:00 — 솔직인사이트
  'noon',          // 12:00 — 숫자팩트
  'lunch',         // 13:00 — 공감페인
  'afternoon',     // 15:00 — 자금해설 (announcements)
  'late_afternoon',// 17:00 — 트렌드
  'evening',       // 19:00 — 솔직/케스 (가중치)
  'late_evening',  // 21:00 — 케이스스터디
  'night',         // 22:00 — 공감/오해/트렌드 (가중치)
];

function parseArgs(argv) {
  const out = { slot: null, dryRun: false };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--slot=')) out.slot = a.slice(7);
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

export async function loadWeights() {
  const f = path.join(__dirname, 'data', 'reports', 'weights.json');
  try {
    const raw = await fs.readFile(f, 'utf-8');
    const data = JSON.parse(raw);
    return data.weights || null;
  } catch (e) {
    return null;
  }
}

/**
 * 가중치 기반 type 선택. weights 없으면 null 반환 (호출자가 fallback).
 * @param {string[]} types - 후보
 * @param {Record<string,number>} weights - type → 0.3~1.0 가중치
 */
function weightedPick(types, weights) {
  if (!weights) return null;
  const list = types.map((t) => ({ t, w: weights[t] ?? 0.5 }));
  const total = list.reduce((s, x) => s + x.w, 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const x of list) {
    if (r < x.w) return x.t;
    r -= x.w;
  }
  return list[list.length - 1].t;
}

export async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf-8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return {
      evening_index: 0,
      night_index: 0,
      topic_pool_indexes: {},
      used_announcements: [],
      history: [],
    };
  }
}

export async function saveState(state) {
  if (state.history.length > 100) state.history = state.history.slice(-100);
  if (state.used_announcements.length > 200) state.used_announcements = state.used_announcements.slice(-200);
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * 검증 fail/review 시 카카오 메모로 알림 (best-effort, 실패해도 흐름 중단 X)
 */
export async function notifyKakao(text) {
  if (!process.env.KAKAO_REST_API_KEY || !process.env.KAKAO_REFRESH_TOKEN) {
    console.warn('카카오 알림 환경변수 없음 — 알림 스킵');
    return;
  }
  try {
    const script = path.join(__dirname, 'send_kakao_memo.js');
    await execFileAsync('node', [script, text], { env: process.env });
    console.log('📨 카카오 메모 발송됨');
  } catch (e) {
    console.warn('카카오 알림 실패:', e.message);
  }
}

/**
 * 검증 결과 issue들을 콘솔에 가독성 좋게 출력
 */
function logVerdictIssues(verdict) {
  const dims = [
    ['fact_check', '사실'],
    ['hallucination_check', '수치환각'],
    ['duplication_check', '중복'],
    ['tone_check', '톤'],
  ];
  for (const [key, label] of dims) {
    const v = verdict[key];
    if (v.issues.length > 0 || v.score <= 6) {
      console.log(`  [${label}] score=${v.score}`);
      v.issues.forEach((s) => console.log(`    - ${s}`));
      if (key === 'fact_check' && v.unverified_programs?.length > 0) {
        console.log(`    unverified: ${v.unverified_programs.join(', ')}`);
      }
      if (key === 'hallucination_check' && v.risky_claims?.length > 0) {
        console.log(`    risky: ${v.risky_claims.join(', ')}`);
      }
      if (key === 'duplication_check' && v.similar_recent_files?.length > 0) {
        console.log(`    similar: ${v.similar_recent_files.join(', ')}`);
      }
    }
  }
}

function nextFromPool(pool, type, state) {
  const topics = pool[type];
  if (!topics || topics.length === 0) {
    throw new Error(`topic_pool에 "${type}" 항목 없음`);
  }
  const idx = (state.topic_pool_indexes[type] || 0) % topics.length;
  state.topic_pool_indexes[type] = idx + 1;
  return topics[idx];
}

/**
 * 슬롯 → {type, topic} 결정 (state 변이됨)
 */
export async function pickPost(slot, state, pool, weights) {
  const data = await loadLatest();
  const sorted = data ? sortByDeadline(data.announcements) : [];

  // ─── 07:00 early_morning — 긴급 마감 (D-1~3 우선) ───
  if (slot === 'early_morning') {
    const urgent = sorted.filter(
      (a) =>
        a.dDay !== null &&
        a.dDay >= 0 &&
        a.dDay <= 3 &&
        !state.used_announcements.includes(a.pblancId)
    );
    if (urgent.length > 0) {
      const pick = urgent[0];
      state.used_announcements.push(pick.pblancId);
      const ddayLabel = pick.dDay === 0 ? '오늘 마감' : `D-${pick.dDay} 마감 임박`;
      return {
        type: '마감알림',
        topic: `${pick.title} ${ddayLabel} (${pick.ministry || pick.agency || ''})`,
      };
    }
    return { type: '마감알림', topic: nextFromPool(pool, '마감알림', state) };
  }

  if (slot === 'morning') {
    // 마감알림 — D-1~D-7 안 쓴 공고 픽
    const upcoming = sorted.filter(a =>
      a.dDay !== null && a.dDay >= 1 && a.dDay <= 7 &&
      !state.used_announcements.includes(a.pblancId)
    );
    if (upcoming.length > 0) {
      const pick = upcoming[0];
      state.used_announcements.push(pick.pblancId);
      return {
        type: '마감알림',
        topic: `${pick.title} D-${pick.dDay} 마감 임박 (${pick.ministry || pick.agency || ''})`,
      };
    }
    // 폴백 1: D-14 까지 확장
    const wider = sorted.filter(a =>
      a.dDay !== null && a.dDay >= 1 && a.dDay <= 14 &&
      !state.used_announcements.includes(a.pblancId)
    );
    if (wider.length > 0) {
      const pick = wider[0];
      state.used_announcements.push(pick.pblancId);
      return {
        type: '마감알림',
        topic: `${pick.title} D-${pick.dDay} 마감 (${pick.ministry || pick.agency || ''})`,
      };
    }
    // 폴백 2: 풀
    return { type: '마감알림', topic: nextFromPool(pool, '마감알림', state) };
  }

  // ─── 10:00 late_morning — 솔직인사이트 ───
  if (slot === 'late_morning') {
    return { type: '솔직인사이트', topic: nextFromPool(pool, '솔직인사이트', state) };
  }

  if (slot === 'noon') {
    return { type: '숫자팩트', topic: nextFromPool(pool, '숫자팩트', state) };
  }

  // ─── 13:00 lunch — 공감페인 ───
  if (slot === 'lunch') {
    return { type: '공감페인', topic: nextFromPool(pool, '공감페인', state) };
  }

  if (slot === 'afternoon') {
    const fresh = sorted.find(a =>
      a.dDay !== null && a.dDay > 7 && !state.used_announcements.includes(a.pblancId)
    );
    if (fresh) {
      state.used_announcements.push(fresh.pblancId);
      return { type: '자금해설', topic: `${fresh.title} 자금 해설 (${fresh.ministry || fresh.agency || ''})` };
    }
    return { type: '자금해설', topic: nextFromPool(pool, '자금해설', state) };
  }

  // ─── 17:00 late_afternoon — 트렌드 ───
  if (slot === 'late_afternoon') {
    return { type: '트렌드', topic: nextFromPool(pool, '트렌드', state) };
  }

  if (slot === 'evening') {
    const picked = weightedPick(EVENING_TYPES, weights);
    const type = picked || EVENING_TYPES[(state.evening_index || 0) % EVENING_TYPES.length];
    state.evening_index = ((state.evening_index || 0) + 1) % EVENING_TYPES.length;
    return { type, topic: nextFromPool(pool, type, state) };
  }

  // ─── 21:00 late_evening — 케이스스터디 ───
  if (slot === 'late_evening') {
    return { type: '케이스스터디', topic: nextFromPool(pool, '케이스스터디', state) };
  }

  if (slot === 'night') {
    const picked = weightedPick(NIGHT_TYPES, weights);
    const type = picked || NIGHT_TYPES[(state.night_index || 0) % NIGHT_TYPES.length];
    state.night_index = ((state.night_index || 0) + 1) % NIGHT_TYPES.length;
    return { type, topic: nextFromPool(pool, type, state) };
  }

  throw new Error(`Unknown slot: ${slot}`);
}

async function main() {
  const { slot, dryRun } = parseArgs(process.argv);
  if (!SLOTS.includes(slot)) {
    console.error('사용법: node auto_post.js --slot=<morning|noon|afternoon|evening|night> [--dry-run]');
    process.exit(1);
  }

  const startTime = new Date();
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`[auto_post] slot=${slot}  dryRun=${dryRun}`);
  console.log(`           ${startTime.toISOString()}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const state = await loadState();

  // ─── 큐 우선 — 아침 배치가 승인한 포스트가 있으면 생성·검증 없이 바로 게시 ───
  if (!dryRun) {
    const queued = selectFromQueue(await readQueue(QUEUE_FILE), slot, todayStr());
    if (queued) {
      console.log('📋 배치 큐에 승인된 포스트 있음 — 생성·검증 건너뛰고 바로 게시');
      console.log(`타입 : ${queued.post.post_type}  (${queued.post.char_count}자)`);
      const result = await postBody({ body: queued.post.main_post });
      console.log('✅ 게시 완료');
      console.log(`   media_id : ${result.mediaId}`);
      if (result.permalink) console.log(`   URL      : ${result.permalink}`);
      state.history.push({
        slot,
        type: queued.post.post_type,
        topic: queued.topic || '',
        char_count: queued.post.char_count,
        source: 'batch_queue',
        verdict: queued.verdict
          ? { decision: queued.verdict.overall.decision, score: queued.verdict.overall.score }
          : null,
        media_id: result.mediaId,
        permalink: result.permalink || null,
        posted_at: new Date().toISOString(),
      });
      await saveState(state);
      console.log('');
      console.log(`완료 (소요 ${Math.round((Date.now() - startTime) / 1000)}s)`);
      return;
    }
    console.log('큐에 승인된 포스트 없음 — 폴백 단건 생성·검증');
  }

  const pool = JSON.parse(await fs.readFile(POOL_FILE, 'utf-8'));
  const weights = await loadWeights();
  if (weights) {
    console.log(`가중치 적용: ${Object.entries(weights).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  const { type, topic } = await pickPost(slot, state, pool, weights);

  console.log(`결정 : type=${type}`);
  console.log(`       topic="${topic}"`);

  // 생성
  const { post, filepath } = await generateThread({ topic, type, save: true, quiet: false });

  if (dryRun) {
    console.log('');
    console.log('--dry-run — 검증·게시 모두 스킵, state 저장 안함');
    return;
  }

  // ─── 검증 ───
  console.log('');
  console.log('🔍 검증 에이전트 실행 중 (Opus 4.7)...');
  const announcementsCtx = await getAnnouncementsContext();
  const { verdict, usage: verifyUsage } = await verifyThread({
    post,
    announcementsCtx,
    excludeFile: filepath, // 방금 저장한 자기 자신은 중복 비교에서 제외
  });

  console.log(`검증 : ${summarizeVerdict(verdict)}`);
  console.log(`     overall reasoning: ${verdict.overall.reasoning}`);
  if (verdict.overall.decision !== 'pass') {
    logVerdictIssues(verdict);
  }
  console.log(`     토큰: 입력 ${verifyUsage.input_tokens} / 출력 ${verifyUsage.output_tokens}`);

  // 검증 메타데이터를 history에 항상 기록
  const baseHistory = {
    slot,
    type: post.post_type,
    topic,
    char_count: post.char_count,
    filepath,
    verdict: {
      decision: verdict.overall.decision,
      score: verdict.overall.score,
      fact: verdict.fact_check.score,
      halluc: verdict.hallucination_check.score,
      dup: verdict.duplication_check.score,
      tone: verdict.tone_check.score,
      issues: [
        ...verdict.fact_check.issues,
        ...verdict.hallucination_check.issues,
        ...verdict.duplication_check.issues,
        ...verdict.tone_check.issues,
      ].slice(0, 8),
    },
    posted_at: new Date().toISOString(),
  };

  if (verdict.overall.decision === 'fail') {
    console.error('');
    console.error('❌ 검증 실패 — 게시 중단, 폐기');
    await notifyKakao(buildAlertMessage(verdict, post, slot));
    state.history.push({ ...baseHistory, discarded: true });
    await saveState(state);
    return;
  }

  if (verdict.overall.decision === 'review') {
    console.warn('');
    console.warn('⚠️  검토 필요 — 자동 게시 중단 (사람 확인 후 수동 게시)');
    await notifyKakao(buildAlertMessage(verdict, post, slot));
    state.history.push({ ...baseHistory, review_required: true });
    await saveState(state);
    return;
  }

  // ─── pass — 게시 ───
  console.log('✅ 검증 통과 — 게시 진행');
  console.log('스레드 게시 중...');
  const result = await postBody({ body: post.main_post });
  console.log(`✅ 게시 완료`);
  console.log(`   media_id : ${result.mediaId}`);
  if (result.permalink) console.log(`   URL      : ${result.permalink}`);

  state.history.push({
    ...baseHistory,
    media_id: result.mediaId,
    permalink: result.permalink || null,
  });
  await saveState(state);

  console.log('');
  console.log(`완료 (소요 ${Math.round((Date.now() - startTime) / 1000)}s)`);
}

// CLI 진입점 (직접 실행될 때만 — generate_batch.js가 import해도 main()이 돌지 않도록)
if (import.meta.url === `file://${(process.argv[1] || '').replace(/\\/g, '/')}` || (process.argv[1] || '').endsWith('auto_post.js')) {
  main().catch(err => {
    console.error('\n[auto_post] 에러:', err.message);
    if (err.body) console.error('응답:', err.body);
    process.exit(1);
  });
}
