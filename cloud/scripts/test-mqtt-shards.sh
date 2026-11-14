#!/bin/bash
# Kiểm thử cấu hình tự động của Mosquitto nhiều nhóm (config/mqtt-entrypoint.sh) bằng container TẠM, không đụng broker đang chạy.
#   bash cloud/scripts/test-mqtt-shards.sh        # chạy trên máy có Docker (VPS)
# Kiểm: N=1 đi thẳng như cũ; N=3 tạo đúng 3 tiến trình, cổng gốc+10k, passwd/acl riêng, ghim core khác nhau, SIGHUP, tự khởi động lại, auto.
set -u
cd "$(dirname "$0")/.."
IMG="${MQTT_IMAGE:-eclipse-mosquitto:2}"
TMP=$(mktemp -d)
trap 'docker rm -f mqtt-shard-test >/dev/null 2>&1; rm -rf "$TMP"' EXIT
mkdir -p "$TMP/config" "$TMP/data"
cp config/mosquitto.conf config/mqtt-entrypoint.sh "$TMP/config/"
# dữ liệu thử: nhóm 0 dùng passwd/acl giả (rỗng) - broker vẫn chạy
: > "$TMP/config/passwd"; : > "$TMP/config/acl"; : > "$TMP/config/acl-monitor"
chmod -R a+rwX "$TMP"
fail=0
ok() { if [ "$1" = 1 ]; then echo "OK   $2"; else echo "FAIL $2"; fail=1; fi; }
run() { # $1 = MQTT_SHARDS
  docker rm -f mqtt-shard-test >/dev/null 2>&1
  docker run -d --name mqtt-shard-test -e MQTT_SHARDS="$1" -v "$TMP/config:/mosquitto/config" -v "$TMP/data:/mosquitto/data" \
    --entrypoint /bin/sh "$IMG" /mosquitto/config/mqtt-entrypoint.sh >/dev/null
  sleep 4
}
procs() { docker exec mqtt-shard-test sh -c 'pidof mosquitto | wc -w'; }
ports() { docker exec mqtt-shard-test sh -c "netstat -ltn 2>/dev/null | awk '/LISTEN/ {n=split(\$4,a,\":\"); print a[n]}' | sort -n | tr '\n' ' '"; }

# --- N=1: chạy thẳng, một tiến trình, cổng cũ
run 1
ok "$([ "$(procs)" = 1 ] && echo 1 || echo 0)" "N=1: một tiến trình Mosquitto (chạy như trước)"
P=$(ports); ok "$(echo "$P" | grep -q '1883' && echo "$P" | grep -q '1884' && echo "$P" | grep -q '9002' && ! echo "$P" | grep -q '1893' && echo 1 || echo 0)" "N=1: cổng 1883/1884/1885/9001/9002 như cũ ($P)"

# --- N=3
run 3
ok "$([ "$(procs)" = 3 ] && echo 1 || echo 0)" "N=3: ba tiến trình Mosquitto"
P=$(ports)
for p in 1883 1884 1885 9001 9002 1893 1894 1895 9011 9012 1903 1904 1905 9021 9022; do echo "$P" | grep -qw "$p" || { echo "thiếu cổng $p"; fail=1; }; done
ok "$([ "$fail" = 0 ] && echo 1 || echo 0)" "N=3: mỗi nhóm nghe cổng gốc + 10k ($P)"
ok "$(docker exec mqtt-shard-test sh -c '[ -f /mosquitto/config/shard1/passwd ] && [ -f /mosquitto/config/shard2/acl ] && [ -d /mosquitto/data/shard2 ]' && echo 1 || echo 0)" "N=3: passwd/acl/dữ liệu riêng từng nhóm"
AFF=$(docker exec mqtt-shard-test sh -c 'for p in $(pidof mosquitto); do taskset -p $p; done 2>/dev/null' | awk '{print $NF}' | sort -u | wc -l)
NC=$(docker exec mqtt-shard-test nproc)
if [ "$NC" -ge 3 ]; then ok "$([ "$AFF" = 3 ] && echo 1 || echo 0)" "N=3: ba tiến trình ghim ba core khác nhau ($AFF mặt nạ khác nhau trên $NC core)"; else echo "BỎ QUA ghim core: máy chỉ có $NC core"; fi
ok "$(docker exec mqtt-shard-test sh -c "grep -c '^listener' /tmp/mosq-shard2.conf | grep -q 5 && grep -q 'password_file /mosquitto/config/shard2/passwd' /tmp/mosq-shard2.conf && grep -q 'persistence_location /mosquitto/data/shard2/' /tmp/mosq-shard2.conf" && echo 1 || echo 0)" "N=3: cấu hình nhóm 2 sinh đúng đường dẫn"

# --- SIGHUP: vẫn 3 tiến trình
docker kill -s HUP mqtt-shard-test >/dev/null; sleep 2
ok "$([ "$(procs)" = 3 ] && echo 1 || echo 0)" "SIGHUP tới container: cả 3 tiến trình còn chạy"

# --- một nhóm chết → tự khởi động lại
docker exec mqtt-shard-test sh -c 'kill -9 $(pidof mosquitto | cut -d" " -f1)'
sleep 5
ok "$([ "$(procs)" = 3 ] && echo 1 || echo 0)" "một nhóm bị kill → tự khởi động lại (3 tiến trình)"

# --- auto
docker rm -f mqtt-shard-test >/dev/null 2>&1
docker run -d --name mqtt-shard-test -e MQTT_SHARDS=auto -e MQTT_RESERVE_CORES=0 -v "$TMP/config:/mosquitto/config" -v "$TMP/data:/mosquitto/data" \
  --entrypoint /bin/sh "$IMG" /mosquitto/config/mqtt-entrypoint.sh >/dev/null
sleep 4
NC=$(docker exec mqtt-shard-test nproc)
ok "$([ "$(procs)" = "$NC" ] && echo 1 || echo 0)" "auto + reserve 0: $NC tiến trình = $NC core"

# --- dừng sạch
docker stop -t 5 mqtt-shard-test >/dev/null 2>&1
ok "$([ "$(docker inspect -f '{{.State.ExitCode}}' mqtt-shard-test)" = 0 ] && echo 1 || echo 0)" "docker stop: thoát sạch (mã 0)"

[ "$fail" = 0 ] && echo "test-mqtt-shards OK" || { echo "CÓ LỖI"; exit 1; }
