// Cloudflare Workers API 호출 래퍼 — Firebase ID 토큰을 자동 첨부한다.
import { auth } from "./firebase.js";

// [확인 필요] Workers 배포 후 실제 주소로 교체 (README 배포 절차 9번)
export const API_BASE = "https://astc-video-vault.YOUR_ACCOUNT.workers.dev";

// 공통 호출: 실패 시 서버의 한국어 오류 메시지를 그대로 throw.
export async function api(path, { method = "GET", body } = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error("로그인이 필요합니다.");
  const token = await user.getIdToken();
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청에 실패했습니다. (HTTP ${res.status})`);
  return data;
}

// presigned URL로 R2에 직접 PUT (Workers 미경유 — 진행률 콜백 지원).
export function putToR2(uploadUrl, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", "video/mp4");
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`파일 전송에 실패했습니다. (HTTP ${xhr.status})`));
    });
    xhr.addEventListener("error", () => reject(new Error("파일 전송 중 네트워크 오류가 발생했습니다.")));
    xhr.addEventListener("abort", () => reject(new Error("파일 전송이 취소되었습니다.")));
    xhr.send(file);
  });
}
