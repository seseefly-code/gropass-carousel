// lib/kst_date.js — KST(Asia/Seoul) 기준 날짜 문자열
//
// GitHub Actions 러너는 UTC로 동작한다. 아침 배치(UTC 21:00 = KST 06:00)와
// 게시 슬롯 cron(UTC 자정 전후로 분산)이 같은 "오늘"을 가리키려면 KST 달력 날짜를 써야 한다.

/**
 * 현재 시각의 KST(UTC+9) 달력 날짜를 "YYYY-MM-DD"로 반환한다.
 * @returns {string}
 */
export function kstDateStr() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
