// verify_thread.js — 생성된 Threads 포스트 검증 에이전트
//
// 사용처:
//   auto_post.js → 생성 직후, 게시 직전에 호출
//
// 검증 차원 (실제 BAN/오해 사례 기반):
//   1. fact_check          — 종료된 사업·공고를 살아있다고 게시하지 않는가
//                            (예: "청년창업 패키지 곧 마감" → 종료된 사업, FAIL)
//   2. hallucination_check — 검증 안 된 구체 수치·비용·조건
//                            (예: "벤처인증 심사비 100만원" → 오해 유발, FAIL)
//   3. duplication_check   — 최근 게시물과 의미적 중복
//                            (예: "벤처인증 보증한도 2배"가 5/8, 5/13 둘 다)
//   4. tone_check          — 시스템 프롬프트 규칙 위반 (해시태그/존댓말/AI 클리셰)
//
// 결정 (overall.decision):
//   pass   — 9~10점, 즉시 게시
//   review — 6~8점, 카카오 알림 + 검토 후 수동 결정 (자동 게시 X)
//   fail   — 0~5점, 폐기 + 카카오 알림
//
// 생성=Sonnet 4.6, 검증=Opus 4.7 (다른 모델로 같은 실수 반복 방지)

import Anthropic from '@anthropic-ai/sdk';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THREADS_DIR = path.join(__dirname, 'threads');
const RECENT_THREADS_N = 15;

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    fact_check: {
      type: 'object',
      properties: {
        score: { type: 'integer', description: '0~10 정수 점수 (10=완벽, 0=심각)' },
        cited_programs: {
          type: 'array',
          items: { type: 'string' },
          description: '본문에서 언급된 정부 사업/공고/자금 이름 (있는 경우만)',
        },
        unverified_programs: {
          type: 'array',
          items: { type: 'string' },
          description: 'announcement 컨텍스트에 없고 상식 화이트리스트에도 없는 사업명',
        },
        issues: { type: 'array', items: { type: 'string' } },
      },
      required: ['score', 'cited_programs', 'unverified_programs', 'issues'],
      additionalProperties: false,
    },
    hallucination_check: {
      type: 'object',
      properties: {
        score: { type: 'integer', description: '0~10 정수 점수 (10=완벽, 0=심각)' },
        risky_claims: {
          type: 'array',
          items: { type: 'string' },
          description: '검증 안 된 구체 수치/비용/조건 (예: "벤처인증 심사비 100만원")',
        },
        issues: { type: 'array', items: { type: 'string' } },
      },
      required: ['score', 'risky_claims', 'issues'],
      additionalProperties: false,
    },
    duplication_check: {
      type: 'object',
      properties: {
        score: { type: 'integer', description: '0~10 정수 점수 (10=완벽, 0=심각)' },
        similar_recent_files: {
          type: 'array',
          items: { type: 'string' },
          description: '의미적으로 중복되는 최근 thread 파일명 (있으면)',
        },
        issues: { type: 'array', items: { type: 'string' } },
      },
      required: ['score', 'similar_recent_files', 'issues'],
      additionalProperties: false,
    },
    tone_check: {
      type: 'object',
      properties: {
        score: { type: 'integer', description: '0~10 정수 점수 (10=완벽, 0=심각)' },
        issues: { type: 'array', items: { type: 'string' } },
      },
      required: ['score', 'issues'],
      additionalProperties: false,
    },
    overall: {
      type: 'object',
      properties: {
        score: { type: 'integer', description: '0~10 정수 점수 (10=완벽, 0=심각)' },
        decision: { type: 'string', enum: ['pass', 'review', 'fail'] },
        reasoning: { type: 'string' },
      },
      required: ['score', 'decision', 'reasoning'],
      additionalProperties: false,
    },
  },
  required: ['fact_check', 'hallucination_check', 'duplication_check', 'tone_check', 'overall'],
  additionalProperties: false,
};

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

const VERIFY_SYSTEM = `당신은 그로패스(gropass.co.kr) Threads 자동 게시 시스템의 **검증 에이전트**입니다.

생성 에이전트가 만든 포스트를 게시 전에 검증합니다. 잘못된 정보가 올라가면 도메인 전문가에게 신뢰를 잃고, AI 감지로 계정이 BAN됩니다. 실제 BAN 경험이 한 번 있었습니다.

# 4가지 검증 차원

## 1. fact_check — 공고/사업 사실 검증 (★★★ 최우선)

본문에서 언급된 **구체 사업명·공고명·자금명**을 모두 cited_programs에 추출하세요.
각각이 다음 둘 중 하나에 해당하는지 확인:

(a) 제공된 **announcement 컨텍스트(실제 살아있는 공고 목록)** 안에 있다
(b) 상시 운영되는 **알려진 사업 화이트리스트** 안에 있다
    - TIPS, 청년창업사관학교, 벤처기업확인제도, 메인비즈, 이노비즈, 수출바우처,
      K-스타트업, 창업진흥원 일반 사업, 중기부 R&D 일반, 정책금융기관 보증
    - "정책자금"·"R&D 자금" 같은 일반 명칭은 OK

어느 쪽에도 없으면 unverified_programs에 추가하고 점수 차감하세요.

**실제 BAN 트리거 사례 (반드시 잡아야 함)**:
- ❌ "청년창업 패키지 곧 마감" — 종료된 사업, announcement에 없음 → FAIL (0~3점)
- ❌ "○○○지원사업 5월 15일 마감" — 가공된 사업명 → FAIL
- ❌ 마감일·금액·자격 조건을 구체 숫자로 박았는데 announcement와 다름 → FAIL

**PASS** (8~10점):
- 구체 사업명 없이 일반 명칭만 사용
- announcement에 있는 공고만 호명
- 화이트리스트 사업만 호명 (조건 디테일은 일반화)

## 2. hallucination_check — 검증 안 된 구체 수치 (★★★)

본문의 **모든 구체 수치·비용·조건·기간**을 risky_claims에 나열하세요.
다음 종류는 자동으로 위험:

- 구체 비용·심사비·수수료 (예: "벤처인증 심사비 100만원")
- 구체 선정률·경쟁률 끝자리 ("선발 297개사 중 280개 떨어짐")
- 구체 예산 끝자리 ("올해 35.7조") — 시스템 프롬프트 모드 B 위반
- "예산 5천인데 매출 3억짜리 자금" 같이 단어 조합이 그럴듯한데 의미 불명

**실제 사례 (반드시 잡아야 함)**:
- ❌ "벤처인증 심사비 100만원 넘어" → 실제 비용은 훨씬 적음, 사장님들에게 오해 → FAIL

**PASS** (8~10점):
- 추상화 ("경쟁률 10:1 넘어", "예산 30조 넘는다는 거 알아?")
- 자기 경험 ("어제 매칭된 회사", "지난주 본 케이스") — 검증 불가지만 OK
- 잘 알려진 상수 (TIPS 최대 5억, 청창사 만 39세 이하 등)

## 3. duplication_check — 최근 게시물과 의미적 중복

아래 제공되는 **최근 ${RECENT_THREADS_N}개 게시 본문**과 비교:

- 같은 주제·같은 인사이트·같은 사례를 반복하는가
- 후킹 문장이 거의 똑같은가
- 같은 데이터/숫자를 또 인용하는가

**FAIL** (0~3점):
- 최근 5개 안에 거의 같은 메시지 (예: "벤처인증 = 보증한도 2배"가 5/8, 5/13 둘 다 → 두 번째 FAIL)
- similar_recent_files에 파일명 추가

**REVIEW** (4~6점): 비슷한 주제지만 각도 다름
**PASS** (7~10점): 주제·각도·인사이트 모두 새로움

## 4. tone_check — 시스템 프롬프트 규칙 위반

자동 위반:
- 존댓말 섞임 ("~합니다/입니다/세요/시는")
- 해시태그 사용 (#)
- "여러분" / "~하시는 분"
- 클릭베이트 ("충격", "이거 모르면 손해")
- 이모지 3개 이상
- 글자수 500자 초과
- AI 정형 도입부 ("오늘은 ~에 대해", "결론적으로", "~분들을 위해")

# 최종 결정 규칙

- **pass** (9~10) — 모든 차원 7+ , 즉시 게시
- **review** (6~8) — 한 차원이라도 4~6, 사람 검토 큐로
- **fail** (0~5) — 한 차원이라도 0~3, 폐기

**강제 fail 조건**:
- fact_check ≤ 3 → 무조건 fail
- hallucination_check ≤ 3 → 무조건 fail
- duplication_check ≤ 3 → 무조건 fail

JSON 스키마에 맞춰 반환하세요. 설명 없이 JSON만.`;

async function loadRecentThreads(n = RECENT_THREADS_N) {
  try {
    const files = (await fs.readdir(THREADS_DIR)).filter(f => f.endsWith('.md')).sort();
    const recent = files.slice(-n);
    const posts = [];
    for (const f of recent) {
      const md = await fs.readFile(path.join(THREADS_DIR, f), 'utf-8');
      const m = md.match(/^---([\s\S]+?)---\n\n([\s\S]*)$/);
      if (!m) continue;
      const fm = Object.fromEntries(
        m[1].split('\n').filter(Boolean).map(l => {
          const idx = l.indexOf(':');
          if (idx < 0) return ['', ''];
          return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
        })
      );
      posts.push({
        file: f,
        type: fm.type || '?',
        topic: fm.topic || '?',
        body: m[2].trim(),
      });
    }
    return posts;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * 생성된 포스트를 검증
 * @param {object} opts
 * @param {{post_type:string, main_post:string, reasoning:string, char_count:number}} opts.post
 * @param {string} opts.announcementsCtx - lib/announcements.js getAnnouncementsContext() 반환값
 * @param {Array<object>} [opts.recentThreads] - 미지정 시 threads/에서 자동 로드
 * @param {string} [opts.excludeFile] - 비교 대상에서 제외할 파일 경로 (방금 저장된 자기 자신)
 * @returns {Promise<{verdict:object, usage:object}>}
 */
export async function verifyThread({ post, announcementsCtx, recentThreads, excludeFile }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('환경변수 ANTHROPIC_API_KEY가 설정되지 않았습니다.');
  }

  let threads = recentThreads ?? (await loadRecentThreads(RECENT_THREADS_N + 5));
  if (excludeFile) {
    const base = path.basename(excludeFile);
    threads = threads.filter(t => t.file !== base);
  }
  threads = threads.slice(-RECENT_THREADS_N);

  const recentBlock = threads.length === 0
    ? '_(이전 게시 없음)_'
    : threads.map((p, i) => {
        return [
          `### [${i}] ${p.file} (${p.type})`,
          `topic: ${p.topic}`,
          `body:`,
          p.body,
        ].join('\n');
      }).join('\n\n');

  const userMessage = [
    '## 검증 대상 포스트',
    '',
    `type: ${post.post_type}`,
    `char_count: ${post.char_count}`,
    `reasoning: ${post.reasoning}`,
    '',
    '본문:',
    '"""',
    post.main_post,
    '"""',
    '',
    '## announcement 컨텍스트 (실제 살아있는 공고만)',
    announcementsCtx,
    '',
    `## 최근 ${threads.length}개 게시 본문 (의미적 중복 비교용)`,
    '',
    recentBlock,
    '',
    '위 4가지 차원으로 검증하고 JSON으로 반환하세요.',
  ].join('\n');

  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 2000,
    output_config: {
      format: { type: 'json_schema', schema: VERIFY_SCHEMA },
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
  if (!textBlock) throw new Error('검증 에이전트가 텍스트를 반환하지 않았습니다');

  const verdict = JSON.parse(textBlock.text);
  return { verdict, usage: response.usage };
}

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

export function summarizeVerdict(verdict) {
  const f = verdict.fact_check.score;
  const h = verdict.hallucination_check.score;
  const d = verdict.duplication_check.score;
  const t = verdict.tone_check.score;
  return `${verdict.overall.decision.toUpperCase()} (${verdict.overall.score}/10) | fact:${f} halluc:${h} dup:${d} tone:${t}`;
}

export function buildAlertMessage(verdict, post, slot) {
  const head = `[검증 ${verdict.overall.decision.toUpperCase()}] ${slot || ''} ${post.post_type} (${verdict.overall.score}/10)`;
  const issues = [
    ...verdict.fact_check.issues.map(s => `사실:${s}`),
    ...verdict.hallucination_check.issues.map(s => `수치:${s}`),
    ...verdict.duplication_check.issues.map(s => `중복:${s}`),
    ...verdict.tone_check.issues.map(s => `톤:${s}`),
  ];
  const bodyPreview = post.main_post.slice(0, 50);
  const issueStr = issues.slice(0, 3).join(' | ');
  return `${head}\n"${bodyPreview}..."\n${issueStr}`.slice(0, 200);
}

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

// CLI — 최근 생성된 thread를 즉석 검증 (테스트용)
//   node verify_thread.js              # 가장 최근 thread 파일 검증
//   node verify_thread.js <파일경로>    # 특정 파일 검증
if (process.argv[1] && process.argv[1].endsWith('verify_thread.js')) {
  const { getAnnouncementsContext } = await import('./lib/announcements.js');

  const arg = process.argv[2];
  let targetFile;
  if (arg) {
    targetFile = path.resolve(arg);
  } else {
    const files = (await fs.readdir(THREADS_DIR)).filter(f => f.endsWith('.md')).sort();
    if (files.length === 0) {
      console.error('threads/ 에 .md 파일 없음');
      process.exit(1);
    }
    targetFile = path.join(THREADS_DIR, files[files.length - 1]);
  }

  const md = await fs.readFile(targetFile, 'utf-8');
  const m = md.match(/^---([\s\S]+?)---\n\n([\s\S]*)$/);
  if (!m) {
    console.error('frontmatter 파싱 실패');
    process.exit(1);
  }
  const fm = Object.fromEntries(
    m[1].split('\n').filter(Boolean).map(l => {
      const idx = l.indexOf(':');
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    })
  );
  const body = m[2].trim();
  const post = {
    post_type: fm.type,
    main_post: body,
    char_count: parseInt(fm.char_count, 10) || body.length,
    reasoning: fm.reasoning || '',
  };

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`검증 대상: ${path.basename(targetFile)}`);
  console.log(`타입: ${post.post_type}  (${post.char_count}자)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(body);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 검증 대상 파일 자체는 history에서 제외
  const allThreads = await loadRecentThreads(RECENT_THREADS_N + 1);
  const filtered = allThreads.filter(t => t.file !== path.basename(targetFile));

  const announcementsCtx = await getAnnouncementsContext();
  const { verdict, usage } = await verifyThread({
    post,
    announcementsCtx,
    recentThreads: filtered.slice(-RECENT_THREADS_N),
  });

  console.log('');
  console.log(summarizeVerdict(verdict));
  console.log('');
  console.log(JSON.stringify(verdict, null, 2));
  console.log('');
  console.log(`토큰: 입력 ${usage.input_tokens} / 출력 ${usage.output_tokens} / 캐시read ${usage.cache_read_input_tokens || 0}`);
}
