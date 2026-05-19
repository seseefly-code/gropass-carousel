// post_thread.js — 스레드에 실제 게시 (텍스트 전용 v1)
//
// 사용법:
//   node post_thread.js <마크다운파일>           본문 미리보기 후 y/N 확인 → 게시
//   node post_thread.js --latest                threads/ 폴더 가장 최근 파일 게시
//   node post_thread.js --text "직접 본문 입력"   인자로 본문 직접 전달
//   node post_thread.js --dry-run <파일>         본문만 출력하고 게시 안 함
//   node post_thread.js --yes <파일>             확인 프롬프트 스킵 (자동화용)
//
// 사전 조건:
//   .threads-token.json (save_token.js 또는 setup_threads.js 결과물)

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '.threads-token.json');
const THREADS_DIR = path.join(__dirname, 'threads');
const API_BASE = 'https://graph.threads.net/v1.0';

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { file: null, text: null, dryRun: false, yes: false, latest: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--latest') out.latest = true;
    else if (a === '--text') out.text = args[++i];
    else if (!a.startsWith('--') && !out.file) out.file = a;
  }
  return out;
}

function stripFrontmatter(md) {
  const m = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n+([\s\S]*)$/);
  return (m ? m[1] : md).trim();
}

async function getLatestThreadFile() {
  const files = await fs.readdir(THREADS_DIR);
  const mds = files.filter(f => f.endsWith('.md'));
  if (mds.length === 0) throw new Error('threads/ 폴더에 .md 파일이 없음');
  const stats = await Promise.all(mds.map(async f => {
    const p = path.join(THREADS_DIR, f);
    return { p, m: (await fs.stat(p)).mtimeMs };
  }));
  stats.sort((a, b) => b.m - a.m);
  return stats[0].p;
}

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, ans => { rl.close(); resolve(ans.trim().toLowerCase()); });
  });
}

async function postFormUrlencoded(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${text}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return JSON.parse(text);
}

/**
 * 토큰 로드 + 만료 체크
 * @returns {Promise<object>}
 */
export async function loadTokenData() {
  let raw = await fs.readFile(TOKEN_FILE, 'utf-8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  const tokenData = JSON.parse(raw);
  const expiresAt = new Date(tokenData.expires_at);
  const daysLeft = Math.floor((expiresAt - new Date()) / (1000 * 60 * 60 * 24));
  if (daysLeft <= 0) {
    throw new Error(`토큰 만료됨 (${tokenData.expires_at}). 새 토큰 발급 필요.`);
  }
  return { ...tokenData, daysLeft };
}

/**
 * 본문 텍스트만 받아서 바로 게시 (프로그래매틱 사용)
 * @param {object} opts
 * @param {string} opts.body
 * @returns {Promise<{mediaId: string, permalink: string|null, username: string}>}
 */
export async function postBody({ body }) {
  if (!body || !body.trim()) throw new Error('본문이 비어있음.');
  const text = body.trim();
  if (text.length > 500) throw new Error(`본문 500자 초과 (${text.length}자).`);

  const tokenData = await loadTokenData();
  const result = await publishTextThread({
    text,
    token: tokenData.access_token,
    userId: tokenData.user_id,
  });
  return { ...result, username: tokenData.username };
}

export async function publishTextThread({ text, token, userId }) {
  // 1) 미디어 컨테이너 생성
  const container = await postFormUrlencoded(`${API_BASE}/${userId}/threads`, {
    media_type: 'TEXT',
    text,
    access_token: token,
  });
  const creationId = container.id;

  // 2) 게시
  const published = await postFormUrlencoded(`${API_BASE}/${userId}/threads_publish`, {
    creation_id: creationId,
    access_token: token,
  });

  // 3) 퍼머링크 조회 (실패해도 무시 — 게시 자체는 성공)
  let permalink = null;
  try {
    const detailUrl = new URL(`${API_BASE}/${published.id}`);
    detailUrl.searchParams.set('fields', 'permalink');
    detailUrl.searchParams.set('access_token', token);
    const res = await fetch(detailUrl.toString());
    if (res.ok) {
      const detail = await res.json();
      permalink = detail.permalink || null;
    }
  } catch {}

  return { mediaId: published.id, creationId, permalink };
}

async function main() {
  const args = parseArgs(process.argv);

  // 토큰 로드
  let tokenData;
  try {
    tokenData = JSON.parse(await fs.readFile(TOKEN_FILE, 'utf-8'));
  } catch {
    console.error('.threads-token.json 파일이 없음. save_token.js 먼저 실행.');
    process.exit(1);
  }

  // 만료 체크
  const expiresAt = new Date(tokenData.expires_at);
  const daysLeft = Math.floor((expiresAt - new Date()) / (1000 * 60 * 60 * 24));
  if (daysLeft <= 0) {
    console.error(`토큰 만료됨 (${tokenData.expires_at}). 새 토큰 발급 필요.`);
    process.exit(1);
  }

  // 본문 결정
  let body, source;
  if (args.text) {
    body = args.text.trim();
    source = '--text 인자';
  } else if (args.latest) {
    const f = await getLatestThreadFile();
    body = stripFrontmatter(await fs.readFile(f, 'utf-8'));
    source = f;
  } else if (args.file) {
    body = stripFrontmatter(await fs.readFile(args.file, 'utf-8'));
    source = args.file;
  } else {
    console.error('사용법:');
    console.error('  node post_thread.js <마크다운파일>');
    console.error('  node post_thread.js --latest');
    console.error('  node post_thread.js --text "본문 직접 입력"');
    console.error('  node post_thread.js --dry-run <파일>');
    console.error('  node post_thread.js --yes <파일>           (확인 스킵)');
    process.exit(1);
  }

  if (!body) {
    console.error('본문이 비어있음.');
    process.exit(1);
  }
  if (body.length > 500) {
    console.error(`본문이 500자 초과 (${body.length}자). 스레드는 500자 제한.`);
    process.exit(1);
  }

  console.log('');
  console.log(`계정 : @${tokenData.username}${tokenData.name ? ` (${tokenData.name})` : ''}`);
  console.log(`만료 : ${tokenData.expires_at.slice(0, 10)} (${daysLeft}일 남음)`);
  console.log(`소스 : ${source}`);
  console.log(`길이 : ${body.length}자`);
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━ 게시 미리보기 ━━━━━━━━━━━━━━━━━━━━━━');
  console.log(body);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  if (args.dryRun) {
    console.log('--dry-run 모드 — 실제 게시 안 함.');
    return;
  }

  if (!args.yes) {
    const ans = await ask('실제로 스레드에 게시할까요? (y/N): ');
    if (ans !== 'y' && ans !== 'yes') {
      console.log('취소됨.');
      return;
    }
  }

  console.log('게시 중...');
  const { mediaId, permalink } = await publishTextThread({
    text: body,
    token: tokenData.access_token,
    userId: tokenData.user_id,
  });

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ 게시 완료');
  console.log(`   media_id : ${mediaId}`);
  if (permalink) {
    console.log(`   URL      : ${permalink}`);
  } else {
    console.log(`   확인     : https://www.threads.net/@${tokenData.username}`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

// CLI 진입점 (직접 실행될 때만)
if (process.argv[1] && process.argv[1].endsWith('post_thread.js')) {
  main().catch(err => {
    console.error('\n에러:', err.message);
    process.exit(1);
  });
}
