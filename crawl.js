// crawl.js — 정책자금 공고 크롤러 진입점
//
// 사용법:
//   node crawl.js              (기본 3페이지)
//   node crawl.js --pages=5    (5페이지)
//
// 결과:
//   data/announcements/<YYYY-MM-DD>_bizinfo.json
//   data/announcements/latest.json (최신본 별칭)

import puppeteer from 'puppeteer';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { crawlBizinfo } from './lib/crawl_bizinfo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'data', 'announcements');

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let pages = 3;
  for (const arg of args) {
    if (arg.startsWith('--pages=')) {
      pages = parseInt(arg.slice('--pages='.length), 10);
      if (isNaN(pages) || pages < 1) pages = 3;
    }
  }
  return { pages };
}

async function main() {
  const { pages } = parseArgs(process.argv);
  await fs.mkdir(OUT_DIR, { recursive: true });

  console.log('');
  console.log('='.repeat(60));
  console.log('정책자금 공고 크롤링');
  console.log('='.repeat(60));
  console.log(`날짜  : ${todayStr()}`);
  console.log(`소스  : 기업마당 (bizinfo.go.kr)`);
  console.log(`페이지 : ${pages}`);
  console.log('');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    console.log('기업마당 크롤링...');
    const startTime = Date.now();
    const entries = await crawlBizinfo(browser, { pages });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('');
    console.log(`✓ ${entries.length}건 수집 (${elapsed}초)`);

    const result = {
      crawled_at: new Date().toISOString(),
      source: 'bizinfo.go.kr',
      pages_crawled: pages,
      count: entries.length,
      announcements: entries,
    };

    // 날짜별 파일
    const datedPath = path.join(OUT_DIR, `${todayStr()}_bizinfo.json`);
    await fs.writeFile(datedPath, JSON.stringify(result, null, 2), 'utf-8');

    // 최신본 별칭 (generators가 항상 이걸 읽음)
    const latestPath = path.join(OUT_DIR, 'latest.json');
    await fs.writeFile(latestPath, JSON.stringify(result, null, 2), 'utf-8');

    console.log('');
    console.log(`저장: ${datedPath}`);
    console.log(`     ${latestPath} (최신본 별칭)`);
    console.log('');

    // 분야별 분포 미리보기
    const byCategory = {};
    for (const e of entries) {
      const cat = e.category || '(없음)';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    }
    console.log('분야별 분포:');
    Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .forEach(([cat, n]) => console.log(`  ${cat.padEnd(10)} ${n}건`));

    console.log('');

    // 마감 임박 (7일 이내) 미리보기
    const today = new Date(todayStr());
    const sevenDays = new Date(today);
    sevenDays.setDate(sevenDays.getDate() + 7);

    const upcoming = entries.filter(e => {
      if (!e.end_date || e.end_date === '상시') return false;
      const end = new Date(e.end_date);
      return end >= today && end <= sevenDays;
    }).sort((a, b) => a.end_date.localeCompare(b.end_date));

    if (upcoming.length > 0) {
      console.log(`마감 임박 (7일 이내) ${upcoming.length}건:`);
      upcoming.slice(0, 10).forEach(e => {
        console.log(`  ${e.end_date} | ${e.title.slice(0, 50)}`);
      });
      console.log('');
    }
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('\n에러:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
