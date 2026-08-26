# ASTC Video Vault — 개발 명세서 (Claude Code 입력용)

> 강의자료용 비디오 파일 저장소. 회원가입·관리자 승인·업로드·스트리밍 재생·다운로드 지원.
> 무료 티어만 사용. 기존 교육운영시스템(LMS)과 별도 저장소, Firebase 프로젝트는 공유.

---

## 1. 확정 사항

| 항목 | 값 |
|---|---|
| GitHub 저장소명 | `astc-video-vault` |
| GitHub 계정 | `IsaacAstc` |
| 프론트 호스팅 | GitHub Pages (`https://isaacastc.github.io/astc-video-vault/`) |
| 인증 | Firebase Authentication — 이메일/비밀번호만 |
| Firebase 프로젝트 | 기존 LMS 프로젝트 재사용, 프로젝트 ID `astc-lms` |
| 가입 허용 도메인 | `@airport.co.kr` 만 허용 |
| 가입 승인 | 관리자 승인 후 사용 가능 |
| 권한 | `admin`(업로드·삭제·승인·회원관리), `member`(목록·재생·다운로드) |
| 메타데이터 DB | Firebase Firestore |
| 파일 저장 | Cloudflare R2 버킷 `astc-videos` |
| API | Cloudflare Workers (`*.workers.dev`, 커스텀 도메인 미사용) |
| 개별 파일 상한 | 500 MB |
| 허용 확장자 | `.mp4` 만 |
| 총 저장량 임계치 | 8 GB 도달 시 업로드 거부 (R2 무료 10 GB 대비 여유분) |
| 재생 | 브라우저 내 스트리밍 재생 + 다운로드 버튼 둘 다 |
| 수집 개인정보 | 이메일(로그인 계정), 표시명(이름) — 그 외 수집 금지 |
| UI | 한국어 단일, vanilla HTML/CSS/JS, 기존 LMS 스타일 계열 |
| 과정 분류 | 기존 LMS(`astc-lms`)의 과정 분류 목록과 동일 — Firestore 기존 컬렉션에서 읽어 사용, 별도 하드코딩 금지 (컬렉션명 `[확인 필요]`) |

---

## 2. 아키텍처

```
브라우저 (GitHub Pages, 정적)
   │  Firebase Auth (ID 토큰)
   │  Firestore (메타데이터 읽기/쓰기 — Security Rules로 통제)
   ▼
Cloudflare Workers (API)
   │  ID 토큰 검증 → 역할 확인 → presigned URL 발급 / 삭제 / 용량 집계
   ▼
Cloudflare R2 (astc-videos)  ←── 브라우저가 presigned URL로 직접 PUT / GET
```

- 업로드 본문은 **Workers를 거치지 않고** 브라우저 → R2 직접 전송 (Workers 요청 본문 100 MB 제한 회피).
- 다운로드·스트리밍도 presigned GET URL 사용 (만료 시간 짧게, 예: 1시간).

---

## 3. 데이터 모델 (Firestore)

### `users/{uid}`
| 필드 | 타입 | 설명 |
|---|---|---|
| email | string | 로그인 이메일 |
| displayName | string | 표시명 |
| role | `"admin"` \| `"member"` | 기본 `member` |
| approved | boolean | 기본 `false`, 관리자 승인 시 `true` |
| createdAt | timestamp | |

### `videos/{videoId}`
| 필드 | 타입 | 설명 |
|---|---|---|
| title | string | 제목 |
| course | string | 과정 분류 (1절 목록 중 하나) |
| description | string | 설명 (선택) |
| objectKey | string | R2 객체 키 `videos/{videoId}.mp4` |
| sizeBytes | number | 파일 크기 |
| uploaderUid | string | |
| uploaderName | string | 표시명 스냅샷 |
| createdAt | timestamp | |
| status | `"pending"` \| `"ready"` | presigned 발급 시 `pending`, 업로드 완료 확인 후 `ready` |

### `meta/storage`
| 필드 | 타입 | 설명 |
|---|---|---|
| totalBytes | number | `status == ready` 파일 합계, Workers가 갱신 |

---

## 4. Workers API

모든 엔드포인트: `Authorization: Bearer <Firebase ID 토큰>` 필수.
Workers는 Firebase 공개키(JWKS)로 토큰 서명 검증 후 `users/{uid}`의 `role`, `approved` 확인.

| 메서드 | 경로 | 권한 | 동작 |
|---|---|---|---|
| POST | `/upload/init` | admin | 요청 본문 `{title, course, description, sizeBytes, contentType}` 검증 → 조건 미충족 시 4xx → `videos` 문서 생성(`pending`) → presigned PUT URL 반환 (`Content-Length` 서명 조건 포함, 만료 15분) |
| POST | `/upload/complete` | admin | `videoId` 수신 → R2 `HEAD`로 실제 크기 확인 → `status=ready`, `meta/storage.totalBytes` 갱신 |
| GET | `/videos/:id/url` | member(approved) | presigned GET URL 반환 (만료 1시간). 쿼리 `?download=1` 시 `Content-Disposition: attachment` 지정 |
| DELETE | `/videos/:id` | admin | R2 객체 삭제 → Firestore 문서 삭제 → `totalBytes` 차감 |
| GET | `/storage` | member | `{totalBytes, limitBytes}` 반환 (UI 게이지용) |

### `/upload/init` 검증 규칙 (서버 측 필수)
1. `contentType == "video/mp4"` 이고 파일명 확장자 `.mp4`
2. `sizeBytes <= 500 * 1024 * 1024`
3. `meta/storage.totalBytes + sizeBytes <= 8 * 1024 * 1024 * 1024`
4. `course` 값이 기존 LMS 과정 분류 목록(Firestore)에 존재
5. 위반 시 `400/413/507` 와 한국어 오류 메시지 반환

### Firestore Security Rules 요지
- `users/{uid}`: 본인 읽기 가능, `role`·`approved` 는 클라이언트에서 쓰기 불가 (Workers 또는 admin만)
- `videos`: `approved == true` 인 사용자 읽기 가능, 쓰기는 Workers(Admin SDK 또는 서비스 계정)만
- `meta/storage`: 읽기 허용, 쓰기 금지

---

## 5. 프론트 화면 (GitHub Pages)

| 파일 | 기능 |
|---|---|
| `index.html` | 로그인 / 회원가입 (도메인 검사, 표시명 입력) |
| `pending.html` | 승인 대기 안내 |
| `list.html` | 비디오 목록 — 과정별 필터, 제목 검색, 총 사용량 게이지 |
| `watch.html?id=` | `<video>` 스트리밍 재생 + 다운로드 버튼 |
| `upload.html` | (admin) 업로드 폼 — 클라이언트 측 사전 검사 후 `/upload/init` → PUT → `/upload/complete`, 진행률 표시 |
| `admin.html` | (admin) 회원 승인·역할 변경, 비디오 삭제 |
| `js/firebase.js` | Firebase 초기화 (config는 공개값) |
| `js/api.js` | Workers 호출 래퍼 (토큰 자동 첨부) |
| `css/style.css` | 기존 LMS 스타일 계열 |

---

## 6. 저장소 구조

```
astc-video-vault/
├── docs/                 # GitHub Pages 소스 (Settings → Pages → /docs)
│   ├── *.html, js/, css/
├── worker/
│   ├── src/index.js      # Workers 라우팅·검증·presigned 발급
│   ├── wrangler.toml     # R2 바인딩, 환경변수 이름만 (값은 secret)
│   └── package.json
├── firestore.rules
├── firebase.json
├── README.md             # 배포 절차 (아래 7절)
└── CLAUDE.md             # Claude Code 작업 규칙
```

---

## 7. 배포 절차 (README에 포함)

1. GitHub 저장소 생성 → Settings → Pages → Source: `main` / `/docs`
2. Firebase 콘솔 → 기존 프로젝트 → 웹 앱 추가 → config 복사 → `docs/js/firebase.js`
3. Firebase → Authentication → 이메일/비밀번호 활성화 → 승인 도메인에 Pages 도메인 추가
4. Firebase → 프로젝트 설정 → 서비스 계정 → 키 발급 → Workers secret으로 등록 (`FIREBASE_SERVICE_ACCOUNT`)
5. Cloudflare 가입 → R2 활성화 및 결제수단 등록 (완료) → 버킷 `astc-videos` 생성
6. R2 버킷 CORS: `AllowedOrigins = [Pages 도메인]`, `AllowedMethods = [GET, PUT, HEAD]`
7. R2 API 토큰 발급 → Workers secret (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`)
8. `cd worker && npm i && npx wrangler login && npx wrangler deploy`
9. 배포된 `https://astc-video-vault.<Cloudflare 계정명>.workers.dev` 를 `docs/js/api.js` 의 `API_BASE`에 기입
10. `firebase deploy --only firestore:rules`
11. 첫 관리자: Firestore 콘솔에서 본인 `users/{uid}` 의 `role=admin, approved=true` 수동 지정

---

## 8. 제외 범위 (MVP 이후)

- 썸네일 자동 생성, 조회수·통계, 커스텀 도메인, 멀티파트 대용량 업로드, 댓글

---

## 9. 비기능 요건

- 비밀키·서비스 계정 키는 절대 저장소에 커밋하지 않음 (`.gitignore`, `wrangler secret`)
- 모든 오류 메시지 한국어
- 코드 주석 한국어, 변수명 영어
- 외부 프레임워크 없음 (Firebase SDK CDN, wrangler만 허용)

---

## 10. 근거 링크

- GitHub Pages 제한: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- R2 요금·무료 한도: https://developers.cloudflare.com/r2/pricing/
- R2 presigned URL: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- R2 CORS: https://developers.cloudflare.com/r2/buckets/cors/
- Workers 제한(본문 100 MB): https://developers.cloudflare.com/workers/platform/limits/
- Wrangler 설치: https://developers.cloudflare.com/workers/wrangler/install-and-update/
- Firebase ID 토큰 검증: https://firebase.google.com/docs/auth/admin/verify-id-tokens
