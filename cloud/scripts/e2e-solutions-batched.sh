#!/bin/sh
# Chạy e2e giải pháp theo lô nhỏ TRÊN VPS (host), giữa các lô kiểm tra broker còn sống (thu hồi/tạo gateway dồn dập từng làm
# container plciot-mqtt thoát; nếu dừng thì tự khởi động lại broker + HAProxy rồi chạy tiếp).
#   sh cloud/scripts/e2e-solutions-batched.sh [kích_thước_lô] id1 id2 ...      (mặc định: mọi giải pháp có gateway/setup.json)
set -u
N=${1:-3}; shift 2>/dev/null || true
IDS="$*"
[ -n "$IDS" ] || IDS=$(docker exec plciot-app sh -c 'for d in /app/solutions/*/; do [ -f "$d/gateway/setup.json" ] && basename "$d"; done')
alive() { [ "$(docker inspect -f '{{.State.Running}}' plciot-mqtt 2>/dev/null)" = true ]; }
revive() { alive || { echo "!! broker dừng → khởi động lại"; docker start plciot-mqtt >/dev/null; sleep 6; docker restart plciot-haproxy >/dev/null; sleep 8; }; }
set -- $IDS; fails=0
while [ $# -gt 0 ]; do
  batch=""; i=0
  while [ $i -lt "$N" ] && [ $# -gt 0 ]; do batch="$batch $1"; shift; i=$((i+1)); done
  revive
  docker exec -w /app -e E2E_SOLUTIONS=/app/solutions plciot-app node scripts/e2e-solutions.js $batch || fails=$((fails+1))
  sleep 15
done
revive
echo "xong; lô lỗi: $fails"
