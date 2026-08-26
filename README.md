# ASTC Video Vault

강의자료용 비디오 파일 저장소. 회원가입 → 관리자 승인 → 목록/스트리밍 재생/다운로드,
관리자는 업로드·삭제·회원관리. 무료 티어만 사용(GitHub Pages + Firebase Spark + Cloudflare Workers/R2).

- 명세: [`VIDEO_VAULT_SPEC.md`](VIDEO_VAULT_SPEC.md) · 작업 규칙과 확정 결정: [`CLAUDE.md`](CLAUDE.md)

## 구조

```
docs/                 # 프론트 (GitHub Pages, 정적 HTML/CSS/JS)
  index.html          #   로그인·회원가입
  pending.html        #   승인 대기 안내
  list.html           #   비디오 목록(과정 필터·검색·용량 게이지)
  watch.html          #   스트리밍 재생 + 다운로드
  upload.html         #   (admin) 업로드
  admin.html          #   (admin) 회원 승인·역할 변경·비디오 삭제
  js/firebase.js      #   Firebase 초기화(공개 config)
  js/api.js           #   Workers 호출 래퍼(토큰 자동 첨부)
  js/guard.js         #   화면 게이트·공용 유틸
  css/style.css       #   기존 LMS 스타일 계열
worker/               # Cloudflare Workers API (런타임 의존성 0)
  src/index.js        #   토큰 검증·서버측 검증·presigned URL(SigV4 자체구현)
  wrangler.toml       #   R2 바인딩·환경변수(시크릿은 이름만)
firestore.rules       # ⚠️ LMS 규칙 + Vault 규칙 병합본 — 프로젝트 유일 배포 원본
scripts/check-rules.sh# 규칙 배포 전 필수 검증
firebase.json         # rules 배포 설정
```

## API (Workers)

모든 엔드포인트는 `Authorization: Bearer <Firebase ID 토큰>` 필수.
토큰 서명(JWKS) 검증 후 `users/{uid}`의 `approved`·`role`을 확인한다.

| 메서드 | 경로 | 권한 | 동작 |
|---|---|---|---|
| POST | `/upload/init` | admin | 서버측 검증(mp4·500MB·8GB·과정목록) → `pending` 문서 생성 → presigned PUT(15분) |
| POST | `/upload/complete` | admin | R2 HEAD로 실제 크기 검증(초과 시 삭제+거부) → `ready` 전환·`totalBytes` 가산 |
| GET | `/videos/:id/url` | 승인 회원 | presigned GET(1시간). `?download=1` 시 `제목.mp4` 첨부 다운로드 |
| DELETE | `/videos/:id` | admin | R2 객체·문서 삭제, `totalBytes` 차감 |
| GET | `/storage` | 승인 회원 | `{totalBytes, limitBytes}` (UI 게이지) |
| GET | `/courses` | 승인 회원 | LMS `programs` 컬렉션의 과정명 목록(5분 캐시) — 명세 외 추가 엔드포인트 |

명세 4절과 다른 구현 2건(사전 승인, CLAUDE.md 3절 #8·#2):
presigned PUT의 `Content-Length` 서명 조건은 브라우저 호환성 문제로 생략하고
`/upload/complete`의 HEAD 검증으로 크기를 강제하며, 과정 목록은 LMS 보안규칙상
회원이 직접 읽을 수 없어 `GET /courses`를 신설했다.

## 배포 절차

### 1. GitHub Pages

1. 이 저장소 → Settings → Pages → Source: `main` 브랜치 / `/docs` 폴더.
2. 배포 주소: `https://isaacastc.github.io/astc-video-vault/`

### 2. Firebase (기존 LMS 프로젝트 공유)

1. Firebase 콘솔 → 기존 LMS 프로젝트 → 프로젝트 설정 → **웹 앱 추가** → config 복사.
2. `docs/js/firebase.js`의 `firebaseConfig`를 실제 값으로 교체하고,
   `worker/wrangler.toml`의 `FIREBASE_PROJECT_ID`를 같은 프로젝트 ID로 맞춘다.
   *(config는 공개값이므로 커밋해도 된다 — 방어선은 보안규칙과 Workers)*
3. Authentication → 로그인 방법 → **이메일/비밀번호 활성화**.
4. Authentication → 설정 → 승인된 도메인에 `isaacastc.github.io` 추가.
5. 프로젝트 설정 → 서비스 계정 → **새 비공개 키 발급**(JSON).
   이 파일은 절대 커밋하지 말고 아래 4단계에서 wrangler secret으로만 등록한다.

### 3. Cloudflare R2 (계정·결제수단 등록 완료 전제)

1. 대시보드 → R2 → **버킷 생성**: 이름 `astc-videos`, 위치 자동. *(이미 있으면 생략)*
2. 버킷 → Settings → **CORS policy**:
   ```json
   [
     {
       "AllowedOrigins": ["https://isaacastc.github.io"],
       "AllowedMethods": ["GET", "PUT", "HEAD"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
3. R2 → **API 토큰 관리** → 토큰 생성(권한: 객체 읽기·쓰기, 버킷 `astc-videos` 한정 권장)
   → Access Key ID / Secret Access Key / 계정 ID 확보.

### 4. Workers 배포

```bash
cd worker
npm install          # devDependency(wrangler)만 설치된다
npx wrangler login
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT   # 서비스 계정 키 JSON 전문 붙여넣기
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler deploy
```

배포된 주소 `https://astc-video-vault.<계정명>.workers.dev`를
`docs/js/api.js`의 `API_BASE`에 기입하고 커밋한다.

### 5. Firestore 보안규칙 배포 — ⚠️ 반드시 검증 후

이 저장소의 `firestore.rules`는 **LMS 규칙 원문 + Vault 규칙의 병합본**이며
프로젝트의 유일한 배포 원본이다. 규칙은 배포 시 통째로 교체되므로,
LMS 구간이 누락된 채 배포하면 운영 중인 LMS가 마비된다.

```bash
./scripts/check-rules.sh                      # 통과(✅) 확인 후에만 진행
firebase deploy --only firestore:rules
```

LMS 쪽 규칙이 변경되면: LMS 저장소의 firestore.rules 원문으로 이 파일의
`[A]` 구간을 통째로 교체 → 검증 → 재배포.

### 6. 첫 관리자 지정

1. 배포된 사이트에서 관리자 본인이 회원가입.
2. Firebase 콘솔 → Firestore → `users/{본인 uid}` 문서를 열어
   `role: "admin"`, `approved: true`로 수동 변경.
3. 이후 회원 승인·역할 변경은 사이트의 **관리** 화면에서 처리한다.

## 데이터 모델 (Firestore)

- `users/{uid}` — email, displayName, role(`admin`|`member`), approved, createdAt.
  생성은 가입 본인 1회(규칙이 `member`/`false` 강제), 승인·역할 변경은 admin만.
- `videos/{videoId}` — title, course, description, objectKey(`videos/{id}.mp4`),
  sizeBytes, uploaderUid, uploaderName, createdAt, status(`pending`|`ready`).
  쓰기는 Workers(서비스 계정)만.
- `meta/storage` — totalBytes(`ready` 합계, Workers가 increment로 갱신). 읽기는 승인 회원.

## 운영 메모

- 업로드/다운로드 본문은 Workers를 거치지 않고 브라우저↔R2 직접 전송
  (Workers 본문 100MB 제한 회피, R2 egress 무료).
- 업로드 중단으로 남은 `pending` 데이터는 다음 `/upload/init` 때 24시간 기준으로 자동 정리.
- 총 저장량이 8GB에 도달하면 업로드가 거부된다(R2 무료 10GB 대비 여유분).
- 과정 분류는 LMS `programs` 컬렉션에서 읽는다. 하드코딩 금지.
- LMS 저장소(IsaacAstc/lms)의 파일은 절대 수정하지 않는다.
