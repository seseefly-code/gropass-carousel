// save_token.js — User Token Generator로 받은 long-lived 토큰을 검증 + 저장
//
// 사용법:
//   node save_token.js <ACCESS_TOKEN>

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '.threads-token.json');

const token = process.argv[2];
if (!token) {
  console.error('사용법: node save_token.js <ACCESS_TOKEN>');
  process.exit(1);
}

async function main() {
  console.log('토큰 검증 중 (/me 호출)...');

  const url = new URL('https://graph.threads.net/v1.0/me');
  url.searchParams.set('fields', 'id,username,name,threads_profile_picture_url');
  url.searchParams.set('access_token', token);

  const res = await fetch(url.toString());
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`토큰 검증 실패 (${res.status}): ${text}`);
  }
  const userInfo = JSON.parse(text);

  // User Token Generator로 받은 토큰은 60일짜리
  const expiresInSeconds = 60 * 24 * 60 * 60;
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

  const tokenData = {
    access_token: token,
    token_type: 'bearer',
    expires_in_seconds: expiresInSeconds,
    expires_at: expiresAt,
    user_id: userInfo.id,
    username: userInfo.username,
    name: userInfo.name || null,
    profile_picture_url: userInfo.threads_profile_picture_url || null,
    obtained_at: new Date().toISOString(),
    source: 'user_token_generator',
  };

  await fs.writeFile(TOKEN_FILE, JSON.stringify(tokenData, null, 2), 'utf-8');

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ 토큰 저장 완료');
  console.log(`   파일   : ${TOKEN_FILE}`);
  console.log(`   계정   : @${userInfo.username}${userInfo.name ? ` (${userInfo.name})` : ''}`);
  console.log(`   user_id: ${userInfo.id}`);
  console.log(`   만료   : ${expiresAt.slice(0, 10)} (60일)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main().catch(err => {
  console.error('\n에러:', err.message);
  process.exit(1);
});
