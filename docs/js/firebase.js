// Firebase 초기화 — 기존 LMS와 같은 프로젝트를 공유한다(허브 프로젝트 단일 대상).
// config는 공개값이므로 커밋한다(명세 확정·CLAUDE.md 결정 #12).
// 배포 시 Firebase 콘솔 → 프로젝트 설정 → 웹 앱에서 실제 값으로 교체할 것.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// 프로젝트 ID는 astc-lms로 확정(사용자 확인 완료).
// [확인 필요] apiKey·messagingSenderId·appId는 콘솔에서 실제 값으로 교체 (README 배포 절차 2번)
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",                   // [확인 필요]
  authDomain: "astc-lms.firebaseapp.com",
  projectId: "astc-lms",
  storageBucket: "astc-lms.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",      // [확인 필요]
  appId: "YOUR_APP_ID",                     // [확인 필요]
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
