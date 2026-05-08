// get_kakao_token.js — 카카오 인가코드 → access/refresh 토큰 교환 (1회 실행)
//
// 사용법:
//   1. 카카오 개발자 콘솔에서 "카카오톡 메시지 전송" 동의항목 활성
//   2. Redirect URI 확인 (예: https://gropass.co.kr)
//   3. 브라우저로 인가:
//      https://kauth.kakao.com/oauth/authorize?client_id={REST_API_KEY}&redirect_uri={URI}&response_type=code&scope=talk_message
//   4. 동의 → 리다이렉트된 URL의 ?code=XXX 복사
//   5. KAKAO_REST_API_KEY=... KAKAO_CLIENT_SECRET=... KAKAO_REDIRECT_URI=... \
//        node get_kakao_token.js <CODE>
//
// 결과:
//   - .kakao-memo-token.json 저장 (gitignored 권장)
//   - GitHub Actions secret 등록 안내 출력

import { writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = join(__dirname, '.kakao-memo-token.json');

const code = process.argv[2];
const REST_API_KEY = process.env.KAKAO_REST_API_KEY;
const CLIENT_SECRET = process.env.KAKAO_CLIENT_SECRET;
const REDIRECT_URI = process.env.KAKAO_REDIRECT_URI;

async function main() {
  if (!code || !REST_API_KEY || !REDIRECT_URI) {
    console.error('❌ 환경변수/인자 누락');
    console.error('   사용법:');
    console.error('   KAKAO_REST_API_KEY=... KAKAO_CLIENT_SECRET=... \\');
    console.error('   KAKAO_REDIRECT_URI=https://gropass.co.kr \\');
    console.error('   node get_kakao_token.js <CODE>');
    process.exit(1);
  }

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: REST_API_KEY,
    redirect_uri: REDIRECT_URI,
    code,
  });
  if (CLIENT_SECRET) params.set('client_secret', CLIENT_SECRET);

  const res = await fetch('https://kauth.kakao.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();

  if (!res.ok || !data.access_token) {
    console.error('❌ 토큰 교환 실패:', JSON.stringify(data, null, 2));
    process.exit(1);
  }

  writeFileSync(
    TOKEN_FILE,
    JSON.stringify(
      {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_in: data.expires_in,
        refresh_token_expires_in: data.refresh_token_expires_in,
        scope: data.scope,
        obtained_at: new Date().toISOString(),
      },
      null,
      2
    ),
    { mode: 0o600 }
  );

  const refreshDays = Math.round((data.refresh_token_expires_in || 0) / 86400);

  console.log('');
  console.log('✅ 카카오 토큰 발급 + 저장 완료');
  console.log('');
  console.log(`  scope                  : ${data.scope}`);
  console.log(`  access_token 만료까지   : ${Math.round(data.expires_in / 3600)}시간`);
  console.log(`  refresh_token 만료까지  : ${refreshDays}일`);
  console.log(`  저장                    : ${TOKEN_FILE}`);
  console.log('');
  console.log('━'.repeat(60));
  console.log('GitHub Actions secrets 등록 (다음 명령으로 자동):');
  console.log('━'.repeat(60));
  console.log('');
  console.log('  cat .kakao-memo-token.json | jq -r .refresh_token | \\');
  console.log('    gh secret set KAKAO_REFRESH_TOKEN --repo seseefly-code/gropass-carousel');
  console.log('');
  console.log('  gh secret set KAKAO_REST_API_KEY --repo seseefly-code/gropass-carousel \\');
  console.log(`    --body "${REST_API_KEY}"`);
  if (CLIENT_SECRET) {
    console.log('');
    console.log('  gh secret set KAKAO_CLIENT_SECRET --repo seseefly-code/gropass-carousel \\');
    console.log(`    --body "${CLIENT_SECRET.slice(0, 6)}…(전체 값으로 직접 등록)"`);
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
