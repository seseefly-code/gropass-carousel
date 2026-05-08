// apply_themes.js — 미리 만든 7개 데이터에 요일별 theme 추가
//
// 사용법:
//   node apply_themes.js
//
// 동작:
//   - data/*.json 중 theme 필드가 없는 모든 파일에 carousel_id 패턴 기반 theme 적용

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { inferThemeFromCarouselId } from './themes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

async function main() {
  const files = await fs.readdir(DATA_DIR);
  const targets = files.filter(
    (f) => f.endsWith('.json') && !f.includes('announcement')
  );

  console.log(`대상 파일: ${targets.length}건`);
  for (const f of targets) {
    const fp = path.join(DATA_DIR, f);
    const data = JSON.parse(await fs.readFile(fp, 'utf-8'));
    const theme = inferThemeFromCarouselId(data.carousel_id || '');
    data.theme = theme;
    await fs.writeFile(fp, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`  ✓ ${f} ← theme.primary=${theme.primary}, label="${theme.label}"`);
  }
  console.log('완료');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
