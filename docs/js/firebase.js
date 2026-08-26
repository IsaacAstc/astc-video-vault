// Firebase 초기화 — 기존 LMS와 같은 프로젝트를 공유한다(허브 프로젝트 단일 대상).
// config는 공개값이므로 커밋한다(명세 확정·CLAUDE.md 결정 #12).
// 배포 시 Firebase 콘솔 → 프로젝트 설정 → 웹 앱에서 실제 값으로 교체할 것.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// [확인 필요] 아래 config 전체를 실제 값으로 교체 (README 배포 절차 2번)
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "astc-lms.firebaseapp.com",   // [확인 필요] 실제 프로젝트 ID 기준
  projectId: "astc-lms",                    // [확인 필요] Workers wrangler.toml의 FIREBASE_PROJECT_ID와 일치해야 함
  storageBucket: "astc-lms.appspot.com",    // [확인 필요]
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
