// post_carousel.js — Instagram 캐러셀 자동 게시
//
// 사용법:
//   IG_USER_ID="..." IG_TOKEN="..." node post_carousel.js \
//     --carousel-id=test \
//     --caption="caption text" \
//     [--commit-sha=auto]
//
// 또는 .ig-token-long.txt 파일이 같은 디렉토리에 있으면 IG_TOKEN env 생략 가능.
//
// 전제:
//   1. render.js로 out/<carousel-id>/slide_*.png 생성됨
//   2. 그 PNG들이 git에 commit + push되어 GitHub raw URL 접근 가능
//   3. 레포가 public이거나, instagram이 raw URL에 접근 가능해야 함
//
// 흐름:
//   1. out/<carousel-id>/slide_*.png 파일 목록 수집
//   2. 현재 commit SHA로 GitHub raw URL 생성
//   3. 각 PNG에 대해 미디어 컨테이너 생성 (is_carousel_item=true)
//   4. 모든 자식 컨테이너 FINISHED 될 때까지 폴링
//   5. 캐러셀 컨테이너 생성 (children=[ids])
//   6. media_publish 호출
//   7. 결과 출력

import { promises as fs, existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const TOKEN_FILE = path.join(__dirname, '.ig-token-long.txt');

const IG_USER_ID = process.env.IG_USER_ID || '17841444888541537';
const IG_TOKEN =
  process.env.IG_TOKEN ||
  (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf-8').trim() : null);
const REPO_OWNER = process.env.REPO_OWNER || 'seseefly-code';
const REPO_NAME = process.env.REPO_NAME || 'gropass-carousel';
const GRAPH = 'https://graph.facebook.com/v19.0';

function parseArgs() {
  const args = { carouselId: null, caption: null, commitSha: 'auto' };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--carousel-id=')) args.carouselId = a.slice('--carousel-id='.length);
    else if (a.startsWith('--caption=')) args.caption = a.slice('--caption='.length);
    else if (a.startsWith('--commit-sha=')) args.commitSha = a.slice('--commit-sha='.length);
  }
  return args;
}

/**
 * --caption 인자가 없으면 data/<carousel-id>.json의 caption 필드를 자동 사용
 */
async function resolveCaption(carouselId, explicitCaption) {
  if (explicitCaption !== null) return explicitCaption;
  const dataPath = path.join(__dirname, 'data', `${carouselId}.json`);
  try {
    const raw = await fs.readFile(dataPath, 'utf-8');
    const data = JSON.parse(raw);
    if (typeof data.caption === 'string' && data.caption.trim().length > 0) {
      return data.caption;
    }
  } catch (e) {
    // 데이터 파일 없거나 caption 필드 없으면 빈 캡션
  }
  return '';
}

function getCurrentCommitSha() {
  return execSync('git rev-parse HEAD', { cwd: __dirname }).toString().trim();
}

async function listSlides(carouselId) {
  const dir = path.join(OUT_DIR, carouselId);
  const files = await fs.readdir(dir);
  return files
    .filter((f) => /^slide_\d+\.png$/.test(f))
    .sort()
    .map((f) => ({
      filename: f,
      relPath: `out/${carouselId}/${f}`,
    }));
}

function rawUrl(commitSha, relPath) {
  return `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${commitSha}/${relPath}`;
}

async function igPost(endpoint, params) {
  const url = `${GRAPH}/${IG_USER_ID}${endpoint}`;
  const body = new URLSearchParams({ ...params, access_token: IG_TOKEN });
  const r = await fetch(url, { method: 'POST', body });
  const data = await r.json();
  if (!r.ok || data.error) {
    throw new Error(
      `Instagram API ${endpoint}: ${JSON.stringify(data.error || data)}`
    );
  }
  return data;
}

async function igCheckStatus(containerId) {
  const url = new URL(`${GRAPH}/${containerId}`);
  url.searchParams.set('fields', 'status_code');
  url.searchParams.set('access_token', IG_TOKEN);
  const r = await fetch(url);
  const data = await r.json();
  return data.status_code; // FINISHED, IN_PROGRESS, ERROR, PUBLISHED, EXPIRED
}

async function waitContainer(containerId, label = '', timeoutMs = 120000) {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    attempt += 1;
    const status = await igCheckStatus(containerId);
    if (status === 'FINISHED') {
      console.log(`    ${label} → FINISHED (${attempt}회 폴링)`);
      return;
    }
    if (status === 'ERROR' || status === 'EXPIRED') {
      throw new Error(`Container ${containerId} status: ${status}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Container ${containerId} timeout (${label})`);
}

async function main() {
  if (!IG_USER_ID || !IG_TOKEN) {
    console.error('❌ IG_USER_ID, IG_TOKEN 모두 필요 (env 또는 .ig-token-long.txt)');
    process.exit(1);
  }

  const args = parseArgs();
  if (!args.carouselId) {
    console.error('사용법: node post_carousel.js --carousel-id=<id> [--caption="..."]');
    console.error('       --caption 생략 시 data/<id>.json의 caption 필드 자동 사용');
    process.exit(1);
  }
  const carouselId = args.carouselId;
  const caption = await resolveCaption(carouselId, args.caption);
  const commitSha = args.commitSha;

  const sha = commitSha === 'auto' ? getCurrentCommitSha() : commitSha;
  console.log('');
  console.log('━'.repeat(60));
  console.log('Instagram 캐러셀 게시');
  console.log('━'.repeat(60));
  console.log(`  carousel_id : ${carouselId}`);
  console.log(`  commit SHA  : ${sha}`);
  console.log(`  IG_USER_ID  : ${IG_USER_ID}`);
  console.log(`  caption 길이: ${caption.length}자${caption.length === 0 ? ' (빈 캡션)' : ''}`);
  console.log('');

  const slides = await listSlides(carouselId);
  if (slides.length < 2) {
    throw new Error(`캐러셀은 최소 2장 필요. 현재: ${slides.length}장`);
  }
  if (slides.length > 10) {
    throw new Error(`캐러셀은 최대 10장. 현재: ${slides.length}장`);
  }
  console.log(`Step 1. 슬라이드 ${slides.length}장 발견`);
  for (const s of slides) console.log(`  - ${s.filename}`);
  console.log('');

  // Step 2: 각 슬라이드 미디어 컨테이너 생성
  console.log(`Step 2. 자식 미디어 컨테이너 생성 (${slides.length}개)`);
  const childIds = [];
  for (const slide of slides) {
    const url = rawUrl(sha, slide.relPath);
    console.log(`  · ${slide.filename}`);
    console.log(`      ${url}`);
    const res = await igPost('/media', {
      image_url: url,
      is_carousel_item: 'true',
    });
    childIds.push(res.id);
    console.log(`      → container_id: ${res.id}`);
  }
  console.log('');

  // Step 3: 자식 컨테이너 처리 대기
  console.log('Step 3. 자식 컨테이너 처리 대기...');
  for (let i = 0; i < childIds.length; i++) {
    await waitContainer(childIds[i], `자식 ${i + 1}/${childIds.length}`);
  }
  console.log('');

  // Step 4: 캐러셀 컨테이너 생성
  console.log('Step 4. 캐러셀 컨테이너 생성');
  const carouselRes = await igPost('/media', {
    media_type: 'CAROUSEL',
    caption,
    children: childIds.join(','),
  });
  console.log(`  carousel container_id: ${carouselRes.id}`);
  await waitContainer(carouselRes.id, '캐러셀');
  console.log('');

  // Step 5: 게시
  console.log('Step 5. 게시');
  const publishRes = await igPost('/media_publish', {
    creation_id: carouselRes.id,
  });
  console.log('');
  console.log('━'.repeat(60));
  console.log('🎉 게시 완료');
  console.log('━'.repeat(60));
  console.log(`  media_id : ${publishRes.id}`);
  console.log(`  Instagram에서 "그로패스" 계정 프로필 확인`);
  console.log('');
}

main().catch((err) => {
  console.error('');
  console.error('❌ 에러:', err.message);
  process.exit(1);
});
