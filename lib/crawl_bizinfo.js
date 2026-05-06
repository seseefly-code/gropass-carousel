// 기업마당 (bizinfo.go.kr) 사업공고 목록 크롤러
//
// 한 페이지당 15건. 기본 3페이지 (=45건) 수집.

const LIST_URL = 'https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/list.do';
const DETAIL_BASE = 'https://www.bizinfo.go.kr';

/**
 * 한 페이지의 공고 목록을 추출
 * @param {import('puppeteer').Page} page - puppeteer Page (이미 navigated)
 * @returns {Promise<Array>}
 */
async function extractPageEntries(page) {
  return await page.evaluate(() => {
    const rows = document.querySelectorAll('table tbody tr');
    const entries = [];

    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 7) continue; // 데이터 행 아님

      const titleLink = cells[2]?.querySelector('a');
      if (!titleLink) continue;

      const titleText = titleLink.textContent.trim();
      if (!titleText) continue;

      // 신청기간 파싱: "2026-04-30 ~ 2026-05-20" 형태
      const periodText = cells[3]?.textContent.trim() || '';
      const periodMatch = periodText.match(/(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/);
      const start_date = periodMatch ? periodMatch[1] : null;
      const end_date = periodMatch ? periodMatch[2] : (periodText.includes('상시') ? '상시' : null);

      // 상세 URL에서 pblancId 추출
      const href = titleLink.getAttribute('href') || '';
      const idMatch = href.match(/pblancId=([A-Z0-9_]+)/);
      const pblancId = idMatch ? idMatch[1] : null;

      entries.push({
        no: cells[0]?.textContent.trim() || null,
        category: cells[1]?.textContent.trim() || null,
        title: titleText,
        start_date,
        end_date,
        period_text: periodText,
        ministry: cells[4]?.textContent.trim() || null,
        agency: cells[5]?.textContent.trim() || null,
        registered_at: cells[6]?.textContent.trim() || null,
        views: cells[7]?.textContent.trim() || null,
        pblancId,
        detail_url: pblancId ? `${'https://www.bizinfo.go.kr'}${href.startsWith('/') ? href : '/' + href}` : null,
      });
    }

    return entries;
  });
}

/**
 * 기업마당 공고 N페이지 크롤링
 * @param {import('puppeteer').Browser} browser - puppeteer Browser
 * @param {object} opts - { pages?: number = 3 }
 * @returns {Promise<Array>}
 */
export async function crawlBizinfo(browser, opts = {}) {
  const numPages = opts.pages || 3;
  const allEntries = [];

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
  );

  try {
    for (let i = 1; i <= numPages; i++) {
      const url = i === 1 ? LIST_URL : `${LIST_URL}?cpage=${i}`;
      process.stdout.write(`  page ${i}/${numPages} ... `);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await page.evaluate(() => document.fonts.ready);
      const entries = await extractPageEntries(page);
      allEntries.push(...entries);
      console.log(`${entries.length}건`);

      // Polite delay between pages (1.5s)
      if (i < numPages) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  } finally {
    await page.close();
  }

  return allEntries;
}
