# GroPass 캐러셀 시안

그로패스 인스타그램 캐러셀 자동화를 위한 슬라이드 템플릿 5종 시안.

## 폴더 구조

```
gropass-carousel/
├── preview.html              ← 먼저 이걸 브라우저로 열기
├── slide_01_cover.html       표지
├── slide_02_info.html        개별 자금 소개
├── slide_03_list.html        한눈에 보기 리스트
├── slide_04_quote.html       핵심 인사이트 강조
└── slide_05_cta.html         마지막 CTA
```

## 시안 미리보기

브라우저에서 다음 파일을 열면 5종 전부 한 화면에서 확인 가능:

```
C:\Users\user\gropass-carousel\preview.html
```

## 디자인 시스템

| 항목 | 값 |
|---|---|
| 컬러 (메인) | `#0A1F44` 네이비 |
| 컬러 (액센트) | `#2563EB` 블루 |
| 컬러 (강조) | `#FCD34D` 옐로우 |
| 폰트 | Pretendard Variable (CDN) |
| 슬라이드 크기 | 1080 × 1080 (인스타 정사각) |

## 캐러셀 조합 예시

인스타 캐러셀은 보통 7~10장. 위 5종 템플릿을 조합:

| 구성 | 장수 | 패턴 |
|---|---|---|
| 표준 (정책자금 5선) | 9장 | cover → info×5 → list → quote → cta |
| 컴팩트 (Top 3) | 7장 | cover → info×3 → list → quote → cta |
| 인사이트 (개념 설명) | 6장 | cover → info×3 → quote → cta |

## 다음 단계 — 어떻게 사용할까?

### A. Canva에서 그대로 따라 만들기 (시각 디자인 작업)
1. preview.html을 보고 마음에 드는 시안 확정
2. Canva에서 빈 캔버스(1080×1080)로 동일한 디자인 재현
3. Brand Kit에 컬러·폰트 등록
4. Bulk Create로 텍스트만 바꿔서 양산

### B. HTML/CSS 그대로 자동화 (코드 기반)
1. 템플릿의 텍스트 부분을 변수화 (`{{title}}`, `{{body}}` 등)
2. Claude가 콘텐츠 JSON 생성
3. Puppeteer로 PNG 렌더링
4. Instagram Graph API로 게시

```bash
# 예시 스크립트 (구현 예정)
node render.js --template=cover --data=week_19.json
# → out/slide_01.png 생성
```

## 변경할 부분

- [ ] 컬러: 그로패스 사이트 실제 컬러로 정확히 매칭
- [ ] 로고: "G" 자리에 실제 로고 이미지로 교체
- [ ] 사용 폰트: 그로패스 사이트 폰트와 일치하는지 확인
- [ ] 카피: 실제 운영 시 사용할 톤으로 다듬기
