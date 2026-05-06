// announcements.js — 크롤링된 공고 데이터를 generators가 읽을 수 있게 가공
//
// generators가 호출:
//   const ctx = await getAnnouncementsContext();   // markdown 표 (프롬프트 캐시 가능)

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LATEST_PATH = path.join(__dirname, '..', 'data', 'announcements', 'latest.json');

/**
 * 최신 공고 데이터 로드 (없으면 null)
 * @returns {Promise<{crawled_at: string, source: string, count: number, announcements: Array} | null>}
 */
export async function loadLatest() {
  try {
    const raw = await fs.readFile(LATEST_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * D-day 계산 (오늘 기준)
 * @param {string} endDate - "2026-05-15" 형태
 * @returns {number | null} - 오늘로부터 며칠 (음수: 지난 마감, null: 상시 또는 잘못된 날짜)
 */
export function calcDDay(endDate) {
  if (!endDate || endDate === '상시') return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  if (isNaN(end.getTime())) return null;
  end.setHours(0, 0, 0, 0);
  return Math.round((end - today) / (1000 * 60 * 60 * 24));
}

/**
 * 마감일 기준 정렬 + D-day 추가
 * @param {Array} announcements
 * @returns {Array} - 마감 가까운 순, dDay 필드 포함
 */
export function sortByDeadline(announcements) {
  return announcements
    .map(a => ({ ...a, dDay: calcDDay(a.end_date) }))
    .sort((a, b) => {
      // 마감 지난 것 + 상시는 뒤로
      if (a.dDay === null && b.dDay === null) return 0;
      if (a.dDay === null) return 1;
      if (b.dDay === null) return -1;
      if (a.dDay < 0 && b.dDay >= 0) return 1;
      if (b.dDay < 0 && a.dDay >= 0) return -1;
      return a.dDay - b.dDay;
    });
}

/**
 * Claude 프롬프트에 끼워넣을 markdown 표 형태로 변환
 * (캐시 가능하도록 정렬 안정적)
 * @returns {Promise<string>}
 */
export async function getAnnouncementsContext() {
  const data = await loadLatest();
  if (!data || !data.announcements?.length) {
    return '\n_(공고 데이터 없음 - node crawl.js 로 먼저 수집 필요)_\n';
  }

  const sorted = sortByDeadline(data.announcements);
  const rows = sorted.map(a => {
    const dday = a.dDay === null ? '상시' :
                 a.dDay < 0 ? `마감(${Math.abs(a.dDay)}일전)` :
                 a.dDay === 0 ? '오늘마감' :
                 `D-${a.dDay}`;
    return `| ${a.category || '-'} | ${a.title} | ${a.period_text || a.end_date || '-'} | ${dday} | ${a.ministry || '-'} | ${a.agency || '-'} |`;
  });

  return [
    '',
    `## 최근 정책자금 공고 (${data.count}건, 수집일 ${data.crawled_at.slice(0, 10)})`,
    '',
    '아래는 기업마당(bizinfo.go.kr)에서 자동 수집한 실제 공고 목록입니다.',
    '콘텐츠 작성 시 **이 데이터를 우선 활용**하세요. 사업명·마감일·부처는 정확합니다.',
    '단, 지원 금액·자격 조건 같은 상세 정보는 listing에 없으므로,',
    '잘 모르는 디테일은 일반화하거나 "공고 확인 필요" 식으로 표현하세요.',
    '',
    '| 분야 | 사업명 | 신청기간 | D-day | 소관부처 | 수행기관 |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

/**
 * 마감 임박 공고 필터 (디버그/CLI용)
 * @param {number} days - 며칠 이내 마감 (기본 7)
 * @returns {Promise<Array>}
 */
export async function getUpcoming(days = 7) {
  const data = await loadLatest();
  if (!data) return [];
  return sortByDeadline(data.announcements).filter(a =>
    a.dDay !== null && a.dDay >= 0 && a.dDay <= days
  );
}
