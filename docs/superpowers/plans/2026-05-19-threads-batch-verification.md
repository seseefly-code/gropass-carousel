# 스레드 Generate-Ahead 배치 검증 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 하루 10개 스레드 포스트를 아침에 한꺼번에 Sonnet으로 생성하고 Opus 1회 배치 검증한 뒤, 슬롯 cron이 승인된 큐를 게시(없으면 폴백 단건 생성)하도록 바꿔 API 비용을 낮춘다.

**Architecture:** 워크플로우를 2개로 분리한다. 신규 `threads-batch.yml`(06:00 KST)이 `generate_batch.js`를 돌려 10개 생성·배치검증 후 `.post_queue.json`을 커밋한다. 기존 `threads-cron.yml`의 슬롯 cron은 `auto_post.js`가 큐를 먼저 보고 승인분이 있으면 바로 게시, 없으면 기존 단건 파이프라인으로 폴백한다.

**Tech Stack:** Node 22, ES modules, `@anthropic-ai/sdk` (이미 설치됨). 테스트는 Node 내장 `node:test`(추가 의존성 0)로 순수 로직만 검증. API를 호출하는 코드는 SDK mock 계층이 없으므로 `node --check`(문법) + `--dry-run`/`workflow_dispatch`(통합) 으로 검증한다 — mock 계층 신설은 범위 밖.

**전제:** 모든 작업은 워크트리 `worktree-batch-verify-spec`에서 진행한다(이미 생성됨). 모든 git 커밋 메시지 끝에 `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>` 줄을 붙인다.

**참고 스펙:** `docs/superpowers/specs/2026-05-19-threads-batch-verification-design.md`

---

## Task 1: 큐 모듈 (`lib/post_queue.js`) + 단위 테스트

`.post_queue.json`을 읽고, 슬롯별 승인 포스트를 꺼내는 순수 로직. 이 플랜에서 유일하게 진짜 단위 테스트가 가능한 부분이다.

**Files:**
- Create: `lib/post_queue.js`
- Create: `test/post_queue.test.js`
- Modify: `package.json` (test 스크립트 추가)

- [ ] **Step 1: 실패하는 테스트 작성**

`test/post_queue.test.js` 생성:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectFromQueue } from '../lib/post_queue.js';

const queue = {
  date: '2026-05-20',
  slots: {
    morning: {
      status: 'approved',
      topic: '벤처인증 보증한도',
      post: { post_type: '오해풀기', main_post: '본문', char_count: 120, reasoning: 'r' },
      verdict: { overall: { score: 9, decision: 'pass' } },
    },
    noon: { status: 'rejected', topic: 't', reason: 'fail' },
  },
};

test('approved 슬롯은 entry 전체를 반환', () => {
  const r = selectFromQueue(queue, 'morning', '2026-05-20');
  assert.equal(r.post.main_post, '본문');
  assert.equal(r.topic, '벤처인증 보증한도');
});

test('rejected 슬롯은 null', () => {
  assert.equal(selectFromQueue(queue, 'noon', '2026-05-20'), null);
});

test('큐에 없는 슬롯은 null', () => {
  assert.equal(selectFromQueue(queue, 'night', '2026-05-20'), null);
});

test('큐 날짜가 today와 다르면 null (오래된 큐 게시 방지)', () => {
  assert.equal(selectFromQueue(queue, 'morning', '2026-05-21'), null);
});

test('큐 데이터가 null이면 null', () => {
  assert.equal(selectFromQueue(null, 'morning', '2026-05-20'), null);
});

test('post 필드가 없는 approved 항목은 null', () => {
  const bad = { date: '2026-05-20', slots: { morning: { status: 'approved', topic: 't' } } };
  assert.equal(selectFromQueue(bad, 'morning', '2026-05-20'), null);
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

먼저 `package.json`의 `scripts`에 test 스크립트를 추가한다. 현재:

```json
  "scripts": {
    "render": "node render.js"
  },
```

다음으로 교체:

```json
  "scripts": {
    "render": "node render.js",
    "test": "node --test test/"
  },
```

Run: `npm test`
Expected: FAIL — `Cannot find module '.../lib/post_queue.js'`

- [ ] **Step 3: `lib/post_queue.js` 구현**

`lib/post_queue.js` 생성:

```js
// lib/post_queue.js — 아침 배치가 만든 하루치 게시 큐 읽기/쓰기
//
// .post_queue.json 구조:
//   {
//     "date": "YYYY-MM-DD",
//     "generated_at": "ISO8601",
//     "slots": {
//       "<slot>": { "status": "approved", "topic": "...", "post": {...}, "verdict": {...} }
//              또는 { "status": "rejected", "topic": "...", "reason": "fail|review|no_verdict" }
//     }
//   }

import { promises as fs } from 'fs';

/**
 * 큐에서 해당 슬롯의 승인된 항목을 꺼낸다.
 * 큐 날짜가 today와 다르거나, 슬롯이 없거나, status가 approved가 아니거나,
 * post 필드가 없으면 null을 반환한다 (호출자는 폴백).
 * @param {object|null} queueData - readQueue() 결과
 * @param {string} slot
 * @param {string} today - "YYYY-MM-DD"
 * @returns {{status:string, topic:string, post:object, verdict:object}|null}
 */
export function selectFromQueue(queueData, slot, today) {
  if (!queueData || queueData.date !== today) return null;
  const entry = queueData.slots ? queueData.slots[slot] : null;
  if (!entry || entry.status !== 'approved' || !entry.post) return null;
  return entry;
}

/**
 * .post_queue.json 읽기. 파일이 없으면 null.
 * @param {string} filePath
 * @returns {Promise<object|null>}
 */
export async function readQueue(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * .post_queue.json 쓰기 (2-space pretty).
 * @param {string} filePath
 * @param {object} queueData
 */
export async function writeQueue(filePath, queueData) {
  await fs.writeFile(filePath, JSON.stringify(queueData, null, 2), 'utf-8');
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인**

Run: `npm test`
Expected: PASS — 6 tests passing

- [ ] **Step 5: 커밋**

```bash
git add lib/post_queue.js test/post_queue.test.js package.json
git commit -m "feat: .post_queue.json 읽기/쓰기 큐 모듈 + 단위 테스트"
```

---

## Task 2: `generate_thread.js` — 생성 모델 파라미터화

생성 모델을 Opus 하드코딩에서 인자로 받도록 바꾸고 기본값을 Sonnet으로 둔다. 인자 없는 기존 호출(`auto_post.js` 폴백 경로, CLI)은 자동으로 Sonnet이 된다.

**Files:**
- Modify: `generate_thread.js`

- [ ] **Step 1: 함수 시그니처에 `model` 파라미터 추가**

`generate_thread.js`의 함수 정의(86행 부근):

```js
export async function generateThread({ topic, type: forcedType, save = true, quiet = false }) {
```

다음으로 교체:

```js
export async function generateThread({ topic, type: forcedType, save = true, quiet = false, model = 'claude-sonnet-4-6' }) {
```

JSDoc(85행 부근 `@returns` 위)에 한 줄 추가. 현재:

```js
 * @param {boolean} [opts.quiet=false] - 콘솔 출력 최소화
 * @returns {Promise<{post: object, filepath: string|null, usage: object}>}
```

다음으로 교체:

```js
 * @param {boolean} [opts.quiet=false] - 콘솔 출력 최소화
 * @param {string} [opts.model='claude-sonnet-4-6'] - 생성에 쓸 Claude 모델
 * @returns {Promise<{post: object, filepath: string|null, usage: object}>}
```

- [ ] **Step 2: 로그 문구를 모델 변수로**

116행 부근:

```js
  log('Claude opus-4-7 호출 중...');
```

다음으로 교체:

```js
  log(`Claude ${model} 호출 중...`);
```

- [ ] **Step 3: API 호출의 model을 변수로**

120행 부근, `client.messages.stream({` 안:

```js
    model: 'claude-opus-4-7',
```

다음으로 교체:

```js
    model,
```

- [ ] **Step 4: 문법 검증**

Run: `node --check generate_thread.js`
Expected: 출력 없음 (성공)

- [ ] **Step 5: 커밋**

```bash
git add generate_thread.js
git commit -m "feat: generateThread에 model 파라미터 추가 (기본 Sonnet 4.6)"
```

---

## Task 3: `verify_thread.js` — 검증 Opus 전환 + `verifyBatch()`

단건 검증을 Opus로 올리고, 10개를 한 번에 검증하는 `verifyBatch()`와 배치 알림 메시지 빌더를 추가한다.

**Files:**
- Modify: `verify_thread.js`

- [ ] **Step 1: 헤더 주석의 모델 설명 수정**

20행:

```js
// 생성=Opus 4.7, 검증=Sonnet 4.6 (다른 모델로 같은 실수 반복 방지)
```

다음으로 교체:

```js
// 생성=Sonnet 4.6, 검증=Opus 4.7 (다른 모델로 같은 실수 반복 방지)
```

- [ ] **Step 2: 단건 검증 모델을 Opus로**

277행 부근, `verifyThread()` 안의 `client.messages.create({`:

```js
    model: 'claude-sonnet-4-6',
```

다음으로 교체:

```js
    model: 'claude-opus-4-7',
```

- [ ] **Step 3: 시스템 프롬프트의 생성 모델 언급 일반화**

107행:

```js
생성 에이전트(Opus)가 만든 포스트를 게시 전에 검증합니다. 잘못된 정보가 올라가면 도메인 전문가에게 신뢰를 잃고, AI 감지로 계정이 BAN됩니다. 실제 BAN 경험이 한 번 있었습니다.
```

다음으로 교체:

```js
생성 에이전트가 만든 포스트를 게시 전에 검증합니다. 잘못된 정보가 올라가면 도메인 전문가에게 신뢰를 잃고, AI 감지로 계정이 BAN됩니다. 실제 BAN 경험이 한 번 있었습니다.
```

- [ ] **Step 4: 배치 검증 스키마 추가**

`VERIFY_SCHEMA` 객체 정의가 끝나는 줄(103행, `};`) 바로 다음에 새 줄로 삽입:

```js

// 배치 검증 스키마 — VERIFY_SCHEMA의 5개 차원을 그대로 재사용하고 slot 식별자를 더한 배열
const BATCH_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      description: '입력된 포스트 각각의 검증 결과 (입력 순서·개수와 동일)',
      items: {
        type: 'object',
        properties: {
          slot: { type: 'string', description: '검증 대상 포스트의 slot 식별자 (입력값 그대로)' },
          ...VERIFY_SCHEMA.properties,
        },
        required: ['slot', ...VERIFY_SCHEMA.required],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};
```

- [ ] **Step 5: `verifyBatch()` 함수 추가**

`verifyThread()` 함수가 끝나는 줄(297행, `}`) 다음, `summarizeVerdict` 정의 앞에 새 줄로 삽입:

```js

/**
 * 여러 포스트를 한 번의 Opus 호출로 배치 검증한다.
 * 호출자가 recentThreads를 명시적으로 전달한다 (생성 직후의 자기 자신을 중복비교에서 빼기 위함 —
 * 생성 전에 로드한 목록을 넘긴다).
 * @param {object} opts
 * @param {Array<{slot:string, post_type:string, main_post:string, reasoning:string, char_count:number}>} opts.posts
 * @param {string} opts.announcementsCtx - getAnnouncementsContext() 반환값
 * @param {Array<{file:string,type:string,topic:string,body:string}>} opts.recentThreads
 * @returns {Promise<{results:Array<object>, usage:object}>}
 */
export async function verifyBatch({ posts, announcementsCtx, recentThreads }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('환경변수 ANTHROPIC_API_KEY가 설정되지 않았습니다.');
  }

  const threads = (recentThreads ?? []).slice(-RECENT_THREADS_N);
  const recentBlock = threads.length === 0
    ? '_(이전 게시 없음)_'
    : threads.map((p, i) => [
        `### [${i}] ${p.file} (${p.type})`,
        `topic: ${p.topic}`,
        `body:`,
        p.body,
      ].join('\n')).join('\n\n');

  const postsBlock = posts.map((p, i) => [
    `### 포스트 ${i + 1} — slot: ${p.slot}`,
    `type: ${p.post_type}`,
    `char_count: ${p.char_count}`,
    `reasoning: ${p.reasoning}`,
    '본문:',
    '"""',
    p.main_post,
    '"""',
  ].join('\n')).join('\n\n');

  const userMessage = [
    `## 검증 대상 포스트 ${posts.length}개 (하루치 배치)`,
    '',
    postsBlock,
    '',
    '## announcement 컨텍스트 (실제 살아있는 공고만)',
    announcementsCtx,
    '',
    `## 최근 ${threads.length}개 게시 본문 (의미적 중복 비교용)`,
    '',
    recentBlock,
    '',
    '각 포스트를 위 4가지 차원으로 검증하세요.',
    '추가로, **이 배치 안의 포스트들끼리도** 서로 의미적 중복인지 비교하세요 (같은 날 같은 메시지·사례 반복 금지). 중복이면 duplication_check 점수를 차감하세요.',
    'results 배열에 입력 순서·개수 그대로, 각 항목의 slot을 입력값과 동일하게 채워 반환하세요.',
  ].join('\n');

  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 8000,
    output_config: {
      format: { type: 'json_schema', schema: BATCH_RESULT_SCHEMA },
    },
    system: [
      {
        type: 'text',
        text: VERIFY_SYSTEM,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userMessage }],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('배치 검증 에이전트가 텍스트를 반환하지 않았습니다');

  const parsed = JSON.parse(textBlock.text);
  return { results: parsed.results, usage: response.usage };
}
```

- [ ] **Step 6: 배치 알림 메시지 빌더 추가**

`buildAlertMessage()` 함수가 끝나는 줄(318행, `}`) 다음에 새 줄로 삽입:

```js

/**
 * 배치 검증에서 제외된 슬롯들을 카카오 메모 1건으로 요약한다 (200자 컷).
 * @param {Array<{slot:string, topic:string, reason:string}>} rejected
 * @param {number} approvedCount
 * @returns {string}
 */
export function buildBatchAlertMessage(rejected, approvedCount) {
  const head = `[배치검증] 승인 ${approvedCount} / 제외 ${rejected.length}`;
  const lines = rejected.slice(0, 6).map(
    r => `· ${r.slot}(${r.reason}): ${String(r.topic).slice(0, 24)}`
  );
  return `${head}\n제외 슬롯은 게시 시각에 폴백 재생성됨\n${lines.join('\n')}`.slice(0, 200);
}
```

- [ ] **Step 7: 문법 검증**

Run: `node --check verify_thread.js`
Expected: 출력 없음 (성공)

- [ ] **Step 8: 커밋**

```bash
git add verify_thread.js
git commit -m "feat: verifyBatch 배치 검증 + 단건 검증 Opus 전환"
```

---

## Task 4: `auto_post.js` — CLI 가드 + export + 큐 우선 게시

`auto_post.js`가 다른 파일에서 import돼도 `main()`이 실행되지 않도록 가드를 씌우고, `generate_batch.js`가 재사용할 함수들을 export한다. 슬롯 실행 시 큐를 먼저 보고, 승인분이 있으면 바로 게시한다.

**Files:**
- Modify: `auto_post.js`

- [ ] **Step 1: 큐 모듈 import 추가**

25행:

```js
import { verifyThread, summarizeVerdict, buildAlertMessage } from './verify_thread.js';
```

다음으로 교체 (다음 줄을 추가):

```js
import { verifyThread, summarizeVerdict, buildAlertMessage } from './verify_thread.js';
import { readQueue, selectFromQueue } from './lib/post_queue.js';
```

- [ ] **Step 2: QUEUE_FILE 상수 + todayStr 헬퍼 추가**

31행:

```js
const POOL_FILE = path.join(__dirname, 'topic_pool.json');
```

다음으로 교체:

```js
const POOL_FILE = path.join(__dirname, 'topic_pool.json');
const QUEUE_FILE = path.join(__dirname, '.post_queue.json');

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
```

- [ ] **Step 3: 재사용 대상 함수·상수에 `export` 부여**

`generate_batch.js`가 import할 수 있도록 다음 5곳에 `export`를 붙인다.

35행 `const SLOTS = [` → `export const SLOTS = [`

57행 `async function loadWeights() {` → `export async function loadWeights() {`

86행 `async function loadState() {` → `export async function loadState() {`

101행 `async function saveState(state) {` → `export async function saveState(state) {`

110행 `async function notifyKakao(text) {` → `export async function notifyKakao(text) {`

165행 `async function pickPost(slot, state, pool, weights) {` → `export async function pickPost(slot, state, pool, weights) {`

`POOL_FILE`도 export한다. Step 2에서 교체한 블록의 첫 줄:

```js
const POOL_FILE = path.join(__dirname, 'topic_pool.json');
```

을

```js
export const POOL_FILE = path.join(__dirname, 'topic_pool.json');
```

으로 바꾼다.

- [ ] **Step 4: `main()` 안에 큐 우선 게시 분기 삽입**

287행:

```js
  const state = await loadState();
  const pool = JSON.parse(await fs.readFile(POOL_FILE, 'utf-8'));
```

다음으로 교체:

```js
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
```

- [ ] **Step 5: 폴백 검증 로그 문구 수정**

309행:

```js
  console.log('🔍 검증 에이전트 실행 중 (Sonnet 4.6)...');
```

다음으로 교체:

```js
  console.log('🔍 검증 에이전트 실행 중 (Opus 4.7)...');
```

- [ ] **Step 6: `main()` 호출을 CLI 진입점 가드로 감싸기**

파일 맨 끝(385~389행):

```js
main().catch(err => {
  console.error('\n[auto_post] 에러:', err.message);
  if (err.body) console.error('응답:', err.body);
  process.exit(1);
});
```

다음으로 교체 (`generate_thread.js` 188행과 동일한 가드 패턴):

```js
// CLI 진입점 (직접 실행될 때만 — generate_batch.js가 import해도 main()이 돌지 않도록)
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('auto_post.js')) {
  main().catch(err => {
    console.error('\n[auto_post] 에러:', err.message);
    if (err.body) console.error('응답:', err.body);
    process.exit(1);
  });
}
```

- [ ] **Step 7: 문법 검증 + import 부작용 없음 확인**

Run: `node --check auto_post.js`
Expected: 출력 없음 (성공)

Run: `node -e "import('./auto_post.js').then(m => console.log('exports:', Object.keys(m).sort().join(',')))"`
Expected: `exports: POOL_FILE,SLOTS,loadState,loadWeights,notifyKakao,pickPost,saveState` 가 출력되고, `[auto_post] slot=...` 배너가 **출력되지 않음** (가드가 main을 막음)

- [ ] **Step 8: 커밋**

```bash
git add auto_post.js
git commit -m "feat: auto_post 큐 우선 게시 + import용 export/CLI 가드"
```

---

## Task 5: `generate_batch.js` — 아침 배치 오케스트레이션

10개 슬롯을 순회하며 주제 선정 → Sonnet 생성 → Opus 배치 검증 → `.post_queue.json` 작성. Task 1~4의 산출물에 의존한다.

**Files:**
- Create: `generate_batch.js`

- [ ] **Step 1: `generate_batch.js` 작성**

```js
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = path.join(__dirname, '.post_queue.json');
const THREADS_DIR = path.join(__dirname, 'threads');
const GEN_MODEL = 'claude-sonnet-4-6';

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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

  const queueData = { date: todayStr(), generated_at: new Date().toISOString(), slots };

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
```

- [ ] **Step 2: 문법 검증**

Run: `node --check generate_batch.js`
Expected: 출력 없음 (성공)

- [ ] **Step 3: import 그래프가 깨지지 않는지 확인**

Run: `node -e "import('./generate_batch.js').catch(e => { console.error('IMPORT FAIL:', e.message); process.exit(1); })"`

Expected: 배치가 즉시 실행되므로 `[generate_batch]` 배너가 출력된 뒤 API 호출 단계에서 멈춘다. `ANTHROPIC_API_KEY` 미설정이면 `환경변수 ANTHROPIC_API_KEY가...` 에러로 종료될 수 있다 — **그것은 정상**(import 자체는 성공했다는 뜻). `IMPORT FAIL:` 또는 `SyntaxError`, `does not provide an export named ...` 가 나오면 실패 — Task 1~4의 export 누락을 점검한다.

- [ ] **Step 4: 통합 동작 검증 (크레딧 필요)**

> ANTHROPIC_API_KEY에 잔액이 있을 때만 실행. 잔액이 없으면 이 스텝은 Task 7의 `workflow_dispatch` 검증으로 미루고 건너뛴다.

Run: `node generate_batch.js --dry-run`
Expected: 10개 슬롯 `[slot] type=... topic=...` 로그 → `🔍 배치 검증` → `승인 N / 제외 M` → `--dry-run — 큐 파일·state 쓰지 않음`. 종료 코드 0. 작업 디렉터리에 `.post_queue.json`이 생기지 않아야 한다(`git status --short` 로 확인).

- [ ] **Step 5: 커밋**

```bash
git add generate_batch.js
git commit -m "feat: generate_batch 아침 배치 생성·검증 오케스트레이션"
```

---

## Task 6: `.github/workflows/threads-batch.yml` — 아침 배치 워크플로우

매일 06:00 KST에 `generate_batch.js`를 돌려 큐를 커밋한다. 첫 게시 슬롯(07:00 KST)보다 1시간 앞선다.

**Files:**
- Create: `.github/workflows/threads-batch.yml`

- [ ] **Step 1: 워크플로우 파일 작성**

```yaml
name: Threads Batch Generate

on:
  schedule:
    - cron: '0 21 * * *'   # 06:00 KST — 첫 게시 슬롯(07:00)보다 1시간 앞
  workflow_dispatch:
    inputs:
      dry_run:
        type: boolean
        description: 'dry-run (큐 파일 쓰지 않음)'
        default: false

permissions:
  contents: write

concurrency:
  group: threads-batch
  cancel-in-progress: false

jobs:
  generate:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Refresh announcements (best effort)
        continue-on-error: true
        run: node crawl.js --pages=2

      - name: Run generate_batch
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          KAKAO_REST_API_KEY: ${{ secrets.KAKAO_REST_API_KEY }}
          KAKAO_CLIENT_SECRET: ${{ secrets.KAKAO_CLIENT_SECRET }}
          KAKAO_REFRESH_TOKEN: ${{ secrets.KAKAO_REFRESH_TOKEN }}
        run: |
          DRY=""
          if [ "${{ inputs.dry_run }}" = "true" ]; then DRY="--dry-run"; fi
          node generate_batch.js $DRY

      - name: Commit queue + state
        if: ${{ inputs.dry_run != 'true' }}
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add .post_queue.json .post_state.json threads/ data/announcements/ 2>/dev/null || true
          if git diff --staged --quiet; then
            echo "No changes to commit"
          else
            git commit -m "batch: generate queue $(TZ=Asia/Seoul date +%Y-%m-%d_%H:%M)"
            git pull --rebase origin main || true
            git push
          fi
```

> `generate_batch.js`는 게시(`postBody`)를 호출하지 않으므로 Threads 토큰 복원 스텝이 필요 없다. 검증 모델이 Opus라 시간이 더 걸릴 수 있어 timeout은 15분으로 둔다(`threads-cron.yml`은 10분). `git pull --rebase`는 `threads-insights.yml`이 이미 쓰는 패턴 — 같은 시간대에 도는 다른 워크플로우와의 push 충돌을 줄인다.

- [ ] **Step 2: YAML 문법 검증**

Run: `node -e "const f=require('fs').readFileSync('.github/workflows/threads-batch.yml','utf-8'); if(!/cron: '0 21/.test(f) || !/generate_batch.js/.test(f)) { console.error('YAML 내용 점검 실패'); process.exit(1); } console.log('threads-batch.yml OK');"`
Expected: `threads-batch.yml OK`

- [ ] **Step 3: 커밋**

```bash
git add .github/workflows/threads-batch.yml
git commit -m "feat: 아침 배치 생성 워크플로우 (06:00 KST)"
```

---

## Task 7: 통합 검증 + 스펙 대조

전체가 맞물려 도는지 확인한다.

**Files:** 없음 (검증 전용)

- [ ] **Step 1: 전체 문법 검증**

Run: `node --check generate_thread.js && node --check verify_thread.js && node --check auto_post.js && node --check generate_batch.js && echo ALL_OK`
Expected: `ALL_OK`

- [ ] **Step 2: 단위 테스트 재실행**

Run: `npm test`
Expected: PASS — 6 tests passing

- [ ] **Step 3: 큐 우선 경로 스모크 테스트 (API 불필요)**

가짜 큐 파일을 만들어 `auto_post.js`가 큐 히트 시 생성·검증을 건너뛰는지 확인한다. (실제 게시 `postBody`는 토큰이 없으면 실패하지만, 그 전에 `📋 배치 큐에 승인된 포스트 있음` 로그가 떠야 한다.)

Run:
```bash
node -e "
const today=new Date();
const d=today.getFullYear()+'-'+String(today.getMonth()+1).padStart(2,'0')+'-'+String(today.getDate()).padStart(2,'0');
require('fs').writeFileSync('.post_queue.json', JSON.stringify({date:d,generated_at:new Date().toISOString(),slots:{morning:{status:'approved',topic:'스모크테스트',post:{post_type:'트렌드',main_post:'테스트 본문',char_count:6,reasoning:'r'},verdict:{overall:{decision:'pass',score:9}}}}},null,2));
"
node auto_post.js --slot=morning 2>&1 | head -8
rm -f .post_queue.json
```
Expected: 로그에 `📋 배치 큐에 승인된 포스트 있음 — 생성·검증 건너뛰고 바로 게시` 가 보인다. (이후 `postBody`가 토큰 없음으로 실패하는 것은 이 스텝의 관심사가 아니다 — 큐 분기가 탔다는 것만 확인.) 작업 후 `.post_queue.json`이 삭제됐는지 `git status --short`로 확인.

- [ ] **Step 4: 스펙 대조 자체 점검**

`docs/superpowers/specs/2026-05-19-threads-batch-verification-design.md`를 다시 읽고 각 절이 구현됐는지 대조한다:
- §4.1 아침 배치 → Task 5 `generate_batch.js` + Task 6 워크플로우 ✓
- §4.2 게시 cron 큐 우선/폴백 → Task 4 `auto_post.js` ✓
- §5 `.post_queue.json` 데이터 모델 → Task 1 `lib/post_queue.js` ✓
- §6 파일 변경표 → Task 2~6 ✓ (단, 스펙 §6에 없던 `lib/post_queue.js`를 큐 로직 분리용으로 신설 — 의도된 분해)
- §7 배치 검증 스키마 + 배치 내부 중복 → Task 3 `BATCH_RESULT_SCHEMA` + `verifyBatch` userMessage ✓
- §8 실패 처리(폴백) → Task 4 큐 미스 시 폴백 ✓

누락이 있으면 해당 Task로 돌아간다.

- [ ] **Step 5: 워크플로우 dispatch 통합 검증 (크레딧 필요, 머지 후)**

> 이 스텝은 변경분이 `main`에 머지되고 ANTHROPIC_API_KEY 잔액이 있어야 가능하다.

1. `gh workflow run threads-batch.yml -f dry_run=true` → 런 성공, 로그에 `승인 N / 제외 M` 확인.
2. dry_run 성공 시 `gh workflow run threads-batch.yml -f dry_run=false` → `.post_queue.json` 커밋 확인.
3. 다음 슬롯 cron 또는 `gh workflow run threads-cron.yml -f slot=<해당슬롯>` 실행 → 로그에 `📋 배치 큐에 승인된 포스트 있음` 확인 → 실제 게시 성공.

- [ ] **Step 6: 최종 커밋 (변경분이 있으면)**

Step 1~4에서 수정이 발생한 경우에만:

```bash
git add -A
git commit -m "fix: 배치 검증 통합 검증 반영"
```

---

## 알려진 한계 (MVP 수용)

- 한 슬롯이 폴백 재생성되면 `pickPost`가 그 타입의 풀 인덱스를 한 번 더 진행시켜 풀 주제 1개를 건너뛴다. 회전 풀이라 정확성 문제는 아니며 MVP에서 수용한다.
- 아침 배치와 슬롯 cron이 둘 다 `.post_state.json`·`threads/`를 커밋한다. 1시간 간격이라 충돌 가능성은 낮고, `git pull --rebase`로 완화한다.
- 비동기 Message Batches API(추가 50% 할인)는 06:00 배치가 07:00 첫 슬롯 전에 끝나야 하는 타이밍 제약과 충돌할 수 있어 이번 범위에서 제외 (스펙 §11).
