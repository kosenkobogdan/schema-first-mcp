#!/bin/sh
set -eu
mkdir -p /tmp/whisper-public
whisper-server \
  -m "${WHISPER_MODEL}" \
  -t 1 \
  -p 1 \
  -l auto \
  -bs 1 \
  -bo 1 \
  -nf \
  -nlp \
  --host 127.0.0.1 \
  --port 8091 \
  --public /tmp/whisper-public \
  >/tmp/whisper-server.log 2>&1 &

ready=0
i=0
while [ "$i" -lt 90 ]; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:8091/ || true)
  if [ -n "$code" ] && [ "$code" != "000" ]; then
    ready=1
    break
  fi
  i=$((i + 1))
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "whisper-server did not start" >&2
  cat /tmp/whisper-server.log >&2 || true
  exit 1
fi
exec node src/index.js
