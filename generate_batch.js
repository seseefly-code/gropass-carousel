// generate_batch.js — 하루치 10개 슬롯 포스트를 한꺼번에 생성·배치검증해 .post_queue.json 작성
//
// 사용법:
//   node generate_batch.js            생성 + 배치검증 + 큐 작성 + state 저장
//   node generate_batch.js --dry-run  큐 파일·state 쓰지 않고 결과만 출력
//
// GitHub Actions: 매일 06:00 KST (.github/workflows/threads-batch.yml)
//
// 동작:
//   1. SLOTS 10개 각각 pickPost로 주제 선정 → generateThread(Sonnet)로 생성
//   2. verifyBatch(Opus)로 10개를 한 번에 검증 (배치 내부 중복도 비교)
//   3. decision=pass → status:approved, 그 외 → status:rejected (게시 슬롯에서 폴백)
//   4. .post_queue.json 작성, 제외분이 있으면 카카오 알림 1건

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAnnouncementsContext } from './lib/announcements.js';
import { generateThread } from './generate_thread.js';
import { verifyBatch, summarizeVerdict, buildBatchAlertMessage } from './verify_thread.js';
import { writeQueue } from './lib/post_queue.js';
import { SLOTS, POOL_FILE, loadState, saveState, loadWeights, pickPost, notifyKakao } from './auto_post.js';
import { kstDateStr } from './lib/kst_date.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = path.join(__dirname, '.post_queue.json');
const THREADS_DIR = path.join(__dirname, 'threads');
const GEN_MODEL = 'claude-sonnet-4-6';

// 생성 전에 호출 — 방금 만든 글이 끼기 전의 최근 게시본 목록
async function loadRecentThreads(n = 20) {
  try {
    const files = (await fs.readdir(THREADS_DIR)).filter(f => f.endsWith('.md')).sort();
    const posts = [];
    for (const f of files.slice(-n)) {
      const md = await fs.readFile(path.join(THREADS_DIR, f), 'utf-8');
      const m = md.match(/^---([\s\S]+?)---\n\n([\s\S]*)$/);
      if (!m) continue;
      const fm = Object.fromEntries(
        m[1].split('\n').filter(Boolean).map(l => {
          const idx = l.indexOf(':');
          return idx < 0 ? ['', ''] : [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
        })
      );
      posts.push({ file: f, type: fm.type || '?', topic: fm.topic || '?', body: m[2].trim() });
    }
    return posts;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function main() {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  const startTime = Date.now();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`[generate_batch] ${SLOTS.length}개 슬롯 배치 생성  dryRun=${dryRun}`);
  console.log(`           ${new Date().toISOString()}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const state = await loadState();
  const pool = JSON.parse(await fs.readFile(POOL_FILE, 'utf-8'));
  const weights = await loadWeights();
  const recentThreads = await loadRecentThreads(20);

  // ─── 1) 10개 슬롯 생성 (Sonnet) ───
  // NOTE: pickPost는 state(used_announcements, 인덱스)를 메모리에서 변이시킨다.
  // saveState는 맨 끝에서 1회만 호출되므로, verifyBatch가 도중에 throw하면
  // state가 저장되지 않아 다음 배치가 같은 공고를 다시 픽한다 (의도된 재시도 동작 — 실패 슬롯 복구).
  const generated = [];
  for (const slot of SLOTS) {
    const { type, topic } = await pickPost(slot, state, pool, weights);
    console.log(`[${slot}] type=${type}  topic="${topic}"`);
    const { post } = await generateThread({ topic, type, save: true, quiet: true, model: GEN_MODEL });
    generated.push({ slot, topic, post });
  }

  // ─── 2) 배치 검증 (Opus) ───
  console.log('');
  console.log('🔍 배치 검증 (Opus 4.7)...');
  const announcementsCtx = await getAnnouncementsContext();
  const { results, usage } = await verifyBatch({
    posts: generated.map(g => ({ slot: g.slot, ...g.post })),
    announcementsCtx,
    recentThreads,
  });
  console.log(`검증 토큰: 입력 ${usage.input_tokens} / 출력 ${usage.output_tokens} / 캐시read ${usage.cache_read_input_tokens || 0}`);

  // ─── 3) 큐 구성 ───
  const verdictBySlot = Object.fromEntries(results.map(r => [r.slot, r]));
  const slots = {};
  const rejectedList = [];
  let approved = 0;
  for (const g of generated) {
    const verdict = verdictBySlot[g.slot];
    if (verdict && verdict.overall.decision === 'pass') {
      slots[g.slot] = { status: 'approved', topic: g.topic, post: g.post, verdict };
      approved++;
      console.log(`  ✅ ${g.slot}: ${summarizeVerdict(verdict)}`);
    } else {
      const reason = verdict ? verdict.overall.decision : 'no_verdict';
      slots[g.slot] = { status: 'rejected', topic: g.topic, reason };
      rejectedList.push({ slot: g.slot, topic: g.topic, reason });
      console.log(`  ⏭️  ${g.slot}: rejected (${reason}) — 게시 시각에 폴백 재생성`);
    }
  }

  const queueData = { date: kstDateStr(), generated_at: new Date().toISOString(), slots };

  console.log('');
  console.log(`승인 ${approved} / 제외 ${rejectedList.length}  (소요 ${Math.round((Date.now() - startTime) / 1000)}s)`);

  if (dryRun) {
    console.log('--dry-run — 큐 파일·state 쓰지 않음');
    return;
  }

  await writeQueue(QUEUE_FILE, queueData);
  await saveState(state);
  console.log(`큐 저장: ${QUEUE_FILE}`);

  if (rejectedList.length > 0) {
    await notifyKakao(buildBatchAlertMessage(rejectedList, approved));
  }
}

main().catch(err => {
  console.error('\n[generate_batch] 에러:', err.message);
  if (err.body) console.error('응답:', err.body);
  process.exit(1);
});
