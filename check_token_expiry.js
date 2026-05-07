// check_token_expiry.js — IG + Threads 토큰 만료 자동 체크
//
// 사용법:
//   IG_TOKEN="..." node check_token_expiry.js
//   (Threads 토큰은 .threads-token.json 자동 로드)
//
// 동작:
//   - IG/Threads 토큰 만료까지 N일 계산
//   - 7일 미만 → SLACK_WEBHOOK_URL이 있으면 Slack 알림
//   - 어떤 토큰이 만료 임박이든 exit code 2 (cron이 fail로 표시)
//   - 정상은 exit 0

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IG_TOKEN_FILE = path.join(__dirname, '.ig-token-long.txt');
const THREADS_TOKEN_FILE = path.join(__dirname, '.threads-token.json');

const WARN_DAYS = 7;

async function readIG() {
  let token = process.env.IG_TOKEN;
  if (!token) {
    try {
      token = (await fs.readFile(IG_TOKEN_FILE, 'utf-8')).trim();
    } catch {
      return null;
    }
  }
  if (!token) return null;
  const url = new URL('https://graph.facebook.com/v19.0/debug_token');
  url.searchParams.set('input_token', token);
  url.searchParams.set('access_token', token);
  const r = await fetch(url);
  const data = await r.json();
  if (!r.ok || !data.data?.is_valid) {
    return { type: 'IG', valid: false, error: data.error?.message || 'invalid' };
  }
  const expAt = data.data.expires_at;
  if (!expAt || expAt === 0) {
    return { type: 'IG', valid: true, never_expires: true };
  }
  const days = Math.round((expAt * 1000 - Date.now()) / 86400000);
  return { type: 'IG', valid: true, days, expires_at: new Date(expAt * 1000).toISOString() };
}

async function readThreads() {
  let raw;
  try {
    raw = await fs.readFile(THREADS_TOKEN_FILE, 'utf-8');
  } catch {
    return null;
  }
  const cleaned = raw.replace(/^﻿/, '');
  const data = JSON.parse(cleaned);
  if (!data.expires_at) return null;
  const days = Math.round((new Date(data.expires_at).getTime() - Date.now()) / 86400000);
  return {
    type: 'Threads',
    valid: days > 0,
    days,
    expires_at: data.expires_at,
  };
}

async function notifySlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.error('Slack 알림 실패:', e.message);
  }
}

async function main() {
  console.log('━'.repeat(60));
  console.log('토큰 만료 체크');
  console.log('━'.repeat(60));

  const results = (await Promise.all([readIG(), readThreads()])).filter(Boolean);

  if (results.length === 0) {
    console.log('  체크할 토큰 없음 (IG_TOKEN env 또는 .threads-token.json 모두 누락)');
    process.exit(0);
  }

  const warnings = [];
  for (const r of results) {
    if (!r.valid) {
      console.log(`  ❌ ${r.type}: 무효 (${r.error || ''})`);
      warnings.push(`*${r.type} 토큰 무효* — 즉시 재발급 필요`);
      continue;
    }
    if (r.never_expires) {
      console.log(`  ✅ ${r.type}: 만료 없음`);
      continue;
    }
    const status = r.days < WARN_DAYS ? '⚠️' : r.days < 14 ? '🟡' : '✅';
    console.log(`  ${status} ${r.type}: ${r.days}일 남음 (만료: ${r.expires_at?.slice(0, 10)})`);
    if (r.days < WARN_DAYS) {
      warnings.push(
        `*${r.type} 토큰 만료 임박* — ${r.days}일 남음 (${r.expires_at?.slice(0, 10)}). 갱신 필요.`
      );
    }
  }

  if (warnings.length > 0) {
    const text = [
      ':rotating_light: *토큰 만료 알림 — 그로패스 인프라*',
      '',
      ...warnings,
      '',
      '갱신 가이드:',
      '  • IG: developers.facebook.com/tools/explorer/964777476173290 → 새 토큰 발급 → ig-token-exchange.ts 재실행',
      '  • Threads: setup_threads.js 또는 User Token Generator',
    ].join('\n');
    await notifySlack(text);
    process.exit(2);
  }

  console.log('');
  console.log('  모든 토큰 정상');
  process.exit(0);
}

main().catch((e) => {
  console.error('체크 실패:', e.message);
  process.exit(1);
});
