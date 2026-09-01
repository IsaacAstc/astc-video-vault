# ASTC Video Vault — Claude Code 작업 규칙

강의자료용 비디오 저장소. 명세는 `VIDEO_VAULT_SPEC.md`가 원본이며, 이 문서는
작업 규칙과 명세 이후 확정된 결정 사항을 기록한다.

## 1. 작업 규칙 (필수 준수)

1. **서버 측 검증 필수**: 명세 4절의 검증 규칙(확장자 `.mp4`, 파일당 500MB,
   총 8GB 임계치, 과정 분류 목록 존재 여부)은 Cloudflare Workers에서 반드시
   검증한다. 클라이언트 검사는 UX 보조일 뿐 대체 수단이 아니다.
2. **비밀키 금지**: 서비스 계정 키·R2 API 키는 코드·저장소에 절대 넣지 않는다.
   `wrangler secret` 이름으로만 참조하고 `.gitignore`에 키 파일 패턴을 포함한다.
3. **외부 프레임워크 금지**: Firebase SDK(CDN)와 wrangler만 허용.
   npm 런타임 의존성 0 — presigned URL(SigV4)도 WebCrypto로 직접 구현한다.
4. **언어**: 오류 메시지·주석은 한국어, 변수명·함수명은 영어.
5. **확인 필요 값**: 배포 시 실제 값 확인이 필요한 곳은 `// [확인 필요]` 주석으로 표시.
6. **LMS 저장소(IsaacAstc/lms) 파일은 절대 수정하지 않는다.** 참조만 한다.

## 2. firestore.rules 배포 원칙 (사고 방지 — 가장 중요)

- 한 Firebase 프로젝트의 규칙은 배포 시 **통째로 교체**된다. vault 규칙만 배포하면
  운영 중인 LMS가 마비된다.
- 따라서 **이 저장소의 `firestore.rules`가 프로젝트 전체의 유일한 배포 원본**이다.
  파일 구성: `[A] LMS 기존 규칙 원문(수정 금지)` + `[B] Video Vault 규칙`.
- LMS 규칙이 바뀌면 [A] 구간을 LMS 저장소 원문으로 통째로 교체한다.
- 배포 전 반드시 `./scripts/check-rules.sh`를 실행해 [A]·[B] 필수 블록 누락을
  검증한다. 실패 시 배포 금지.

## 3. 명세 이후 확정된 결정 사항 (사용자 승인 완료)

| # | 항목 | 결정 |
|---|---|---|
| 1 | "과정 분류" 정의 | LMS `programs` 컬렉션의 `name` 목록 (명세의 `[확인 필요]` 컬렉션명 = `programs`) |
| 2 | 과정 목록 전달 경로 | LMS 규칙상 회원이 직접 못 읽으므로 Workers `GET /courses` 엔드포인트 신설(서비스 계정 읽기 + 5분 캐시) |
| 3 | 규칙 배포 | 위 2절의 병합본 + 검증 스크립트 방식 |
| 4 | `users/{uid}` 생성 | 가입 직후 클라이언트가 생성, 규칙으로 `role=member`·`approved=false` 강제 |
| 5 | 도메인 강제 | 클라이언트(UX) + firestore.rules + Workers 3중 검증. 이메일 인증 메일은 사용 안 함(승인제가 최종 방어선) |
| 6 | vault 관리자 | `users.role == 'admin'`만 사용. LMS `admins` 컬렉션과 완전 별개 |
| 7 | Workers→Firestore | Admin SDK는 Workers에서 미동작 → 서비스 계정 JWT + Firestore REST API |
| 8 | presigned PUT | `Content-Length` 서명 조건 생략(브라우저 호환성) → `/upload/complete`의 R2 HEAD 검증으로 크기 강제, 초과 시 객체 삭제+거부 (명세 4절과 다른 구현 — 목적은 동일) |
| 9 | pending 고아 정리 | `/upload/init` 호출 시 24시간 지난 pending 문서·객체 lazy 삭제 |
| 10 | totalBytes 동시성 | Firestore `FieldTransform(increment)` 사용 |
| 11 | 외부 의존성 | 당초 aws4fetch 예외 승인 → 이후 "외부 프레임워크 금지" 지시로 강화되어 **SigV4 직접 구현(의존성 0)** 으로 확정 |
| 12 | Firebase config | `docs/js/firebase.js`에 커밋(공개값). LMS의 gitignore 정책과 다르나 명세 확정 사항 |
| 13 | 멀티테넌트 | 허브(기본) 프로젝트 단일 대상, `?org=` 미지원 |
| 14 | 프로젝트 ID | 저장소에서 실제 값 확인 불가 → placeholder + `[확인 필요]` 주석 |
| 15 | 다운로드 파일명 | `제목.mp4` (RFC 5987 `filename*` 한글 인코딩) |
| 16 | `meta/storage` 읽기 | 승인 회원만 (전체 공개 아님 — 명세 4절 "읽기 허용"보다 좁게) |

## 3-1. 명세 이후 기능 추가 내역

| 일자 | 기능 | 내용 |
|---|---|---|
| 2026-08 | 기존 Auth 계정 첫 로그인 처리 | LMS 관리자 등 기존 계정이 가입 절차 없이 로그인하면 `users/{uid}` 문서를 자동 생성해 승인 대기로 전환 (`index.html`) |
| 2026-08 | 일괄 업로드 | `upload.html` 다중 선택·드래그&드롭. 파일별 제목 편집(파일명 기본값)·순차 `init→PUT→complete`·개별 실패 시 계속 진행·남은 용량 사전 표시. **Workers·규칙 변경 없음** — 서버 측 검증은 파일 단위로 그대로 적용 |
| 2026-08 | LMS 규칙 동기화 자동화 | `.github/workflows/sync-lms-rules.yml` + `scripts/sync-lms-rules.py`: 매일 09:00 KST LMS 원문 대조 → [A] 구간 갱신 PR 자동 생성(검증 통과 시). 게시는 여전히 수동 |
| 2026-09 | 규칙 동기화·배포 브랜치 통합 | 동기화 워크플로를 PR 방식 → **main 직접 커밋 + 규칙 자동 배포**로 변경. 검증(check-rules.sh) 통과 시에만 커밋·배포하며, `FIREBASE_SERVICE_ACCOUNT`/`FIREBASE_PROJECT_ID` 시크릿 미등록 시 커밋까지만 수행(수동 배포 안내). 수동 실행 시에는 변경이 없어도 재배포 |

## 4. 아키텍처 요약

```
브라우저(GitHub Pages /docs) ── Firebase Auth(ID 토큰) / Firestore(규칙 통제)
        │ Authorization: Bearer <ID 토큰>
        ▼
Cloudflare Workers(worker/) ── 토큰 검증(JWKS) → users/{uid} 역할·승인 확인
        │                      → presigned URL 발급 / 삭제 / 용량 집계 / 과정 목록
        ▼
Cloudflare R2 (astc-videos) ←─ 브라우저가 presigned URL로 직접 PUT/GET
```

- 업로드·다운로드 본문은 Workers를 거치지 않는다(100MB 본문 제한 회피, R2 egress 무료).
- Workers 시크릿: `FIREBASE_SERVICE_ACCOUNT`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID` (이름만 참조, 값은 wrangler secret).

## 5. 커밋 규칙

- 단계(worker / rules / docs / README) 완료마다 의미 있는 한국어 커밋 메시지로 커밋.
- push는 사용자 지시가 있을 때만 수행한다.
