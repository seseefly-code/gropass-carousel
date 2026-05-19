import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectFromQueue } from '../lib/post_queue.js';

const queue = {
  date: '2026-05-20',
  slots: {
    morning: {
      status: 'approved',
      topic: '벤처인증 보증한도',
      post: { post_type: '오해풀기', main_post: '본문', char_count: 120, reasoning: 'r' },
      verdict: { overall: { score: 9, decision: 'pass' } },
    },
    noon: { status: 'rejected', topic: 't', reason: 'fail' },
  },
};

test('approved 슬롯은 entry 전체를 반환', () => {
  const r = selectFromQueue(queue, 'morning', '2026-05-20');
  assert.equal(r.post.main_post, '본문');
  assert.equal(r.topic, '벤처인증 보증한도');
});

test('rejected 슬롯은 null', () => {
  assert.equal(selectFromQueue(queue, 'noon', '2026-05-20'), null);
});

test('큐에 없는 슬롯은 null', () => {
  assert.equal(selectFromQueue(queue, 'night', '2026-05-20'), null);
});

test('큐 날짜가 today와 다르면 null (오래된 큐 게시 방지)', () => {
  assert.equal(selectFromQueue(queue, 'morning', '2026-05-21'), null);
});

test('큐 데이터가 null이면 null', () => {
  assert.equal(selectFromQueue(null, 'morning', '2026-05-20'), null);
});

test('post 필드가 없는 approved 항목은 null', () => {
  const bad = { date: '2026-05-20', slots: { morning: { status: 'approved', topic: 't' } } };
  assert.equal(selectFromQueue(bad, 'morning', '2026-05-20'), null);
});
