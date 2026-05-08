// themes.js — 7가지 요일별 컬러 팔레트
//
// 사용법:
//   import { getThemeForDate, THEMES } from './themes.js';
//   const theme = getThemeForDate('2026-05-09');

export const THEMES = {
  // 월 — 마감 임박 (네이비/블루) — 정보·엄숙
  monday: {
    primary: '#0A1F44',
    accent: '#2563EB',
    highlight: '#FDE68A',
    'gradient-tint': '#1E40AF22',
    'dark-bg': '#0F172A',
    label: '정책자금 위클리 · 마감',
  },
  // 화 — 신청 노하우 (다크그린) — 성장·조언
  tuesday: {
    primary: '#064E3B',
    accent: '#10B981',
    highlight: '#FEF3C7',
    'gradient-tint': '#10B98122',
    'dark-bg': '#022C22',
    label: '신청 노하우 · 자주 놓치는 5',
  },
  // 수 — 업종별 (와인/마젠타) — 따뜻함·생업
  wednesday: {
    primary: '#7C2D12',
    accent: '#EA580C',
    highlight: '#FED7AA',
    'gradient-tint': '#EA580C22',
    'dark-bg': '#431407',
    label: '업종별 · 카페·식당 5선',
  },
  // 목 — 매칭 케이스 (퍼플) — 깊이·진지함
  thursday: {
    primary: '#3730A3',
    accent: '#6366F1',
    highlight: '#FDE68A',
    'gradient-tint': '#6366F122',
    'dark-bg': '#1E1B4B',
    label: '매칭 케이스 · 사장님 5분',
  },
  // 금 — 신규 공고 (시안/블루) — 신선함
  friday: {
    primary: '#155E75',
    accent: '#06B6D4',
    highlight: '#FEF08A',
    'gradient-tint': '#06B6D422',
    'dark-bg': '#083344',
    label: '이번 주 신규 · 5선',
  },
  // 토 — 핵심 숫자 (다크 마젠타) — 강조·주목
  saturday: {
    primary: '#831843',
    accent: '#DB2777',
    highlight: '#FBCFE8',
    'gradient-tint': '#DB277722',
    'dark-bg': '#500724',
    label: '핵심 숫자 · 5가지',
  },
  // 일 — FAQ (보라) — 부드러움·대화
  sunday: {
    primary: '#581C87',
    accent: '#9333EA',
    highlight: '#FBBF24',
    'gradient-tint': '#9333EA22',
    'dark-bg': '#3B0764',
    label: '자주 묻는 질문 · 5',
  },
};

const DOW_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * KST 기준 날짜 → 해당 요일의 theme 반환
 * @param {string} dateStr - "YYYY-MM-DD" (KST)
 */
export function getThemeForDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00+09:00');
  const dow = d.getUTCDay(); // 0=일 ~ 6=토 (UTC지만 KST 자정 기준이라 같음)
  return THEMES[DOW_NAMES[dow]];
}

/**
 * carousel_id → 추정 요일 (휴리스틱)
 *   "deadline_*"   → monday
 *   "tips_*"       → tuesday
 *   "industry_*"   → wednesday
 *   "case_*"       → thursday
 *   "week_new*"    → friday
 *   "key_numbers*" → saturday
 *   "faq_*"        → sunday
 */
export function inferThemeFromCarouselId(id) {
  if (id.startsWith('deadline_')) return THEMES.monday;
  if (id.startsWith('tips_')) return THEMES.tuesday;
  if (id.startsWith('industry_')) return THEMES.wednesday;
  if (id.startsWith('case_')) return THEMES.thursday;
  if (id.startsWith('week_new')) return THEMES.friday;
  if (id.startsWith('key_numbers')) return THEMES.saturday;
  if (id.startsWith('faq_')) return THEMES.sunday;
  return THEMES.monday; // default
}

/**
 * carousel_id → cover 슬라이드 템플릿명 (주제별 레이아웃)
 */
export function inferCoverTemplate(id) {
  if (id.startsWith('deadline_')) return 'slide_01_cover_deadline';
  if (id.startsWith('tips_')) return 'slide_01_cover_tips';
  if (id.startsWith('industry_')) return 'slide_01_cover_industry';
  if (id.startsWith('case_')) return 'slide_01_cover_case';
  if (id.startsWith('week_new')) return 'slide_01_cover_new';
  if (id.startsWith('key_numbers')) return 'slide_01_cover_numbers';
  if (id.startsWith('faq_')) return 'slide_01_cover_faq';
  return 'slide_01_cover'; // default
}
