#!/usr/bin/env bash
set -uo pipefail
mkdir -p /logs/verifier
# This only checks delivery presence. Independent RSI acceptance runs after export.
if test -f /workspace/repository/.gepa/recipe.yaml &&
  test -f /workspace/repository/.gepa/extension/index.mjs &&
  node --check /workspace/repository/.gepa/extension/index.mjs; then
  printf '1\n' > /logs/verifier/reward.txt
else
  printf '0\n' > /logs/verifier/reward.txt
fi
