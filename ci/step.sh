#!/bin/bash
# Runs a CI step, keeps its output, and when it fails posts the last lines as an error annotation.
# (Annotations can be read through GitHub's API; the raw job logs live on a storage host some tools can't reach.)
# usage: bash ci/step.sh "<title>" <command...>
title="$1"; shift
log="$(mktemp)"
set -o pipefail
"$@" 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
if [ "$code" != "0" ]; then
  tail -n 80 "$log" | cut -c1-300 | grep -v '^\s*$' | tail -n 60 > "$log.tail"
  msg=$(sed -e 's/%/%25/g' -e 's/\r/%0D/g' "$log.tail" | awk 'BEGIN{ORS="%0A"} {print}')
  echo "::error title=${title} (exit ${code})::${msg}"
fi
exit "$code"
