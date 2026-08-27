// Firebase 초기화 — 기존 LMS와 같은 프로젝트를 공유한다(허브 프로젝트 단일 대상).
// config는 공개값이므로 커밋한다(명세 확정·CLAUDE.md 결정 #12).
// 배포 시 Firebase 콘솔 → 프로젝트 설정 → 웹 앱에서 실제 값으로 교체할 것.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// 실제 값 반영 완료(2026-08 배포). config는 공개값 — 방어선은 보안규칙과 Workers.
export const firebaseConfig = {
  apiKey: "AIzaSyAhi-sqsFdmSGhu_w6sBlJTfuICuuQ82gQ",
  authDomain: "astc-lms.firebaseapp.com",
  projectId: "astc-lms",
  storageBucket: "astc-lms.appspot.com",
  messagingSenderId: "614712271030",
  appId: "1:614712271030:web:98c69a78d864787535c617",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
