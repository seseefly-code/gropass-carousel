// lib/post_queue.js — 아침 배치가 만든 하루치 게시 큐 읽기/쓰기
//
// .post_queue.json 구조:
//   {
//     "date": "YYYY-MM-DD",
//     "generated_at": "ISO8601",
//     "slots": {
//       "<slot>": { "status": "approved", "topic": "...", "post": {...}, "verdict": {...} }
//              또는 { "status": "rejected", "topic": "...", "reason": "fail|review|no_verdict" }
//     }
//   }

import { promises as fs } from 'fs';

/**
 * 큐에서 해당 슬롯의 승인된 항목을 꺼낸다.
 * 큐 날짜가 today와 다르거나, 슬롯이 없거나, status가 approved가 아니거나,
 * post 필드가 없으면 null을 반환한다 (호출자는 폴백).
 * @param {object|null} queueData - readQueue() 결과
 * @param {string} slot
 * @param {string} today - "YYYY-MM-DD"
 * @returns {{status:string, topic:string, post:object, verdict:object}|null}
 */
export function selectFromQueue(queueData, slot, today) {
  if (!queueData || queueData.date !== today) return null;
  const entry = queueData.slots ? queueData.slots[slot] : null;
  if (!entry || entry.status !== 'approved' || !entry.post) return null;
  return entry;
}

/**
 * .post_queue.json 읽기. 파일이 없으면 null.
 * @param {string} filePath
 * @returns {Promise<object|null>}
 */
export async function readQueue(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * .post_queue.json 쓰기 (2-space pretty).
 * @param {string} filePath
 * @param {object} queueData
 */
export async function writeQueue(filePath, queueData) {
  await fs.writeFile(filePath, JSON.stringify(queueData, null, 2), 'utf-8');
}
