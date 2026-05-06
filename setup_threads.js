// setup_threads.js — OAuth code → 60일 long-lived 토큰 교환 + 저장
//
// 사용법:
//   node setup_threads.js <OAUTH_CODE>
//
// 사전 조건 (환경변수):
//   THREADS_APP_ID
//   THREADS_APP_SECRET
//
// 결과:
//   .threads-token.json 파일에 저장 (access_token, user_id, expires_at)
//   .gitignore 에 자동 포함됨

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '.threads-token.json');
const REDIRECT_URI = 'https://gropass.co.kr/';

const APP_ID = process.env.THREADS_APP_ID;
const APP_SECRET = process.env.THREADS_APP_SECRET;

async function exchangeCodeForShortToken(code) {
  const params = new URLSearchParams({
    client_id: APP_ID,
    client_secret: APP_SECRET,
    code: code,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
  });

  const res = await fetch('https://graph.threads.net/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`code → short-lived 토큰 교환 실패 (${res.status}): ${text}`);
  }
  return JSON.parse(text);
}

async function exchangeForLongLivedToken(shortToken) {
  const url = new URL('https://graph.threads.net/access_token');
  url.searchParams.set('grant_type', 'th_exchange_token');
  url.searchParams.set('client_secret', APP_SECRET);
  url.searchParams.set('access_token', shortToken);

  const res = await fetch(url.toString());
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`short → long-lived 토큰 교환 실패 (${res.status}): ${text}`);
  }
  return JSON.parse(text);
}

async function getUserInfo(accessToken) {
  const url = new URL('https://graph.threads.net/v1.0/me');
  url.searchParams.set('fields', 'id,username,name,threads_profile_picture_url');
  url.searchParams.set('access_token', accessToken);

  const res = await fetch(url.toString());
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`사용자 정보 조회 실패 (${res.status}): ${text}`);
  }
  return JSON.parse(text);
}

async function main() {
  const code = process.argv[2];
  if (!code) {
    console.error('사용법: node setup_threads.js <OAUTH_CODE>');
    console.error('');
    console.error('OAUTH_CODE 받는 법:');
    console.error('  1. 브라우저에서 다음 URL 열기:');
    console.error(`     https://threads.net/oauth/authorize?client_id=${APP_ID || 'YOUR_APP_ID'}&redirect_uri=${REDIRECT_URI}&scope=threads_basic,threads_content_publish&response_type=code`);
    console.error('  2. 권한 승인 후 리디렉션된 URL의 ?code= 값 복사');
    process.exit(1);
  }

  if (!APP_ID || !APP_SECRET) {
    console.error('환경변수 THREADS_APP_ID 또는 THREADS_APP_SECRET 가 설정되지 않았습니다.');
    console.error('PowerShell에서 등록 후 새 셸에서 다시 실행:');
    console.error("  [System.Environment]::SetEnvironmentVariable('THREADS_APP_ID', '...', 'User')");
    console.error("  [System.Environment]::SetEnvironmentVariable('THREADS_APP_SECRET', '...', 'User')");
    process.exit(1);
  }

  // OAuth code에 #_=_ 같은 잡음이 붙는 경우 자동 제거
  const cleanCode = code.replace(/#.*$/, '').replace(/&.*$/, '').trim();
  if (cleanCode !== code) {
    console.log(`(코드에서 잡음 제거: ${code.length}자 → ${cleanCode.length}자)`);
  }

  console.log('');
  console.log('1/3  code → short-lived 토큰 교환...');
  const shortResult = await exchangeCodeForShortToken(cleanCode);
  console.log(`     ✓ short-lived 토큰 받음 (user_id: ${shortResult.user_id})`);

  console.log('2/3  short → long-lived 토큰 교환 (60일짜리)...');
  const longResult = await exchangeForLongLivedToken(shortResult.access_token);
  const expiresAt = new Date(Date.now() + longResult.expires_in * 1000).toISOString();
  console.log(`     ✓ long-lived 토큰 받음 (만료: ${expiresAt.slice(0, 10)})`);

  console.log('3/3  사용자 정보 조회...');
  const userInfo = await getUserInfo(longResult.access_token);
  console.log(`     ✓ 계정: @${userInfo.username} (${userInfo.name || ''})`);

  const tokenData = {
    access_token: longResult.access_token,
    token_type: longResult.token_type,
    expires_in_seconds: longResult.expires_in,
    expires_at: expiresAt,
    user_id: shortResult.user_id,
    username: userInfo.username,
    name: userInfo.name || null,
    profile_picture_url: userInfo.threads_profile_picture_url || null,
    obtained_at: new Date().toISOString(),
  };

  await fs.writeFile(TOKEN_FILE, JSON.stringify(tokenData, null, 2), 'utf-8');

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ 토큰 저장 완료');
  console.log(`   파일: ${TOKEN_FILE}`);
  console.log(`   계정: @${userInfo.username}`);
  console.log(`   만료: ${expiresAt.slice(0, 10)} (60일)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('이제 post_thread.js 를 만들면 게시 가능합니다.');
}

main().catch(err => {
  console.error('\n에러:', err.message);
  process.exit(1);
});
