// generate_thread.js — 주제 한 줄 → 그로패스 스레드 포스트 (반말, 한국 스레드 톤)
//
// 사용법:
//   node generate_thread.js "TIPS 마감 임박"
//   node generate_thread.js --type=오해풀기 "벤처인증에 대한 흔한 오해"
//
// 결과:
//   threads/<날짜>_<topic_slug>.md (저장)
//   콘솔에도 본문 그대로 출력 → 복사해서 스레드 앱에 붙여넣기

import Anthropic from '@anthropic-ai/sdk';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAnnouncementsContext } from './lib/announcements.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THREADS_DIR = path.join(__dirname, 'threads');
const PROMPTS_DIR = path.join(__dirname, 'prompts');

const POST_TYPES = [
  '마감알림', '자금해설', '솔직인사이트', '공감페인',
  '숫자팩트', '케이스스터디', '오해풀기', '트렌드',
];

const THREAD_SCHEMA = {
  type: 'object',
  properties: {
    post_type: {
      type: 'string',
      enum: POST_TYPES,
      description: '주제에 가장 적합한 콘텐츠 타입 1개 선택',
    },
    main_post: {
      type: 'string',
      description: '본문. 반말, 줄바꿈 포함. 200~350자 권장.',
    },
    char_count: {
      type: 'integer',
      description: '본문 글자 수 (공백 포함)',
    },
    reasoning: {
      type: 'string',
      description: '왜 이 post_type을 선택했는지 한 줄',
    },
  },
  required: ['post_type', 'main_post', 'char_count', 'reasoning'],
  additionalProperties: false,
};

function parseArgs(argv) {
  const args = argv.slice(2);
  let type = null;
  const positional = [];
  for (const arg of args) {
    if (arg.startsWith('--type=')) {
      type = arg.slice('--type='.length);
    } else {
      positional.push(arg);
    }
  }
  return { topic: positional.join(' '), type };
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function slugify(s) {
  return s
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .replace(/\s+/g, '_')
    .slice(0, 30);
}

/**
 * 스레드 포스트 생성 (프로그래매틱 사용 가능)
 * @param {object} opts
 * @param {string} opts.topic - 주제
 * @param {string} [opts.type] - post_type 강제 지정 (생략 시 Claude 자동 선택)
 * @param {boolean} [opts.save=true] - threads/<...>.md 파일로 저장 여부
 * @param {boolean} [opts.quiet=false] - 콘솔 출력 최소화
 * @param {string} [opts.model='claude-sonnet-4-6'] - 생성에 쓸 Claude 모델
 * @returns {Promise<{post: object, filepath: string|null, usage: object}>}
 */
export async function generateThread({ topic, type: forcedType, save = true, quiet = false, model = 'claude-sonnet-4-6' }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('환경변수 ANTHROPIC_API_KEY가 설정되지 않았습니다.');
  }

  const log = quiet ? () => {} : (...args) => console.log(...args);
  const writeProgress = quiet ? () => {} : (s) => process.stdout.write(s);

  const client = new Anthropic();
  const systemPrompt = await fs.readFile(path.join(PROMPTS_DIR, 'system_threads.md'), 'utf-8');
  const announcementsCtx = await getAnnouncementsContext();
  const fullSystem = systemPrompt + '\n' + announcementsCtx;

  let userMessage = `주제: ${topic}\n\n`;
  if (forcedType) {
    if (!POST_TYPES.includes(forcedType)) {
      throw new Error(`타입은 다음 중 하나여야 합니다: ${POST_TYPES.join(', ')}`);
    }
    userMessage += `반드시 "${forcedType}" 타입으로 작성해.\n`;
  } else {
    userMessage += '주제에 가장 적합한 타입을 골라서 스레드 포스트 1개 작성해.\n';
  }
  userMessage += '주제와 매칭되는 공고가 위 컨텍스트에 있으면 그 공고를 우선 참조해. 매칭 안 되면 일반 지식으로 가도 됨.';

  log('');
  log(`주제 : ${topic}`);
  if (forcedType) log(`타입 : ${forcedType} (지정됨)`);
  if (announcementsCtx.includes('공고 데이터 없음')) {
    log('⚠️  공고 데이터 없음 (node crawl.js 먼저 실행 권장)');
  }
  log(`Claude ${model} 호출 중...`);
  writeProgress('  ');

  const stream = client.messages.stream({
    model,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    output_config: {
      format: { type: 'json_schema', schema: THREAD_SCHEMA },
    },
    system: [
      {
        type: 'text',
        text: fullSystem,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userMessage }],
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' &&
        (event.delta.type === 'text_delta' || event.delta.type === 'thinking_delta')) {
      writeProgress('.');
    }
  }
  log('');

  const finalMessage = await stream.finalMessage();
  const textBlock = finalMessage.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('Claude가 텍스트를 반환하지 않았습니다');

  const post = JSON.parse(textBlock.text);

  log('');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`타입: ${post.post_type}  (${post.char_count}자)`);
  log(`이유: ${post.reasoning}`);
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('');
  log(post.main_post);
  log('');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let filepath = null;
  if (save) {
    await fs.mkdir(THREADS_DIR, { recursive: true });
    const filename = `${todayStr()}_${post.post_type}_${slugify(topic)}.md`;
    filepath = path.join(THREADS_DIR, filename);
    const md = `---
type: ${post.post_type}
topic: ${topic}
generated: ${new Date().toISOString()}
char_count: ${post.char_count}
reasoning: ${post.reasoning}
---

${post.main_post}
`;
    await fs.writeFile(filepath, md, 'utf-8');
    log('');
    log(`저장 : ${filepath}`);
  }

  const usage = finalMessage.usage;
  log(`토큰 : 입력 ${usage.input_tokens} / 출력 ${usage.output_tokens} / 캐시read ${usage.cache_read_input_tokens || 0}`);
  log('');

  return { post, filepath, usage };
}

// CLI 진입점 (직접 실행될 때만)
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('generate_thread.js')) {
  const { topic, type } = parseArgs(process.argv);
  if (!topic) {
    console.error('사용법: node generate_thread.js "<주제>" [--type=<타입>]');
    console.error('');
    console.error('타입 (생략 시 Claude가 자동 선택):');
    console.error(`  ${POST_TYPES.join(', ')}`);
    console.error('');
    console.error('예시:');
    console.error('  node generate_thread.js "TIPS 마감 임박"');
    console.error('  node generate_thread.js --type=오해풀기 "벤처인증에 대한 오해"');
    process.exit(1);
  }

  generateThread({ topic, type }).catch(err => {
    console.error('\n에러:', err.message);
    process.exit(1);
  });
}
