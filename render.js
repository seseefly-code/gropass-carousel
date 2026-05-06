// render.js — HTML 슬라이드 템플릿을 PNG로 렌더링
//
// 사용법:
//   node render.js data/week_19.json
//
// 결과:
//   out/<carousel_id>/slide_01.png ~ slide_NN.png

import puppeteer from 'puppeteer';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SLIDE_DIR = __dirname;
const OUT_DIR = path.join(__dirname, 'out');

async function renderSlide(browser, templateName, content, outputPath) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 2 });

  const filePath = path.join(SLIDE_DIR, templateName + '.html');
  const fileUrl = 'file:///' + filePath.replace(/\\/g, '/');
  await page.goto(fileUrl, { waitUntil: 'networkidle0' });

  // 폰트 로딩 대기 (Pretendard CDN)
  await page.evaluate(() => document.fonts.ready);

  // 콘텐츠 주입 (CSS 셀렉터 → innerHTML)
  if (content && Object.keys(content).length > 0) {
    await page.evaluate((updates) => {
      for (const [selector, value] of Object.entries(updates)) {
        const els = document.querySelectorAll(selector);
        els.forEach(el => { el.innerHTML = value; });
      }
    }, content);
  }

  // 레이아웃 안정화 대기
  await new Promise(r => setTimeout(r, 250));

  // .slide 엘리먼트만 캡처 (1080x1080)
  const slideEl = await page.$('.slide');
  if (!slideEl) {
    throw new Error(`'.slide' 엘리먼트를 찾을 수 없습니다: ${templateName}`);
  }
  await slideEl.screenshot({ path: outputPath, type: 'png' });

  await page.close();
}

async function renderCarousel(configPath) {
  const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));

  if (!config.carousel_id || !Array.isArray(config.slides)) {
    throw new Error('config 파일에 carousel_id 와 slides 배열이 필요합니다');
  }

  const carouselDir = path.join(OUT_DIR, config.carousel_id);
  await fs.mkdir(carouselDir, { recursive: true });

  console.log('');
  console.log(`캐러셀 ID : ${config.carousel_id}`);
  console.log(`출력 폴더 : ${carouselDir}`);
  console.log(`슬라이드  : ${config.slides.length}개`);
  console.log('');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    for (let i = 0; i < config.slides.length; i++) {
      const slide = config.slides[i];
      const num = String(i + 1).padStart(2, '0');
      const outPath = path.join(carouselDir, `slide_${num}.png`);
      process.stdout.write(`  [${num}] ${slide.template} → slide_${num}.png ... `);
      await renderSlide(browser, slide.template, slide.content || {}, outPath);
      console.log('OK');
    }
  } finally {
    await browser.close();
  }

  console.log('');
  console.log(`✓ ${config.slides.length}개 슬라이드 렌더 완료`);
  console.log(`  → ${carouselDir}`);
}

const configPath = process.argv[2];
if (!configPath) {
  console.error('사용법: node render.js <config.json>');
  console.error('예  : node render.js data/week_19.json');
  process.exit(1);
}

renderCarousel(path.resolve(configPath)).catch(err => {
  console.error('\n에러:', err.message);
  console.error(err.stack);
  process.exit(1);
});
