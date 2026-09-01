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

### 4-대안. 회사망(프록시 차단) 환경: 대시보드로 배포

사내 프록시/보안장비가 wrangler의 API 통신을 차단하는 경우
(`wrangler login` 시 `fetch failed` / 인증서 불일치 경고),
Worker가 의존성 없는 단일 파일이므로 **브라우저 대시보드만으로 배포**할 수 있다.
실제 2026-08 최초 배포는 이 방법으로 수행했다.

1. dash.cloudflare.com → **Compute (Workers & Pages)** → Create →
   **Start with Hello World!** → 이름 `astc-video-vault` → Deploy
2. **Edit code** → GitHub의 `worker/src/index.js`를 열어(Copy raw file)
   편집기 코드 전체를 교체 → Deploy
3. Worker → **Bindings** 탭 → Add → **R2 bucket**:
   Variable name `VIDEOS`, bucket `astc-videos`
4. Worker → **Settings → Variables and Secrets** → 7개 등록:
   - Text: `FIREBASE_PROJECT_ID`=`astc-lms`,
     `ALLOWED_ORIGIN`=`https://isaacastc.github.io`, `R2_BUCKET`=`astc-videos`
   - Secret: `FIREBASE_SERVICE_ACCOUNT`(키 JSON 전문), `R2_ACCESS_KEY_ID`,
     `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`
5. ⚠️ **버전 승격 확인(중요)**: 변수·코드 저장은 새 "버전"을 만들 뿐 자동 반영되지
   않을 수 있다. **Deployments 탭**에서 Active deployment가 최신 버전인지 확인하고,
   아니면 최신 버전의 `...` 메뉴 → **Promote to production**.
   (증상: 브라우저 콘솔에 `Access-Control-Allow-Origin ... 'undefined'` CORS 오류)
6. 확인: `https://<worker주소>/storage` 접속 시 `{"error":"로그인이 필요합니다."}`
7. 이후 코드 수정 시에도 같은 방법(Edit code → 붙여넣기 → Deploy → 버전 확인)을 쓴다.

### 5. Firestore 보안규칙 배포 — ⚠️ 반드시 검증 후

이 저장소의 `firestore.rules`는 **LMS 규칙 원문 + Vault 규칙의 병합본**이며
프로젝트의 유일한 배포 원본이다. 규칙은 배포 시 통째로 교체되므로,
LMS 구간이 누락된 채 배포하면 운영 중인 LMS가 마비된다.

```bash
./scripts/check-rules.sh                      # 통과(✅) 확인 후에만 진행
firebase deploy --only firestore:rules
```
> **자동 배포(권장)**: `sync-lms-rules` 워크플로가 LMS 규칙 변경을 감지하면 병합본을 main에 직접 커밋하고, 저장소 Secrets에 `FIREBASE_SERVICE_ACCOUNT`(서비스 계정 JSON)·`FIREBASE_PROJECT_ID`가 등록돼 있으면 검증 후 규칙까지 자동 배포한다(수동 실행 시 변경이 없어도 재배포). 아래 수동 절차는 시크릿 미등록·비상시용.

LMS 쪽 규칙이 변경되면: LMS 저장소의 firestore.rules 원문으로 이 파일의
`[A]` 구간을 통째로 교체 → 검증 → 재배포.
이 교체는 **자동화되어 있다** — `.github/workflows/sync-lms-rules.yml`이
매일 09:00 KST(또는 Actions 탭 수동 실행)에 LMS 원문을 읽어 차이가 있으면
검증을 거쳐 **동기화 PR**을 자동 생성한다. PR diff 확인 후 머지하고
아래 방법으로 게시하면 된다. (사전 조건: 저장소 Settings → Actions → General →
"Allow GitHub Actions to create and approve pull requests" 체크)

**5-대안. 회사망 환경: Firebase 콘솔로 게시** — firebase CLI가 프록시에 막히면
GitHub의 `firestore.rules`를 Copy raw file로 복사해 Firebase 콘솔 →
Firestore Database → 규칙 탭에 전체 붙여넣기 후 게시한다. 붙여넣기 후
첫 줄 `rules_version = '2';`, `[A]`·`[B]` 주석 존재, 문법 오류 없음을 확인하고,
게시 직후 기존 LMS 화면이 정상 동작하는지 즉시 검증한다
(문제 시 규칙 탭의 버전 기록에서 롤백). 실제 2026-08 최초 배포는 이 방법으로 수행했다.

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
- **8GB 임계치의 의미** — R2가 정한 한도가 아니라 과금 방지용 **자체 안전선**:
  - 기준: `ready`(게시 완료) 비디오의 크기 합계(`meta/storage.totalBytes`).
    목록 화면 게이지가 이 값이다. 업로드 완료 시 실측 크기로 가산, 삭제 시 차감.
  - 검사: 업로드 **시작 전**(신고 크기 기준 초과 시 즉시 거부)과 **완료 시**
    (R2 실측 기준 재검증 — 초과면 방금 올린 객체 삭제 후 거부) 이중으로 수행.
  - 8GB인 이유: R2 무료 제공량 10GB에서 2GB 여유를 남긴 것. 완료 검사 이전의
    전송 중 파일·미정리 pending 객체가 이 여유분 안에서 흡수되어,
    장부가 8GB여도 실제 R2 사용량이 10GB(과금선)를 넘지 않는다.
  - 도달 시: 새 업로드만 거부되고 기존 영상의 재생·다운로드는 정상.
    관리 화면에서 영상을 삭제하면 그만큼 즉시 다시 업로드 가능.
  - 일괄 업로드 시 파일 단위로 검사되므로, 임계치를 넘는 파일부터 실패로
    표시되고 그 이전 파일은 정상 게시된다.
- 과정 분류는 LMS `programs` 컬렉션에서 읽는다. 하드코딩 금지.
- LMS 저장소(IsaacAstc/lms)의 파일은 절대 수정하지 않는다.
