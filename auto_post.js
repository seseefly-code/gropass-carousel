// auto_post.js — 슬롯에 맞춰 1개 포스트 자동 생성 + 즉시 게시
//
// 사용법:
//   node auto_post.js --slot=morning           아침: 마감알림 (D-1~D-7 자금 자동 픽)
//   node auto_post.js --slot=lunch             점심: 자금해설/숫자팩트 회전
//   node auto_post.js --slot=evening           저녁: 인사이트류 5개 회전
//   node auto_post.js --slot=morning --dry-run 게시 없이 생성만 (state도 안 바뀜)
//
// State (.post_state.json):
//   - lunch_index, evening_index : 회전 카운터
//   - topic_pool_indexes         : 타입별 풀 인덱스 (다음 회전 시 어디부터 픽할지)
//   - used_announcements         : 이미 사용한 pblancId 배열 (중복 게시 방지)
//   - history                    : 최근 게시 100개 (디버그용)

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadLatest, sortByDeadline } from './lib/announcements.js';
import { generateThread } from './generate_thread.js';
import { postBody } from './post_thread.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '.post_state.json');
const POOL_FILE = path.join(__dirname, 'topic_pool.json');

const LUNCH_TYPES = ['자금해설', '숫자팩트'];
const EVENING_TYPES = ['솔직인사이트', '공감페인', '오해풀기', '케이스스터디', '트렌드'];
const SLOTS = ['morning', 'lunch', 'evening'];

function parseArgs(argv) {
  const out = { slot: null, dryRun: false };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--slot=')) out.slot = a.slice(7);
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf-8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return {
      lunch_index: 0,
      evening_index: 0,
      topic_pool_indexes: {},
      used_announcements: [],
      history: [],
    };
  }
}

async function saveState(state) {
  if (state.history.length > 100) state.history = state.history.slice(-100);
  if (state.used_announcements.length > 200) state.used_announcements = state.used_announcements.slice(-200);
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
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
async function pickPost(slot, state, pool) {
  const data = await loadLatest();
  const sorted = data ? sortByDeadline(data.announcements) : [];

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

  if (slot === 'lunch') {
    const type = LUNCH_TYPES[state.lunch_index % LUNCH_TYPES.length];
    state.lunch_index = (state.lunch_index + 1) % LUNCH_TYPES.length;

    if (type === '자금해설') {
      // 신선한 공고 (D > 7) 중 안 쓴 것 픽
      const fresh = sorted.find(a =>
        a.dDay !== null && a.dDay > 7 && !state.used_announcements.includes(a.pblancId)
      );
      if (fresh) {
        state.used_announcements.push(fresh.pblancId);
        return { type, topic: `${fresh.title} 자금 해설 (${fresh.ministry || fresh.agency || ''})` };
      }
      return { type, topic: nextFromPool(pool, type, state) };
    }
    return { type, topic: nextFromPool(pool, type, state) };
  }

  if (slot === 'evening') {
    const type = EVENING_TYPES[state.evening_index % EVENING_TYPES.length];
    state.evening_index = (state.evening_index + 1) % EVENING_TYPES.length;
    return { type, topic: nextFromPool(pool, type, state) };
  }

  throw new Error(`Unknown slot: ${slot}`);
}

async function main() {
  const { slot, dryRun } = parseArgs(process.argv);
  if (!SLOTS.includes(slot)) {
    console.error('사용법: node auto_post.js --slot=<morning|lunch|evening> [--dry-run]');
    process.exit(1);
  }

  const startTime = new Date();
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`[auto_post] slot=${slot}  dryRun=${dryRun}`);
  console.log(`           ${startTime.toISOString()}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const state = await loadState();
  const pool = JSON.parse(await fs.readFile(POOL_FILE, 'utf-8'));
  const { type, topic } = await pickPost(slot, state, pool);

  console.log(`결정 : type=${type}`);
  console.log(`       topic="${topic}"`);

  // 생성
  const { post, filepath } = await generateThread({ topic, type, save: true, quiet: false });

  if (dryRun) {
    console.log('');
    console.log('--dry-run — 게시 스킵, state 저장 안함');
    return;
  }

  // 게시
  console.log('스레드 게시 중...');
  const result = await postBody({ body: post.main_post });
  console.log(`✅ 게시 완료`);
  console.log(`   media_id : ${result.mediaId}`);
  if (result.permalink) console.log(`   URL      : ${result.permalink}`);

  state.history.push({
    slot,
    type: post.post_type,
    topic,
    char_count: post.char_count,
    media_id: result.mediaId,
    permalink: result.permalink || null,
    filepath,
    posted_at: new Date().toISOString(),
  });
  await saveState(state);

  console.log('');
  console.log(`완료 (소요 ${Math.round((Date.now() - startTime) / 1000)}s)`);
}

main().catch(err => {
  console.error('\n[auto_post] 에러:', err.message);
  if (err.body) console.error('응답:', err.body);
  process.exit(1);
});
