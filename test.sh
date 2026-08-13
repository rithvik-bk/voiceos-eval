#!/usr/bin/env bash
#
# test.sh — end-to-end self-test for voiceos-eval.
#
# Runs the whole product with NO API key and asserts every piece works:
#   1. node run.js            -> scorecard prints a Ship Score
#   2. node gate-benchmark.js -> "4/4 caught" and 0 false blocks
#   3. node gen.js            -> emits generated cases from a catalog
#   4. node index.js          -> the safety guard blocks a mismatched call
#
# Exits non-zero on the first failure. Prints a clean PASS summary on success.
# No network, no model, no secrets — the runner and gate are deterministic.

set -u
cd "$(dirname "$0")"

# Prove it needs no credentials: strip any key from this process's environment.
unset ANTHROPIC_API_KEY OPENAI_API_KEY 2>/dev/null || true

PASS=0
FAIL=0
FAILED_STEPS=""

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }
dim()   { printf '\033[2m%s\033[0m\n' "$1"; }

# run_step <label> <logfile> -- <command...>
# Runs the command, capturing combined output to <logfile>, and requires exit 0.
run_step() {
  local label="$1"; local log="$2"; shift 3   # drop label, log, and the "--"
  printf '  %-28s' "$label"
  if "$@" >"$log" 2>&1; then
    return 0
  else
    red "FAIL (exit $?)"
    dim "  --- output ---"
    sed 's/^/    /' "$log"
    FAIL=$((FAIL + 1))
    FAILED_STEPS="${FAILED_STEPS}\n  - ${label}: command exited non-zero"
    return 1
  fi
}

# assert_contains <logfile> <needle> <human description>
assert_contains() {
  local log="$1"; local needle="$2"; local desc="$3"
  if grep -qF -- "$needle" "$log"; then
    PASS=$((PASS + 1))
    green "OK"
    printf '    \033[2m%s\033[0m\n' "$desc"
    return 0
  fi
  red "FAIL"
  printf '    expected to find: %s\n' "$needle"
  dim "  --- output ---"
  sed 's/^/    /' "$log"
  FAIL=$((FAIL + 1))
  FAILED_STEPS="${FAILED_STEPS}\n  - ${desc}: missing \"${needle}\""
  return 1
}

TMPDIR_SELF="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_SELF"' EXIT

echo
echo "voiceos-eval — end-to-end self-test (no API key required)"
echo "──────────────────────────────────────────────────────────"

# ── 1. Runner + scorecard prints a Ship Score ──────────────────
L1="$TMPDIR_SELF/run.log"
if run_step "runner: node run.js" "$L1" -- node run.js; then
  assert_contains "$L1" "SHIP SCORE" "scorecard prints a Ship Score"
fi

# ── 2. Gate benchmark: 4/4 caught, 0 false blocks ──────────────
L2="$TMPDIR_SELF/gate.log"
if run_step "gate: node gate-benchmark.js" "$L2" -- node gate-benchmark.js; then
  assert_contains "$L2" "4/4 caught" "all 4 wrong-money actions caught & blocked"
  assert_contains "$L2" "False-block rate on good calls: 0%" "0 false blocks on correct actions"
fi

# ── 3. Case generator emits cases from a catalog ───────────────
L3="$TMPDIR_SELF/gen.log"
if run_step "generator: node gen.js" "$L3" -- node gen.js --catalog catalog.json; then
  assert_contains "$L3" "\"cases\"" "generator emits a cases array"
  assert_contains "$L3" "\"utterance\"" "generated cases include utterances"
fi

# ── 4. Safety guard blocks a mismatched call ───────────────────
L4="$TMPDIR_SELF/guard.log"
if run_step "guard: node index.js" "$L4" -- node index.js; then
  assert_contains "$L4" "ok: false" "guard blocks the mismatched call"
  assert_contains "$L4" "ok: true"  "guard passes the correct call"
fi

echo "──────────────────────────────────────────────────────────"
if [ "$FAIL" -eq 0 ]; then
  green "PASS — all $PASS checks passed. voiceos-eval works end to end with no API key."
  echo
  exit 0
else
  red "FAILED — $FAIL check(s) failed, $PASS passed."
  printf 'Failures:%b\n' "$FAILED_STEPS"
  echo
  exit 1
fi
