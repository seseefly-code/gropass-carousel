// generate.js — 주제 한 줄 → Claude로 캐러셀 콘텐츠 JSON 자동 생성
//
// 사용법:
//   ANTHROPIC_API_KEY=sk-ant-... node generate.js "이번 주 마감 임박 정책자금 5선"
//
// 결과:
//   data/<carousel_id>.json (render.js로 바로 사용 가능)

import Anthropic from '@anthropic-ai/sdk';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAnnouncementsContext } from './lib/announcements.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const PROMPTS_DIR = path.join(__dirname, 'prompts');

// Claude가 출력할 시맨틱 JSON 스키마 (선택자 기반 X, 의미 기반)
// 이걸 generate.js가 render.js용 선택자 기반 포맷으로 변환함.
const CAROUSEL_SCHEMA = {
  type: 'object',
  properties: {
    carousel_id: {
      type: 'string',
      description: 'snake_case 영문 ID. 예: "week_20", "industry_manufacturing"',
    },
    topic: {
      type: 'string',
      description: '캐러셀 주제 한국어',
    },
    cover: {
      type: 'object',
      properties: {
        label: { type: 'string', description: '예: "정책자금 위클리"' },
        week: { type: 'string', description: '예: "2026년 5월 2주차"' },
        eyebrow: { type: 'string', description: '예: "이번 주 마감 임박"' },
        headline: { type: 'string', description: 'HTML 가능. <br>로 줄바꿈, <em>로 강조. 12자 한 줄, 최대 3줄.' },
        sub: { type: 'string', description: 'HTML. 부제 2줄.' },
      },
      required: ['label', 'week', 'eyebrow', 'headline', 'sub'],
      additionalProperties: false,
    },
    items: {
      type: 'array',
      description: '정확히 5개의 정책자금. info 슬라이드는 1번만 다루고, list 슬라이드는 5개 모두 보여줌.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '정책자금 정식 명칭' },
          tags: {
            type: 'array',
            description: '3개 태그 (주관·대상·조건)',
            items: { type: 'string' },
          },
          description: {
            type: 'string',
            description: 'info 슬라이드용 본문. HTML. 3줄 이내. <strong>로 핵심 1~2 부분 강조.',
          },
          stat_amount_label: { type: 'string', description: '예: "최대 지원금"' },
          stat_amount_value: { type: 'string', description: 'HTML. 예: "1<span class=\\"unit\\">억원</span>"' },
          stat_deadline_label: { type: 'string', description: '예: "신청 마감"' },
          stat_deadline_value: { type: 'string', description: 'HTML. 예: "5<span class=\\"unit\\">/15</span>"' },
          stat_selection_label: { type: 'string', description: '예: "선발 예정"' },
          stat_selection_value: { type: 'string', description: 'HTML. 예: "300<span class=\\"unit\\">개사</span>"' },
          list_amount: { type: 'string', description: '리스트용 짧은 금액. 예: "최대 1억"' },
          list_deadline: { type: 'string', description: 'D-day 형식. 예: "D-9 · 5/15 마감"' },
          list_desc: { type: 'string', description: '리스트용 한 줄 요약. 예: "중기부 · 만 39세 이하 · 창업 7년 미만"' },
        },
        required: [
          'name', 'tags', 'description',
          'stat_amount_label', 'stat_amount_value',
          'stat_deadline_label', 'stat_deadline_value',
          'stat_selection_label', 'stat_selection_value',
          'list_amount', 'list_deadline', 'list_desc',
        ],
        additionalProperties: false,
      },
    },
    summary: {
      type: 'object',
      properties: {
        eyebrow: { type: 'string', description: '예: "SUMMARY"' },
        title: { type: 'string', description: 'HTML. 리스트 슬라이드 제목. 예: "5월 안에 챙겨야 할<br><em>정책자금 5</em>"' },
      },
      required: ['eyebrow', 'title'],
      additionalProperties: false,
    },
    insight: {
      type: 'object',
      properties: {
        eyebrow: { type: 'string', description: '예: "KEY INSIGHT"' },
        quote: { type: 'string', description: 'HTML. 한 줄 통찰. <em>로 핵심 단어, <span class="underline">로 보조 강조.' },
        attribution: { type: 'string', description: '예: "정책자금 컨설팅 15년 차 코멘트"' },
        footer: { type: 'string', description: 'HTML. 보충 설명 2줄.' },
      },
      required: ['eyebrow', 'quote', 'attribution', 'footer'],
      additionalProperties: false,
    },
    cta: {
      type: 'object',
      properties: {
        badge: { type: 'string', description: '예: "DON\'T MISS"' },
        headline: { type: 'string', description: 'HTML. 그로패스 가치 제안. 예: "사업자번호 하나로<br><em>1분 만에</em> 매칭."' },
        sub: { type: 'string', description: 'HTML. 부제 2줄.' },
      },
      required: ['badge', 'headline', 'sub'],
      additionalProperties: false,
    },
    caption: {
      type: 'string',
      description: 'Instagram 게시 본문(caption). 사장님 운영자가 쓴 것처럼 자연스러운 한국어. 후킹 1줄 → 빈줄 → 본문 3~5줄 → 빈줄 → 그로패스 자연 언급 1~2줄 → 빈줄 → 해시태그 8~12개. 총 250~400자. AI 티 절대 금지. 첫 줄에 이모지 1개만.',
    },
  },
  required: ['carousel_id', 'topic', 'cover', 'items', 'summary', 'insight', 'cta', 'caption'],
  additionalProperties: false,
};

// 시맨틱 JSON → render.js용 선택자 기반 포맷 변환
function semanticToRenderData(s) {
  const slides = [];

  // 슬라이드 1: cover
  slides.push({
    template: 'slide_01_cover',
    content: {
      '.label': s.cover.label,
      '.week': s.cover.week,
      '.eyebrow': s.cover.eyebrow,
      '.headline': s.cover.headline,
      '.sub': s.cover.sub,
    },
  });

  // 슬라이드 2: info (Top 1 자금)
  const top = s.items[0];
  slides.push({
    template: 'slide_02_info',
    content: {
      '.crumb span': '정책자금 위클리',
      '.pager': '<strong>02</strong> / 05',
      '.num': '01',
      '.num-label': 'FIRST PICK',
      '.title': top.name,
      '.meta': top.tags.map(t => `<span class="tag">${t}</span>`).join(''),
      '.body': top.description,
      '.stats .stat:nth-child(1) .stat-label': top.stat_amount_label,
      '.stats .stat:nth-child(1) .stat-value': top.stat_amount_value,
      '.stats .stat:nth-child(2) .stat-label': top.stat_deadline_label,
      '.stats .stat:nth-child(2) .stat-value': top.stat_deadline_value,
      '.stats .stat:nth-child(3) .stat-label': top.stat_selection_label,
      '.stats .stat:nth-child(3) .stat-value': top.stat_selection_value,
    },
  });

  // 슬라이드 3: list (5개 모두)
  const listContent = {
    '.crumb': '정책자금 위클리 · 한눈에 보기',
    '.pager': '<strong>03</strong> / 05',
    '.eyebrow': s.summary.eyebrow,
    '.title': s.summary.title,
    '.footer-hint': '상세 조건은 마지막 장에서 확인 →',
  };
  s.items.forEach((item, i) => {
    const n = i + 1;
    listContent[`.item:nth-child(${n}) .item-name`] = item.name;
    listContent[`.item:nth-child(${n}) .item-desc`] = item.list_desc;
    listContent[`.item:nth-child(${n}) .item-amount`] = item.list_amount;
    listContent[`.item:nth-child(${n}) .item-deadline`] = item.list_deadline;
  });
  slides.push({ template: 'slide_03_list', content: listContent });

  // 슬라이드 4: insight (다크)
  slides.push({
    template: 'slide_04_quote',
    content: {
      '.crumb': s.insight.eyebrow,
      '.pager': '<strong>04</strong> / 05',
      '.quote': s.insight.quote,
      '.att-text': s.insight.attribution,
      '.footer-quote': s.insight.footer,
      '.brand-domain': 'gropass.co.kr',
    },
  });

  // 슬라이드 5: CTA
  slides.push({
    template: 'slide_05_cta',
    content: {
      '.crumb': '정책자금 위클리 · 마무리',
      '.pager': '<strong>05</strong> / 05',
      '.badge': s.cta.badge,
      '.headline': s.cta.headline,
      '.sub': s.cta.sub,
      '.brand-tag': 'AI 정책자금 매칭 플랫폼',
      '.brand-tag-sub': '중소기업·소상공인 대표를 위한',
      '.url': 'gropass.co.kr',
    },
  });

  return {
    carousel_id: s.carousel_id,
    _topic: s.topic,
    _generated_at: new Date().toISOString(),
    caption: s.caption,
    slides,
  };
}

async function generate(topic) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('환경변수 ANTHROPIC_API_KEY가 설정되지 않았습니다.');
    console.error('Anthropic Console에서 발급: https://console.anthropic.com/settings/keys');
    process.exit(1);
  }

  const client = new Anthropic();
  const systemPrompt = await fs.readFile(path.join(PROMPTS_DIR, 'system.md'), 'utf-8');
  const announcementsCtx = await getAnnouncementsContext();
  const fullSystem = systemPrompt + '\n' + announcementsCtx;

  console.log('');
  console.log(`주제 : ${topic}`);
  const dataNote = announcementsCtx.includes('공고 데이터 없음')
    ? '⚠️  공고 데이터 없음 (node crawl.js 먼저 실행 권장)'
    : `공고 데이터 활용 (${(announcementsCtx.match(/\| /g) || []).length / 6 - 1 | 0}건)`;
  console.log(dataNote);
  console.log('Claude opus-4-7 호출 중 (적응형 사고 활성화)...');
  process.stdout.write('  ');

  const stream = client.messages.stream({
    model: 'claude-opus-4-7',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: {
      format: { type: 'json_schema', schema: CAROUSEL_SCHEMA },
    },
    system: [
      {
        type: 'text',
        text: fullSystem,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `주제: ${topic}\n\n위 주제로 그로패스 인스타 캐러셀 콘텐츠를 JSON으로 생성해주세요.\n주제와 매칭되는 공고가 위 컨텍스트에 있으면 그 공고를 우선 활용하세요. 없으면 일반 지식으로 작성하되 구체 수치는 신중하게.`,
      },
    ],
  });

  // 진행 표시 (점)
  let dotCount = 0;
  for await (const event of stream) {
    if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta' || event.delta.type === 'thinking_delta') {
        process.stdout.write('.');
        if (++dotCount % 60 === 0) process.stdout.write('\n  ');
      }
    }
  }
  console.log('');

  const finalMessage = await stream.finalMessage();
  const textBlock = finalMessage.content.find(b => b.type === 'text');
  if (!textBlock) {
    throw new Error('Claude가 텍스트 블록을 반환하지 않았습니다');
  }

  const semantic = JSON.parse(textBlock.text);

  const usage = finalMessage.usage;
  console.log('');
  console.log('생성 완료.');
  console.log(`  입력 토큰  : ${usage.input_tokens}`);
  console.log(`  캐시 read : ${usage.cache_read_input_tokens || 0}`);
  console.log(`  캐시 write : ${usage.cache_creation_input_tokens || 0}`);
  console.log(`  출력 토큰  : ${usage.output_tokens}`);

  const renderData = semanticToRenderData(semantic);

  await fs.mkdir(DATA_DIR, { recursive: true });
  const outputPath = path.join(DATA_DIR, `${renderData.carousel_id}.json`);
  await fs.writeFile(outputPath, JSON.stringify(renderData, null, 2), 'utf-8');

  console.log('');
  console.log(`✓ 저장 : ${outputPath}`);
  console.log('');
  console.log('다음 명령으로 PNG 5장 생성:');
  console.log(`  node render.js data/${renderData.carousel_id}.json`);
  console.log('');
}

const topic = process.argv.slice(2).join(' ');
if (!topic) {
  console.error('사용법: node generate.js "<주제>"');
  console.error('예  : node generate.js "이번 주 마감 임박 정책자금 5선"');
  process.exit(1);
}

generate(topic).catch(err => {
  console.error('\n에러:', err.message);
  if (err.stack && process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
