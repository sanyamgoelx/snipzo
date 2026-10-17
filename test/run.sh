#!/bin/bash
# Linux end-to-end test: xvfb + compositor + Snipzo in test mode
cd "$(dirname "$0")/.."
export SNIPZO_TEST=1 SNIPZO_FAKE_AUDIO=1 SNIPZO_FAKE_WINDOWS="$PWD/test/fake-windows.json" SNIPZO_SHOTS="${SNIPZO_SHOTS:-/tmp/snipzo-shots}"
export SNIPZO_FFMPEG=$(which ffmpeg) SNIPZO_FFPROBE=$(which ffprobe)
# GitHub's runners set XDG_CONFIG_HOME, which moves Electron's settings folder away from HOME
export SNIPZO_HOLDING_BASE=/tmp/snipzo-holding HOME=/tmp/snipzo-home XDG_CONFIG_HOME=/tmp/snipzo-home/.config
rm -rf "$SNIPZO_SHOTS" /tmp/snipzo-home; mkdir -p /tmp/snipzo-home/Videos /tmp/snipzo-home/.config/snipzo && echo 1 > /tmp/snipzo-home/.config/snipzo/seen-welcome
xvfb-run -a -s "-screen 0 1600x900x24" bash -c 'xcompmgr -n & sleep 0.5; timeout 90 npx electron . --no-sandbox --disable-gpu 2>&1 | grep -v "dbus\|Gtk\|libva\|viz_main\|gpu_init\|sandbox" ; kill %1 2>/dev/null'
