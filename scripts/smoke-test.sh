#!/usr/bin/env bash
# Post-build smoke test — validates the packed artifact before publish.
# Checks: dist files exist, CLI runs, key subpath imports resolve.
set -euo pipefail

echo "=== Arc Smoke Test ==="

# 1. Check critical dist files exist
echo "[1/4] Checking dist artifacts..."
for f in dist/index.mjs dist/index.d.mts dist/factory/index.mjs dist/factory/index.d.mts \
         dist/scope/index.mjs dist/permissions/index.mjs dist/cli/commands/doctor.mjs; do
  if [ ! -f "$f" ]; then
    echo "FAIL: Missing $f"
    exit 1
  fi
done
echo "  All critical dist files present."

# 2. CLI smoke test
echo "[2/4] Testing CLI..."
node bin/arc.js --help > /dev/null 2>&1 || { echo "FAIL: arc --help"; exit 1; }
echo "  arc --help OK"

# 3. Key subpath imports resolve
echo "[3/4] Testing subpath imports..."
node -e "import('@classytic/arc').then(() => console.log('  @classytic/arc OK'))" 2>/dev/null || \
  node -e "import('./dist/index.mjs').then(() => console.log('  dist/index.mjs OK'))"
node -e "import('./dist/factory/index.mjs').then(() => console.log('  dist/factory/index.mjs OK'))"
node -e "import('./dist/scope/index.mjs').then(() => console.log('  dist/scope/index.mjs OK'))"
node -e "import('./dist/permissions/index.mjs').then(() => console.log('  dist/permissions/index.mjs OK'))"

# 4. Packed tarball check
echo "[4/4] Checking npm pack..."
TARBALL=$(npm pack --dry-run 2>&1 | tail -1)
echo "  Pack: $TARBALL"

echo ""
echo "=== Smoke Test Passed ==="
