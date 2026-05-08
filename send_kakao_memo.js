// send_kakao_memo.js — 본인 카카오톡 "나에게" 메모 발송 (cron에서 사용)
//
// 사용법 (GitHub Actions):
//   KAKAO_REST_API_KEY=... \
//   KAKAO_CLIENT_SECRET=... \
//   KAKAO_REFRESH_TOKEN=... \
//     node send_kakao_memo.js "메시지 내용"
//
// 흐름:
//   1. refresh_token으로 새 access_token 발급
//   2. 카카오톡 메모 API로 발송 (object_type=text)
//   3. 새 refresh_token이 발급되면 stdout에 표시 (1년에 1번 정도)

const REST_API_KEY = process.env.KAKAO_REST_API_KEY;
const CLIENT_SECRET = process.env.KAKAO_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.KAKAO_REFRESH_TOKEN;

const message = process.argv.slice(2).join(' ') || (process.stdin.isTTY ? '' : null);
const LINK_URL = process.env.KAKAO_MEMO_LINK || 'https://gropass.co.kr';

async function refreshAccessToken() {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: REST_API_KEY,
    refresh_token: REFRESH_TOKEN,
  });
  if (CLIENT_SECRET) params.set('client_secret', CLIENT_SECRET);

  const res = await fetch('https://kauth.kakao.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`토큰 갱신 실패: ${JSON.stringify(data)}`);
  }
  if (data.refresh_token) {
    console.error('');
    console.error('::warning::새 refresh_token 발급됨 — GitHub secret 갱신 필요:');
    console.error(`::warning::${data.refresh_token}`);
  }
  return data.access_token;
}

async function sendMemo(accessToken, text) {
  const templateObject = {
    object_type: 'text',
    text: text.slice(0, 200),
    link: { web_url: LINK_URL, mobile_web_url: LINK_URL },
    button_title: '확인',
  };
  const params = new URLSearchParams({
    template_object: JSON.stringify(templateObject),
  });
  const res = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok || data.result_code !== 0) {
    throw new Error(`메모 발송 실패: ${JSON.stringify(data)}`);
  }
  return data;
}

async function main() {
  if (!REST_API_KEY || !REFRESH_TOKEN) {
    console.error('❌ KAKAO_REST_API_KEY, KAKAO_REFRESH_TOKEN 필요');
    process.exit(1);
  }
  if (!message || message.trim().length === 0) {
    console.error('❌ 메시지 내용 누락');
    console.error('   사용법: node send_kakao_memo.js "메시지"');
    process.exit(1);
  }

  const accessToken = await refreshAccessToken();
  await sendMemo(accessToken, message);
  console.log('✅ 카카오 메모 발송 완료');
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
