#!/bin/bash
# Sign every Mach-O leaf binary in the bundle inside-out, then frameworks and
# helpers (which include nested binaries), then the main app. Defaults to
# ad-hoc (identity "-") for local-machine launch; pass a real Developer ID
# identity as $2 for distribution.
set -e
APP="$1"
ID="${2:--}"
[ -d "$APP" ] || { echo "usage: $0 path/to/app.app [identity]"; exit 2; }

# 1. Sign every Mach-O file by inspecting magic bytes. Covers .dylib, .node,
#    spawn-helper, chrome_crashpad_handler, and anything else.
while IFS= read -r -d '' f; do
  head -c 4 "$f" | LC_ALL=C grep -qE '^(\xcf\xfa\xed\xfe|\xca\xfe\xba\xbe|\xfe\xed\xfa\xcf|\xbe\xba\xfe\xca)' \
    && codesign --force --sign "$ID" --timestamp=none "$f" >/dev/null 2>&1 || true
done < <(find "$APP" -type f -print0)

# 2. Sign frameworks (each version dir, then the framework itself).
while IFS= read -r -d '' fw; do
  for v in "$fw/Versions/"*/; do
    [ -d "$v" ] && codesign --force --sign "$ID" --timestamp=none "$v" >/dev/null 2>&1 || true
  done
  codesign --force --sign "$ID" --timestamp=none "$fw" >/dev/null 2>&1 || true
done < <(find "$APP/Contents/Frameworks" -maxdepth 1 -name "*.framework" -print0 2>/dev/null)

# 3. Sign helper apps (each one is a mini-bundle).
while IFS= read -r -d '' helper; do
  codesign --force --sign "$ID" --timestamp=none "$helper" >/dev/null 2>&1 || true
done < <(find "$APP/Contents/Frameworks" -maxdepth 1 -name "*.app" -print0 2>/dev/null)

# 4. Sign the main bundle last.
codesign --force --sign "$ID" --timestamp=none "$APP" >/dev/null 2>&1
codesign --verify --strict "$APP" 2>&1 | head -3
echo "Signed: $APP (identity: $ID)"
