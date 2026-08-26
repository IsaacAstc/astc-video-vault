// 로그인·승인 상태 게이트 + 공용 유틸.
// 각 화면 진입 시 requireApproved()를 호출해 미로그인/미승인/비관리자를 리다이렉트한다.
// (화면 게이트는 UX용 — 실제 차단은 firestore.rules와 Workers가 담당)
import {
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db } from "./firebase.js";

// 현재 로그인 사용자 1회 확인(초기 auth 상태 복원 대기).
export function authState() {
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      unsub();
      resolve(user);
    });
  });
}

// users/{uid} 프로필 조회 — 없으면 null.
export async function loadProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

// 승인 회원 전용 화면 게이트. adminOnly=true면 vault 관리자만 통과.
// 통과 시 { user, profile } 반환, 실패 시 리다이렉트 후 null.
export async function requireApproved({ adminOnly = false } = {}) {
  const user = await authState();
  if (!user) {
    location.replace("index.html");
    return null;
  }
  let profile = null;
  try {
    profile = await loadProfile(user.uid);
  } catch { /* 규칙 거부 등 — 아래 미승인 처리로 */ }
  if (!profile || profile.approved !== true) {
    location.replace("pending.html");
    return null;
  }
  if (adminOnly && profile.role !== "admin") {
    alert("관리자만 접근할 수 있는 화면입니다.");
    location.replace("list.html");
    return null;
  }
  initTopbar(user, profile);
  return { user, profile };
}

// 상단바: 사용자 표시·로그아웃·관리자 메뉴 노출.
export function initTopbar(user, profile) {
  const emailEl = document.getElementById("user-email");
  if (emailEl) emailEl.textContent = `${profile.displayName} (${user.email})`;
  const logoutBtn = document.getElementById("logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      await signOut(auth);
      location.replace("index.html");
    });
  }
  document.querySelectorAll("[data-admin-only]").forEach((el) => {
    el.hidden = profile.role !== "admin";
  });
}

export async function doSignOut() {
  await signOut(auth);
  location.replace("index.html");
}

// ── 표시 유틸 ──
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// Firestore Timestamp/ISO 문자열 겸용 날짜 표기(YYYY.MM.DD).
export function fmtDate(ts) {
  let d = null;
  if (ts && typeof ts.toDate === "function") d = ts.toDate();
  else if (typeof ts === "string") d = new Date(ts);
  if (!d || Number.isNaN(d.getTime())) return "";
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}
