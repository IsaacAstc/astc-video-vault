#!/usr/bin/env python3
# vault firestore.rules(병합본)의 [A] 구간을 LMS 규칙 원문으로 교체하는 동기화 스크립트.
# GitHub Actions(.github/workflows/sync-lms-rules.yml)에서 매일 실행된다.
#
# 사용: python3 scripts/sync-lms-rules.py <LMS_firestore.rules_경로>
# 출력: CHANGED(파일 갱신됨) 또는 UNCHANGED(차이 없음). 구조 인식 실패 시 종료코드 1.
import sys
import pathlib

VAULT_RULES = pathlib.Path(__file__).resolve().parent.parent / "firestore.rules"
# 병합본 안의 구간 마커(고유 문자열 — firestore.rules 배너 주석과 함께 유지할 것)
A_MARKER = "[A] 기존 LMS 규칙 원문 (IsaacAstc/lms"
B_MARKER = "(astc-video-vault)가 관리"


def fail(msg):
    print(f"오류: {msg}", file=sys.stderr)
    sys.exit(1)


def main():
    if len(sys.argv) != 2:
        fail("사용법: sync-lms-rules.py <LMS_firestore.rules_경로>")

    # ── LMS 원문에서 documents 매치 내부 본문만 추출 ──
    lms_lines = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
    try:
        start = next(i for i, l in enumerate(lms_lines)
                     if l.strip() == "match /databases/{database}/documents {")
    except StopIteration:
        fail("LMS 파일에서 'match /databases/{database}/documents {' 를 찾지 못했습니다.")
    while lms_lines and not lms_lines[-1].strip():
        lms_lines.pop()
    if [l.strip() for l in lms_lines[-2:]] != ["}", "}"]:
        fail("LMS 파일 끝이 '} }' 구조가 아닙니다 — 원문 형식이 바뀌었는지 확인하세요.")
    body = lms_lines[start + 1:-2]
    while body and not body[0].strip():
        body.pop(0)
    while body and not body[-1].strip():
        body.pop()
    if not body:
        fail("LMS 규칙 본문이 비어 있습니다.")

    # ── 병합본에서 [A] 구간 위치 탐색 ──
    vault_lines = VAULT_RULES.read_text(encoding="utf-8").splitlines()
    try:
        a_idx = next(i for i, l in enumerate(vault_lines) if A_MARKER in l)
        b_idx = next(i for i, l in enumerate(vault_lines) if B_MARKER in l)
    except StopIteration:
        fail("병합본에서 [A]/[B] 구간 마커를 찾지 못했습니다.")
    if "═" not in vault_lines[a_idx + 1] or "═" not in vault_lines[b_idx - 1]:
        fail("[A]/[B] 배너 구조가 예상과 다릅니다 — 마커 주석을 복원하세요.")
    splice_start = a_idx + 2   # [A] 배너 종료줄 다음부터
    splice_end = b_idx - 1     # [B] 배너 시작줄 앞까지

    old_body = vault_lines[splice_start:splice_end]
    new_body = [""] + body + [""]
    if old_body == new_body:
        print("UNCHANGED")
        return

    merged = vault_lines[:splice_start] + new_body + vault_lines[splice_end:]
    VAULT_RULES.write_text("\n".join(merged) + "\n", encoding="utf-8")
    print("CHANGED")


if __name__ == "__main__":
    main()
