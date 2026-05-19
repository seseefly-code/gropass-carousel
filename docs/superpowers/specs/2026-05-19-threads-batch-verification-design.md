# 스레드 자동 게시 — Generate-Ahead 배치 검증 설계

- 작성일: 2026-05-19
- 상태: 승인됨 (구현 대기)
- 관련: `auto_post.js`, `verify_thread.js`, `.github/workflows/threads-cron.yml`

## 1. 배경 / 문제

현재 스레드 자동 게시는 슬롯마다 독립 실행된다:

```
cron(슬롯) → 주제 선정 → 생성(Opus 4.7) → 검증(Sonnet 4.6) → 즉시 게시
```

이 구조에서 두 가지 비용 문제가 있다:

1. **생성 모델이 Opus 4.7** — 글 1건당 가장 비싼 모델 호출.
2. **검증이 슬롯마다 별도 호출** — 검증 시스템 프롬프트(페르소나, few-shot 실패 사례, 톤 가이드)와 공고 컨텍스트라는 무거운 입력을 하루 10번 매번 재전송.

검증 에이전트 도입 후 글 1건당 API 호출이 2회(생성+검증)로 늘면서 크레딧 소진 속도가 빨라졌고, 2026-05-18 Anthropic API 크레딧 잔액 소진으로 게시가 중단됐다.

## 2. 목표 / 비목표

**목표**

- 글 1건당 생성 비용을 대폭 낮춘다 (생성 모델을 Sonnet으로).
- 검증의 반복 컨텍스트 전송을 제거한다 (하루 1회 배치 검증).
- 검증 품질·안전성을 유지하거나 강화한다 (계정 밴 리스크가 최우선).

**비목표**

- API 크레딧 충전 자체는 이 설계의 범위가 아니다. 본 설계는 충전 이후의 소진 속도를 낮추는 것이다.
- Message Batches API(비동기, 50% 할인) 적용은 향후 과제로 둔다 (5절 참고).

## 3. 확정된 결정

| 항목 | 결정 | 근거 |
|---|---|---|
| 주제 확정 시점 | 아침에 하루 10개 전부 확정 (full generate-ahead) | 배치 검증은 10개가 모두 존재해야 가능 |
| 생성 모델 | Sonnet 4.6 | Opus 대비 약 1/5 단가, 비용 절감의 본체 |
| 검증 모델 | Opus 4.7 | 배치화로 하루 1회 호출이라 Opus도 감당 가능. 생성≠검증 교차체크 회복 |
| 배치 실패 시 | 슬롯별 단건 생성으로 폴백 | 아침 배치가 죽어도 서비스 중단 없음 |
| review 판정 글 | fail과 함께 큐에서 제외 → 슬롯에서 폴백 재생성 | 빈 슬롯 방지, 운영 단순화 |

생성(Sonnet)과 검증(Opus)에 서로 다른 모델을 쓰는 이유: 검증자가 생성자와 같은 모델이면 같은 착각을 그대로 통과시킬 수 있다. 배치화 덕에 "싸고 빠른 모델이 많이 쓰고, 똑똑한 모델이 한 번에 검사"하는 구조가 된다.

## 4. 아키텍처

워크플로우를 2개로 분리한다.

### 4.1 아침 배치 작업 (신규)

워크플로우 `threads-batch.yml`, cron `0 21 * * *` (06:00 KST — 첫 게시 슬롯 07:00 KST보다 1시간 앞).

```
crawl.js (공고 갱신)
  → 슬롯 10개 각각: 주제 선정(기존 가중치 로직) → Sonnet 4.6 생성
  → Opus 4.7 배치 검증 1회 (10개 글 + 공고 컨텍스트 + 최근 thread 이력)
  → pass → 큐 저장 / fail·review → 제외 + 카카오 알림 1건
  → .post_queue.json 커밋
```

- 생성은 10회 개별 Sonnet 호출(슬롯당 1회). 한 번에 10개를 만드는 단일 호출이 아니라, 각 글이 모델의 온전한 주의를 받도록 분리한다.
- 생성 시스템 프롬프트(`prompts/system_threads.md`)는 `cache_control`로 10회 호출 간 캐시 재사용한다.
- 검증은 10개 글을 한 번에 받는 Opus 단일 호출. 무거운 컨텍스트(시스템 프롬프트 + few-shot + 공고)를 1회만 전송한다.

### 4.2 게시 cron (기존 수정)

워크플로우 `threads-cron.yml` — 트리거(슬롯 10개 cron)는 그대로. `auto_post.js`의 동작만 변경한다.

```
슬롯 시각 → .post_queue.json에서 [오늘 날짜][이 슬롯] 조회
  ├─ status=approved → 큐의 글을 바로 게시 (생성·검증 스킵)
  └─ 큐 없음 / status≠approved → 폴백
       → Sonnet 단건 생성 → Opus 단건 검증 → 게시
       (= 기존 파이프라인을 폴백 경로로 유지)
```

폴백이 트리거되는 경우: 아침 배치 통째 실패(큐 파일 없음/오래됨), 또는 해당 슬롯 글이 fail·review로 탈락. 두 경우 모두 슬롯 시각에 단건으로 새로 만들어 채운다.

## 5. 데이터 모델

신규 파일 `.post_queue.json` (리포 루트, 배치 작업이 커밋):

```json
{
  "date": "2026-05-20",
  "generated_at": "2026-05-20T21:05:00Z",
  "slots": {
    "early_morning": {
      "status": "approved",
      "post": { "post_type": "...", "main_post": "...", "reasoning": "...", "char_count": 0 },
      "verdict": { "decision": "pass", "score": 9, "fact": 9, "halluc": 9, "dup": 7, "tone": 9, "issues": [] }
    },
    "morning": { "status": "rejected", "reason": "fail" }
  }
}
```

- `status`: `approved` | `rejected`.
- `auto_post.js`는 `slots[slot].status === "approved"` 이고 `date`가 오늘일 때만 큐의 글을 사용한다. 그 외 전부 폴백.
- `date` 불일치(전날 큐가 남아있는 경우)도 폴백으로 처리해 오래된 글 게시를 막는다.

## 6. 컴포넌트 / 파일 변경

| 파일 | 변경 | 내용 |
|---|---|---|
| `generate_batch.js` | 신규 | 아침 배치: crawl → 10개 생성 → 배치 검증 → `.post_queue.json` 작성. 주제 선정·생성 로직은 `auto_post.js`에서 추출/재사용 |
| `verify_thread.js` | 수정 | `verifyBatch(posts[], ctx)` 함수 추가. 스키마는 10개 verdict 배열(슬롯 키로 매핑). 모델은 Opus 4.7. 기존 `verifyThread()`(단건, Sonnet→Opus 검증)는 폴백용으로 유지 |
| `auto_post.js` | 수정 | 슬롯 시각에 큐 우선 조회 → 히트 시 바로 게시, 미스 시 기존 파이프라인 폴백. 폴백 생성 모델 Opus→Sonnet |
| `.github/workflows/threads-batch.yml` | 신규 | cron `0 21 * * *` (06:00 KST). crawl + `generate_batch.js` 실행. 시크릿 env는 `threads-cron.yml`과 동일 구성 |
| `.github/workflows/threads-cron.yml` | 변경 없음 | 트리거 그대로. `auto_post.js` 내부에서 큐/폴백 분기 처리 |

재사용 원칙: 주제 가중치 로직, 생성 프롬프트, 검증 프롬프트·판정 기준은 전부 기존 코드를 재사용한다. "배치"는 본질적으로 오케스트레이션 + 배열 형태의 검증 스키마다.

## 7. 검증 스키마 (배치)

기존 단건 `VERIFY_SCHEMA`(fact_check / hallucination_check / duplication_check / tone_check / overall)를 슬롯별로 묶은 배열/맵 구조로 확장한다. 슬롯 식별자와 함께 10개 verdict를 반환한다.

배치 검증의 부수 효과: 검증자가 10개 글을 동시에 보므로 **같은 날 글끼리의 중복**(예: 벤처인증 보증한도 글이 5/8·5/13 양일 게시된 케이스)을 구조적으로 잡는다. 슬롯별 독립 검증으로는 불가능했던 부분이다.

주의: 정수 score 필드에 JSON 스키마 `minimum`/`maximum`를 쓰지 않는다. Anthropic structured output은 integer에 min/max를 허용하지 않으므로 범위는 `description`으로 표현한다 (2026-05-16 회귀 버그의 원인).

## 8. 실패 처리

| 상황 | 동작 |
|---|---|
| 아침 배치 통째 실패 (크레딧/API 다운) | 큐 파일 미작성 → 모든 슬롯이 폴백으로 단건 게시. 서비스 유지 |
| 아침 배치 부분 실패 (일부 글 fail/review) | 해당 슬롯만 폴백 재생성 |
| 폴백 자체 실패 (예: 크레딧 소진) | 해당 슬롯 게시 실패 — 현재와 동일한 최저 한계선 |

## 9. 비용 분석 (정성적)

- **생성**: Opus 10회 → Sonnet 10회. Sonnet 단가가 약 1/5 → 생성 비용 대폭 감소. 절감의 본체.
- **검증**: Sonnet 10회(매번 무거운 컨텍스트 재전송) → Opus 1회(컨텍스트 1회 전송 + 작은 글 10개). 전송 토큰량이 급감하고 Opus 단가 상승이 이를 상쇄 → 비슷하거나 소폭 변동.
- **폴백**: 실패한 날에만 작동 → 평소 비용에 거의 영향 없음.
- 향후: Message Batches API 적용 시 검증 호출에 추가 50% 할인. 단 비동기(최대 24h SLA)라 06:00 배치가 07:00 첫 슬롯 전에 끝나야 하는 타이밍 제약과 충돌 가능 → 본 설계에서는 동기 호출, 배치 API는 별도 검토.

## 10. 테스트

- `generate_batch.js` dry-run 모드: 생성·검증·큐 작성까지 하고 게시는 스킵 (기존 `--dry-run` 관례 따름).
- `threads-batch.yml` `workflow_dispatch`로 수동 실행 검증.
- `.post_queue.json` 형태 검증, `date` 불일치 시 폴백 동작 확인.
- 큐 미스 시 `auto_post.js` 폴백 경로가 실제로 트리거되는지 확인.

## 11. 범위 밖 / 향후

- API 크레딧 충전 (운영 조치, 코드 무관).
- Message Batches API 50% 할인 적용 (9절).
- cron jitter를 통한 AI 감지 회피.
- review 항목을 위한 Notion 리뷰 큐 연동 (review를 폴백 재생성으로 처리하기로 결정해 현재 불필요).
