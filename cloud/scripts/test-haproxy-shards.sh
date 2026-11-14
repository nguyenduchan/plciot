#!/bin/bash
# Kiểm tra cấu hình HAProxy (haproxy.cfg + phần nhóm Mosquitto sinh tự động) bằng `haproxy -c` trong container TẠM,
# TRƯỚC khi triển khai thật. Không đụng haproxy đang chạy.
#   bash cloud/scripts/test-haproxy-shards.sh
set -u
cd "$(dirname "$0")/.."
IMG="${HAPROXY_IMAGE:-haproxy:2.8-alpine}"
fail=0
check() { # $1 = MQTT_SHARDS
  out=$(docker run --rm --user root -e MQTT_DOMAIN=test.example.invalid -e MQTT_SHARDS="$1" -e MQTT_RESERVE_CORES=0 -e HAPROXY_CHECK_ONLY=1 \
    -v "$PWD/config/haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro" \
    -v "$PWD/config/trusted.lst:/usr/local/etc/haproxy/trusted.lst:ro" \
    -v "$PWD/config/haproxy-entrypoint.sh:/usr/local/etc/haproxy/haproxy-entrypoint.sh:ro" \
    --entrypoint /bin/sh "$IMG" /usr/local/etc/haproxy/haproxy-entrypoint.sh 2>&1)
  if echo "$out" | grep -q "Configuration file is valid"; then echo "OK   MQTT_SHARDS=$1: cấu hình haproxy hợp lệ ($(echo "$out" | grep -m1 'HAProxy:'))"
  else echo "FAIL MQTT_SHARDS=$1:"; echo "$out" | grep -E "ALERT|WARNING|rror" | head -5; fail=1; fi
}
for n in 1 2 3 8 16 auto bad; do check "$n"; done
[ "$fail" = 0 ] && echo "test-haproxy-shards OK" || { echo "CÓ LỖI"; exit 1; }
