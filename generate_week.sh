#!/bin/bash
# generate_week.sh — 다음 7일치 인스타 캐러셀 미리 생성
set -e

START="${1:-$(date -v+1d -u +%Y-%m-%d 2>/dev/null || date -u -d 'tomorrow' +%Y-%m-%d)}"

get_topic() {
  case "$1" in
    1) echo "이번 주 마감 임박 정책자금 5선" ;;
    2) echo "정책자금 신청 시 사장님들이 자주 놓치는 5가지 포인트" ;;
    3) echo "음식점·카페 사장님이 챙겨야 할 정책자금 5선" ;;
    4) echo "최근 매칭된 사장님 케이스 5가지 — 어떤 자금 받았나" ;;
    5) echo "이번 주 신청 시작한 정책자금 모음 5선" ;;
    6) echo "사장님이 알아야 할 정책자금 핵심 숫자 5가지" ;;
    7) echo "정책자금 자주 묻는 질문 5가지 — 사장님 1주일 정리" ;;
  esac
}

get_dow_name() {
  case "$1" in
    1) echo "월" ;;
    2) echo "화" ;;
    3) echo "수" ;;
    4) echo "목" ;;
    5) echo "금" ;;
    6) echo "토" ;;
    7) echo "일" ;;
  esac
}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "다음 7일치 캐러셀 생성"
echo "  시작일: $START"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

for i in 0 1 2 3 4 5 6; do
  DATE=$(date -j -v+${i}d -f "%Y-%m-%d" "$START" +"%Y-%m-%d" 2>/dev/null || date -d "$START + $i days" +"%Y-%m-%d")
  DOW=$(date -j -f "%Y-%m-%d" "$DATE" +"%u" 2>/dev/null || date -d "$DATE" +"%u")
  TOPIC=$(get_topic "$DOW")
  DOW_NAME=$(get_dow_name "$DOW")

  echo ""
  echo "[$DATE $DOW_NAME] $TOPIC"
  node generate.js "$TOPIC" 2>&1 | grep -E "주제|carousel_id|저장|입력 토큰|출력 토큰|에러" | head -6
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "PNG 렌더링"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
for f in $(ls -t data/*.json 2>/dev/null | grep -v 'announcements' | head -7); do
  echo ""
  echo "→ $f"
  node render.js "$f" 2>&1 | grep -E "캐러셀 ID|렌더 완료" | head -2
done
