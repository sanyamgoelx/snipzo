#!/bin/bash
# Checks the built Mac app: signature, architecture, bundled ffmpeg, menu-bar-only flag, .dmg contents.
set -e
APP=$(find dist -maxdepth 2 -name Snipzo.app -type d | head -1); echo "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv "$APP" 2>&1 | grep -E "Signature|Identifier|Format"
lipo -archs "$APP/Contents/MacOS/Snipzo"
FF=$(find "$APP" -path '*ffmpeg-static/ffmpeg' -type f | head -1); echo "$FF"; lipo -archs "$FF"; "$FF" -hide_banner -version | head -1
/usr/libexec/PlistBuddy -c 'Print :LSUIElement' "$APP/Contents/Info.plist"
DMG=$(ls dist/*.dmg | head -1); hdiutil attach -nobrowse -mountpoint /tmp/snz "$DMG"
test -d /tmp/snz/Snipzo.app && test -L /tmp/snz/Applications && echo "dmg holds Snipzo.app + Applications link"
hdiutil detach /tmp/snz
# sizes, as a notice (the download people get)
SZ=$( { ls -l dist/*.dmg | awk '{printf "%s %.0f MB\n", $NF, $5/1048576}'; du -sm "$APP/Contents/Frameworks" "$APP/Contents/Resources/app.asar" "$APP/Contents/Resources/app.asar.unpacked/node_modules/"* 2>/dev/null | sort -rn | awk '{printf "%s MB %s\n", $1, $2}'; } | sed "s#$APP/Contents/##" | awk 'BEGIN{ORS="%0A"} {print}')
echo "::notice title=Mac app sizes::$SZ"
echo "::notice title=Inside app.asar::$(node ci/asar-sizes.js "$APP/Contents/Resources/app.asar")"
