#!/usr/bin/env bash
# Install the packed SDK into an empty project / fresh venv on this runner and
# run the README flow against a local mock model (no account, no desktop app).
#   scripts/e2e/install-test.sh <pkgs-dir> <npm-target> <wheel-tag>
set -euo pipefail
PKGS=$(cd "$1" && pwd); TARGET=$2; TAG=$3
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
export CTENO_SDK_HOME="$WORK/sdk-home" MOCK_PORT=18996 MOCK_CALL_TOOL=shell MOCK_LOG="$WORK/mock.log"
case "$TARGET" in win32-*) export MOCK_PROBE_CMD='New-Item -ItemType File -Force sdk-probe.txt | Out-Null'; PY=python ;; *) PY=python3 ;; esac
"$PY" "$HERE/mock-llm.py" & MOCK=$!
trap 'kill $MOCK 2>/dev/null || true' EXIT
sleep 2
export MOCK_URL="http://127.0.0.1:$MOCK_PORT/v1"

mkdir "$WORK/app" && cd "$WORK/app" && npm init -y >/dev/null
SDK=$(ls "$PKGS"/cteno-sdk-[0-9]*.tgz)
npm install --no-audit --no-fund "$PKGS/cteno-sdk-$TARGET-"*.tgz "$SDK"
cp "$HERE/consumer.mjs" . && node consumer.mjs | grep -v -- '-frames"' | tee "$WORK/node.txt"
# Regression (2.10.11): restart on the SAME home, request immediately after open().
cp "$HERE/restart-immediate.mjs" . && node restart-immediate.mjs | tee -a "$WORK/node.txt"

"$PY" -m venv "$WORK/venv"
VPY="$WORK/venv/bin/python"; [ -x "$VPY" ] || VPY="$WORK/venv/Scripts/python.exe"
"$VPY" -m pip install -q --no-index "$PKGS"/cteno_sdk-*-py3-none-"$TAG".whl
# Python runs on the home Node already used: this is a second start too.
mkdir "$WORK/py" && cd "$WORK/py" && "$VPY" "$HERE/consumer.py" | tee "$WORK/py.txt"
mkdir "$WORK/py2" && cd "$WORK/py2" && "$VPY" "$HERE/consumer.py" | tee -a "$WORK/py.txt"
if grep -Eq '"ok": ?false' "$WORK/node.txt" "$WORK/py.txt"; then echo "install-test: FAIL ($TARGET)"; exit 1; fi
grep -Eq '"check": ?"quickstart", ?"ok": ?true' "$WORK/py.txt" || { echo "install-test: FAIL (python quickstart)"; exit 1; }
echo "install-test: PASS ($TARGET)"
