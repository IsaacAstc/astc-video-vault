// ============================================================================
// ASTC Video Vault — Cloudflare Workers API
//
// 역할: Firebase ID 토큰 검증 → users/{uid} 역할·승인 확인 →
//       R2 presigned URL 발급 / 업로드 완료 확정 / 삭제 / 용량 집계 / 과정 목록.
// 외부 의존성 0 — Firestore는 REST API, R2 presigned URL은 SigV4 직접 구현.
//
// 시크릿(wrangler secret put <이름>):
//   FIREBASE_SERVICE_ACCOUNT  서비스 계정 키 JSON 전문
//   R2_ACCESS_KEY_ID          R2 API 토큰 Access Key ID
//   R2_SECRET_ACCESS_KEY      R2 API 토큰 Secret Access Key
//   R2_ACCOUNT_ID             Cloudflare 계정 ID
// 환경변수(wrangler.toml [vars]):
//   FIREBASE_PROJECT_ID, ALLOWED_ORIGIN, R2_BUCKET
// R2 바인딩: VIDEOS (HEAD·DELETE 등 서버 측 객체 조작용)
// ============================================================================

// ── 상수 (명세 1절 확정 사항) ──
const MAX_FILE_BYTES = 500 * 1024 * 1024;          // 개별 파일 상한 500MB
const TOTAL_LIMIT_BYTES = 8 * 1024 * 1024 * 1024;  // 총 저장량 임계치 8GB
const ALLOWED_DOMAIN = "@airport.co.kr";           // 가입 허용 도메인
const PUT_URL_TTL_SEC = 15 * 60;                   // presigned PUT 만료 15분
const GET_URL_TTL_SEC = 60 * 60;                   // presigned GET 만료 1시간
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;        // pending 고아 정리 기준 24시간
const COURSES_CACHE_MS = 5 * 60 * 1000;            // 과정 목록 캐시 5분

// Firebase ID 토큰 서명 공개키(JWK) — Google 고정 URL.
const GOOGLE_JWK_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

// 인스턴스 수명 동안 유지되는 캐시(Workers isolate 재사용 시 절약).
const cache = {
  jwks: null, jwksExp: 0,        // Google 공개키
  gToken: null, gTokenExp: 0,    // 서비스 계정 OAuth 액세스 토큰
  courses: null, coursesExp: 0,  // LMS 과정 분류 목록
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return preflight(env);
    try {
      const res = await route(request, env);
      return withCors(res, env);
    } catch (e) {
      const status = e.status || 500;
      const message = e.status ? e.message : "서버 오류가 발생했습니다.";
      if (!e.status) console.error("unhandled:", e);
      return withCors(json({ error: message }, status), env);
    }
  },
};

// ── 라우팅 ──
async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  if (method === "POST" && path === "/upload/init") return uploadInit(request, env);
  if (method === "POST" && path === "/upload/complete") return uploadComplete(request, env);

  const videoUrlMatch = path.match(/^\/videos\/([A-Za-z0-9-]+)\/url$/);
  if (method === "GET" && videoUrlMatch) return videoUrl(request, env, videoUrlMatch[1], url);

  const videoMatch = path.match(/^\/videos\/([A-Za-z0-9-]+)$/);
  if (method === "DELETE" && videoMatch) return videoDelete(request, env, videoMatch[1]);

  if (method === "GET" && path === "/storage") return storageInfo(request, env);
  if (method === "GET" && path === "/courses") return coursesList(request, env);

  throw httpError(404, "요청한 경로를 찾을 수 없습니다.");
}

// ════════════════════════════════════════════════════════════════════════════
// 엔드포인트
// ════════════════════════════════════════════════════════════════════════════

// POST /upload/init (admin) — 명세 4절 서버 측 검증 후 pending 문서 생성 + presigned PUT.
async function uploadInit(request, env) {
  const me = await requireUser(request, env, { admin: true });
  const body = await readJson(request);
  const title = str(body.title).trim();
  const course = str(body.course).trim();
  const description = str(body.description).trim();
  const fileName = str(body.fileName).trim();
  const contentType = str(body.contentType).trim();
  const sizeBytes = Number(body.sizeBytes);

  // ── 서버 측 검증 (명세 4절 — 클라이언트 검사로 대체 금지) ──
  if (!title) throw httpError(400, "제목을 입력해 주세요.");
  if (title.length > 200) throw httpError(400, "제목은 200자를 초과할 수 없습니다.");
  if (description.length > 2000) throw httpError(400, "설명은 2000자를 초과할 수 없습니다.");
  // 1) MP4만 허용: contentType과 파일명 확장자 모두 확인.
  if (contentType !== "video/mp4" || !fileName.toLowerCase().endsWith(".mp4")) {
    throw httpError(400, "MP4 파일만 업로드할 수 있습니다. (.mp4, video/mp4)");
  }
  // 2) 개별 파일 500MB 상한.
  if (!Number.isFinite(sizeBytes) || !Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    throw httpError(400, "파일 크기 정보가 올바르지 않습니다.");
  }
  if (sizeBytes > MAX_FILE_BYTES) {
    throw httpError(413, "파일 크기는 500MB를 초과할 수 없습니다.");
  }
  // 4) 과정 분류가 LMS 과정 목록(programs)에 존재하는지 확인.
  const courses = await getCourseNames(env);
  if (!courses.includes(course)) {
    throw httpError(400, "과정 분류가 올바르지 않습니다. 목록에서 선택해 주세요.");
  }

  // 고아 pending 정리(24시간 경과) — 실패해도 업로드는 계속.
  try { await cleanupStalePending(env); } catch (e) { console.error("cleanup:", e); }

  // 3) 총 저장량 8GB 임계치.
  const totalBytes = await ensureStorageDoc(env);
  if (totalBytes + sizeBytes > TOTAL_LIMIT_BYTES) {
    throw httpError(507, "저장 용량 임계치(8GB)를 초과하여 업로드할 수 없습니다. 기존 비디오를 삭제한 뒤 다시 시도해 주세요.");
  }

  const videoId = crypto.randomUUID();
  const objectKey = `videos/${videoId}.mp4`;
  await fsPatch(env, `videos/${videoId}`, {
    title,
    course,
    description,
    objectKey,
    sizeBytes,
    uploaderUid: me.uid,
    uploaderName: me.displayName || me.email,
    createdAt: new Date(),
    status: "pending",
  });

  // presigned PUT (만료 15분). Content-Length 서명 조건은 브라우저 호환성 문제로
  // 생략하고, /upload/complete의 HEAD 검증으로 실제 크기를 강제한다(CLAUDE.md 결정 #8).
  const uploadUrl = await presignR2(env, "PUT", objectKey, PUT_URL_TTL_SEC);
  return json({ videoId, objectKey, uploadUrl });
}

// POST /upload/complete (admin) — R2 HEAD로 실제 크기 확인 후 ready 확정.
async function uploadComplete(request, env) {
  await requireUser(request, env, { admin: true });
  const body = await readJson(request);
  const videoId = str(body.videoId).trim();
  if (!videoId) throw httpError(400, "videoId가 필요합니다.");

  const doc = await fsGet(env, `videos/${videoId}`);
  if (!doc) throw httpError(404, "비디오 정보를 찾을 수 없습니다.");
  const video = docData(doc);
  if (video.status === "ready") return json({ ok: true, sizeBytes: video.sizeBytes }); // 중복 호출 허용

  const head = await env.VIDEOS.head(video.objectKey);
  if (!head) throw httpError(400, "업로드된 파일이 없습니다. 업로드가 완료된 뒤 다시 시도해 주세요.");
  const actualBytes = head.size;

  // 서버 측 재검증: presigned URL로 신고값과 다른 파일을 올린 경우 차단.
  if (actualBytes > MAX_FILE_BYTES) {
    await env.VIDEOS.delete(video.objectKey);
    await fsDelete(env, `videos/${videoId}`);
    throw httpError(413, "업로드된 파일이 500MB를 초과하여 삭제되었습니다.");
  }
  const totalBytes = await ensureStorageDoc(env);
  if (totalBytes + actualBytes > TOTAL_LIMIT_BYTES) {
    await env.VIDEOS.delete(video.objectKey);
    await fsDelete(env, `videos/${videoId}`);
    throw httpError(507, "저장 용량 임계치(8GB)를 초과하여 업로드가 취소되었습니다.");
  }

  await fsPatch(env, `videos/${videoId}`, { status: "ready", sizeBytes: actualBytes },
    ["status", "sizeBytes"]);
  await addTotalBytes(env, actualBytes);
  return json({ ok: true, sizeBytes: actualBytes });
}

// GET /videos/:id/url (approved member) — presigned GET. ?download=1 이면 첨부 다운로드.
async function videoUrl(request, env, videoId, url) {
  await requireUser(request, env);
  const doc = await fsGet(env, `videos/${videoId}`);
  if (!doc) throw httpError(404, "비디오를 찾을 수 없습니다.");
  const video = docData(doc);
  if (video.status !== "ready") throw httpError(409, "아직 업로드가 완료되지 않은 비디오입니다.");

  const extraParams = {};
  if (url.searchParams.get("download") === "1") {
    // 다운로드 파일명: 제목.mp4 (한글은 RFC 5987 filename*, ASCII fallback 병기)
    const encoded = encodeURIComponent(`${video.title}.mp4`).replace(/['()]/g, escape);
    extraParams["response-content-disposition"] =
      `attachment; filename="video.mp4"; filename*=UTF-8''${encoded}`;
  }
  const signedUrl = await presignR2(env, "GET", video.objectKey, GET_URL_TTL_SEC, extraParams);
  return json({ url: signedUrl });
}

// DELETE /videos/:id (admin) — R2 객체 삭제 → 문서 삭제 → totalBytes 차감.
async function videoDelete(request, env, videoId) {
  await requireUser(request, env, { admin: true });
  const doc = await fsGet(env, `videos/${videoId}`);
  if (!doc) throw httpError(404, "비디오를 찾을 수 없습니다.");
  const video = docData(doc);

  await env.VIDEOS.delete(video.objectKey); // 객체가 없어도 오류 없음(멱등)
  await fsDelete(env, `videos/${videoId}`);
  if (video.status === "ready" && Number.isFinite(video.sizeBytes)) {
    await ensureStorageDoc(env);
    await addTotalBytes(env, -video.sizeBytes);
  }
  return json({ ok: true });
}

// GET /storage (approved member) — UI 게이지용.
async function storageInfo(request, env) {
  await requireUser(request, env);
  const totalBytes = await ensureStorageDoc(env);
  return json({ totalBytes, limitBytes: TOTAL_LIMIT_BYTES });
}

// GET /courses (approved member) — LMS programs 컬렉션의 과정명 목록.
// LMS 보안규칙상 회원이 직접 읽을 수 없어 Workers(서비스 계정)가 대신 읽는다(결정 #2).
async function coursesList(request, env) {
  await requireUser(request, env);
  const courses = await getCourseNames(env);
  return json({ courses });
}

// ════════════════════════════════════════════════════════════════════════════
// 인증: Firebase ID 토큰 검증 + vault 회원 확인
// ════════════════════════════════════════════════════════════════════════════

async function requireUser(request, env, { admin = false } = {}) {
  const authz = request.headers.get("Authorization") || "";
  const m = authz.match(/^Bearer\s+(.+)$/);
  if (!m) throw httpError(401, "로그인이 필요합니다.");
  const token = await verifyIdToken(m[1], env);

  // 허용 도메인 3중 검증 중 서버 측(결정 #5).
  if (!token.email.endsWith(ALLOWED_DOMAIN)) {
    throw httpError(403, "허용되지 않은 이메일 도메인입니다. (@airport.co.kr 전용)");
  }
  const doc = await fsGet(env, `users/${token.uid}`);
  if (!doc) throw httpError(403, "회원 정보가 없습니다. 회원가입을 다시 진행해 주세요.");
  const user = docData(doc);
  if (user.approved !== true) throw httpError(403, "관리자 승인 대기 중인 계정입니다.");
  if (admin && user.role !== "admin") throw httpError(403, "관리자 권한이 필요합니다.");
  return { uid: token.uid, email: token.email, ...user };
}

// ID 토큰 서명·클레임 검증 (RS256, Google 공개 JWK).
async function verifyIdToken(idToken, env) {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw httpError(401, "인증 토큰 형식이 올바르지 않습니다.");
  let header, payload;
  try {
    header = JSON.parse(b64urlDecodeText(parts[0]));
    payload = JSON.parse(b64urlDecodeText(parts[1]));
  } catch {
    throw httpError(401, "인증 토큰을 해석할 수 없습니다.");
  }
  if (header.alg !== "RS256") throw httpError(401, "지원하지 않는 토큰 서명 방식입니다.");

  const jwk = (await getGoogleJwks()).find((k) => k.kid === header.kid);
  if (!jwk) throw httpError(401, "인증 토큰 서명 키를 확인할 수 없습니다. 다시 로그인해 주세요.");
  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key,
    b64urlDecodeBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw httpError(401, "인증 토큰 서명이 유효하지 않습니다.");

  const now = Math.floor(Date.now() / 1000);
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!(payload.exp > now)) throw httpError(401, "인증 토큰이 만료되었습니다. 다시 로그인해 주세요.");
  if (payload.aud !== projectId
    || payload.iss !== `https://securetoken.google.com/${projectId}`
    || !payload.sub) {
    throw httpError(401, "인증 토큰이 이 서비스의 것이 아닙니다.");
  }
  return { uid: payload.sub, email: String(payload.email || "").toLowerCase() };
}

async function getGoogleJwks() {
  if (cache.jwks && cache.jwksExp > Date.now()) return cache.jwks;
  const res = await fetch(GOOGLE_JWK_URL);
  if (!res.ok) throw httpError(503, "인증 서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.");
  const { keys } = await res.json();
  // Cache-Control max-age를 따르되 최소 5분은 캐시.
  const cc = res.headers.get("Cache-Control") || "";
  const maxAge = Number((cc.match(/max-age=(\d+)/) || [])[1] || 0);
  cache.jwks = keys;
  cache.jwksExp = Date.now() + Math.max(maxAge, 300) * 1000;
  return keys;
}

// ════════════════════════════════════════════════════════════════════════════
// Firestore REST (서비스 계정 — Admin SDK는 Workers에서 미동작, 결정 #7)
// ════════════════════════════════════════════════════════════════════════════

function fsBase(env) {
  return `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
}
function fsDocName(env, path) {
  return `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
}

// 서비스 계정 키로 OAuth 액세스 토큰 발급(50분 캐시).
async function getAccessToken(env) {
  if (cache.gToken && cache.gTokenExp > Date.now()) return cache.gToken;
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const iat = Math.floor(Date.now() / 1000);
  const header = b64urlEncodeText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64urlEncodeText(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: sa.token_uri,
    iat,
    exp: iat + 3600,
  }));
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToBytes(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
  const jwt = `${header}.${claims}.${b64urlEncodeBytes(new Uint8Array(sig))}`;

  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw httpError(503, "데이터베이스 인증에 실패했습니다.");
  const data = await res.json();
  cache.gToken = data.access_token;
  cache.gTokenExp = Date.now() + 50 * 60 * 1000;
  return cache.gToken;
}

async function fsFetch(env, url, init = {}) {
  const token = await getAccessToken(env);
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

// 문서 조회 — 없으면 null.
async function fsGet(env, path) {
  const res = await fsFetch(env, `${fsBase(env)}/${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw httpError(503, "데이터베이스 조회에 실패했습니다.");
  return res.json();
}

// 문서 생성/수정. maskFields를 주면 해당 필드만 갱신, 없으면 전체 교체(생성 겸용).
async function fsPatch(env, path, data, maskFields) {
  const u = new URL(`${fsBase(env)}/${path}`);
  for (const f of maskFields || []) u.searchParams.append("updateMask.fieldPaths", f);
  const res = await fsFetch(env, u, {
    method: "PATCH",
    body: JSON.stringify({ fields: toFields(data) }),
  });
  if (!res.ok) throw httpError(503, "데이터베이스 저장에 실패했습니다.");
  return res.json();
}

async function fsDelete(env, path) {
  const res = await fsFetch(env, `${fsBase(env)}/${path}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw httpError(503, "데이터베이스 삭제에 실패했습니다.");
}

// 단일 컬렉션 질의(선택적 동등 필터).
async function fsQuery(env, collectionId, fieldPath, value) {
  const structuredQuery = { from: [{ collectionId }] };
  if (fieldPath) {
    structuredQuery.where = {
      fieldFilter: { field: { fieldPath }, op: "EQUAL", value: toValue(value) },
    };
  }
  const res = await fsFetch(env, `${fsBase(env)}:runQuery`, {
    method: "POST",
    body: JSON.stringify({ structuredQuery }),
  });
  if (!res.ok) throw httpError(503, "데이터베이스 조회에 실패했습니다.");
  const rows = await res.json();
  return rows.filter((r) => r.document).map((r) => r.document);
}

// meta/storage 존재 보장 후 현재 totalBytes 반환.
async function ensureStorageDoc(env) {
  const doc = await fsGet(env, "meta/storage");
  if (doc) return Number(docData(doc).totalBytes) || 0;
  await fsPatch(env, "meta/storage", { totalBytes: 0 });
  return 0;
}

// totalBytes 증감 — 동시 요청 경합을 피하기 위해 FieldTransform increment 사용(결정 #10).
async function addTotalBytes(env, delta) {
  const res = await fsFetch(
    env,
    `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:commit`,
    {
      method: "POST",
      body: JSON.stringify({
        writes: [{
          transform: {
            document: fsDocName(env, "meta/storage"),
            fieldTransforms: [{
              fieldPath: "totalBytes",
              increment: { integerValue: String(delta) },
            }],
          },
        }],
      }),
    });
  if (!res.ok) throw httpError(503, "용량 집계 갱신에 실패했습니다.");
}

// LMS programs 컬렉션의 과정명 목록(5분 캐시) — 과정 분류의 원천(결정 #1).
async function getCourseNames(env) {
  if (cache.courses && cache.coursesExp > Date.now()) return cache.courses;
  const docs = await fsQuery(env, "programs");
  const names = docs
    .map((d) => docData(d).name)
    .filter((n) => typeof n === "string" && n.length > 0)
    .sort((a, b) => a.localeCompare(b, "ko"));
  if (names.length === 0) {
    throw httpError(503, "LMS 과정 목록을 불러올 수 없습니다. 관리자에게 문의해 주세요.");
  }
  cache.courses = names;
  cache.coursesExp = Date.now() + COURSES_CACHE_MS;
  return names;
}

// 24시간 지난 pending 문서·객체 정리(결정 #9).
async function cleanupStalePending(env) {
  const docs = await fsQuery(env, "videos", "status", "pending");
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const d of docs) {
    const v = docData(d);
    const createdMs = v.createdAt ? Date.parse(v.createdAt) : 0;
    if (createdMs && createdMs > cutoff) continue;
    const id = d.name.split("/").pop();
    await env.VIDEOS.delete(v.objectKey);
    await fsDelete(env, `videos/${id}`);
  }
}

// ── Firestore Value 변환 ──
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  throw new Error("지원하지 않는 값 타입");
}
function toFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toValue(v);
  return fields;
}
function fromValue(val) {
  if (!val) return null;
  if ("stringValue" in val) return val.stringValue;
  if ("integerValue" in val) return Number(val.integerValue);
  if ("doubleValue" in val) return val.doubleValue;
  if ("booleanValue" in val) return val.booleanValue;
  if ("timestampValue" in val) return val.timestampValue;
  return null;
}
function docData(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc.fields || {})) out[k] = fromValue(v);
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// R2 presigned URL — AWS SigV4 쿼리 서명 직접 구현(외부 의존성 금지, 결정 #11)
// ════════════════════════════════════════════════════════════════════════════

async function presignR2(env, method, objectKey, expiresSec, extraParams = {}) {
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;

  // 경로: 버킷/객체키. 객체키의 '/'는 유지하고 세그먼트만 인코딩.
  const canonicalUri = `/${env.R2_BUCKET}/` +
    objectKey.split("/").map(rfc3986).join("/");

  const params = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${env.R2_ACCESS_KEY_ID}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresSec),
    "X-Amz-SignedHeaders": "host",
    ...extraParams,
  };
  const canonicalQuery = Object.keys(params)
    .map((k) => [rfc3986(k), rfc3986(params[k])])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  // 서명 키 파생: kSecret → kDate → kRegion → kService → kSigning
  let key = new TextEncoder().encode(`AWS4${env.R2_SECRET_ACCESS_KEY}`);
  for (const part of [dateStamp, "auto", "s3", "aws4_request"]) {
    key = await hmacSha256(key, part);
  }
  const signature = bytesToHex(await hmacSha256(key, stringToSign));

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

function rfc3986(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}
async function hmacSha256(keyBytes, text) {
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return new Uint8Array(sig);
}
function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ════════════════════════════════════════════════════════════════════════════
// 공통 유틸
// ════════════════════════════════════════════════════════════════════════════

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
function str(v) {
  return typeof v === "string" ? v : "";
}
async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw httpError(400, "요청 본문(JSON)이 올바르지 않습니다.");
  }
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// ── CORS: GitHub Pages 도메인만 허용 ──
function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
function preflight(env) {
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}
function withCors(res, env) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(corsHeaders(env))) out.headers.set(k, v);
  return out;
}

// ── Base64url ──
function b64urlEncodeText(text) {
  return b64urlEncodeBytes(new TextEncoder().encode(text));
}
function b64urlEncodeBytes(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecodeBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function b64urlDecodeText(s) {
  return new TextDecoder().decode(b64urlDecodeBytes(s));
}

// ── PEM(PKCS8) → 바이트 ──
function pemToBytes(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
