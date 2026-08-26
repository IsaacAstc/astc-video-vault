#!/usr/bin/env bash
# firestore.rules 배포 전 검증 — LMS 규칙([A] 구간) 누락 시 배포를 막는다.
# 이 프로젝트의 규칙은 배포 시 통째로 교체되므로, LMS 필수 블록이 빠진 채
# 배포하면 운영 중인 LMS가 마비된다. (CLAUDE.md 2절)
# 사용: ./scripts/check-rules.sh  → 통과 시에만 firebase deploy --only firestore:rules
set -u
RULES="$(dirname "$0")/../firestore.rules"
FAIL=0

require() {
  if ! grep -qF "$1" "$RULES"; then
    echo "누락: $1"
    FAIL=1
  fi
}

# [A] 기존 LMS 규칙 필수 블록
require "function adminEmails()"
require "match /admins/{email}"
require "match /courses/{courseId}"
require "match /sessions/{sessionId}"
require "match /rooms/{roomId}"
require "match /instructors/{instructorId}"
require "match /programs/{programId}"
require "match /settings/{docId}"
require "match /expenses/{docId}"
require "match /publicSurveys/{courseId}"
require "match /publicBoard/{docId}"
require "match /surveyResponses/{responseId}"
require "match /surveyAggregates/{aggregateId}"
require "match /events/{eventId}"
require "match /scfeSettings/{docId}"
require "match /participants/{docId}"
require "match /rentals/{rentalId}"
require "match /applications/{id}"
require "match /rateLimits/{id}"
require "match /logiBoards/{courseId}"
require "match /logiBulletins/{id}"
require "match /logiPolls/{id}"
require "match /logiTokens/{token}"
require "match /collabBoards/{boardId}"
require "match /collabPosts/{postId}"
require "match /quizzes/{id}"
require "match /quizReports/{id}"
require "match /orgs/{orgId}"

# [B] Video Vault 필수 블록
require "match /users/{uid}"
require "match /videos/{videoId}"
require "match /meta/{docId}"
require "function vaultAdmin()"

if [ "$FAIL" -ne 0 ]; then
  echo ""
  echo "❌ firestore.rules에 필수 규칙 블록이 누락되었습니다. 배포를 중단하세요."
  echo "   LMS 규칙([A] 구간)이 빠진 채 배포하면 운영 중인 LMS가 마비됩니다."
  exit 1
fi
echo "✅ firestore.rules 검증 통과 — LMS 규칙 + Video Vault 규칙 모두 존재합니다."
