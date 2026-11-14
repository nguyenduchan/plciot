#!/bin/sh
# Chạy N tiến trình Mosquitto trong MỘT container, N theo cấu hình MQTT_SHARDS (số, hoặc "auto" = số core − MQTT_RESERVE_CORES).
# Mỗi tiến trình (một "nhóm") ghim một core bằng taskset, nghe cổng = cổng gốc + 10×k, dùng passwd/acl/dữ liệu riêng:
#   nhóm 0: /mosquitto/config/{passwd,acl,acl-monitor}, /mosquitto/data         (giữ nguyên đường dẫn cũ)
#   nhóm k: /mosquitto/config/shard<k>/{…}, /mosquitto/data/shard<k>             (app plciot-app ghi ACL/passwd từng nhóm)
# Cấu hình mỗi nhóm sinh tự động từ /mosquitto/config/mosquitto.conf (đổi cổng, đường dẫn, memory_limit chia đều).
# N=1: chạy thẳng như trước (không giám sát, không đổi gì). SIGHUP gửi tới container được chuyển cho mọi nhóm.
# MQTT_DRY_RUN=1: chỉ sinh cấu hình ra /tmp/mosq-shard<k>.conf và in kế hoạch, không chạy broker (dùng khi kiểm thử).
set -eu

CONF_DIR="${MQTT_CONF_DIR:-/mosquitto/config}"
DATA_DIR="${MQTT_DATA_DIR:-/mosquitto/data}"
OUT_DIR="${MQTT_OUT_DIR:-/tmp}"
STRIDE=10
MAXN=16

cores=$(nproc 2>/dev/null || echo 1)
N="${MQTT_SHARDS:-1}"
if [ "$N" = "auto" ]; then
  N=$((cores - ${MQTT_RESERVE_CORES:-1}))
fi
case "$N" in ''|*[!0-9]*) N=1 ;; esac
[ "$N" -ge 1 ] || N=1
[ "$N" -le "$MAXN" ] || N=$MAXN

if [ "$N" -le 1 ] && [ -z "${MQTT_DRY_RUN:-}" ]; then
  exec /docker-entrypoint.sh mosquitto -c "$CONF_DIR/mosquitto.conf"
fi

# Giới hạn RAM của container (cgroup) chia đều cho các nhóm → memory_limit mỗi tiến trình; "max"/không đọc được = giữ nguyên.
memlimit=""
for f in /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes; do
  if [ -r "$f" ]; then v=$(cat "$f"); case "$v" in ''|max|*[!0-9]*) ;; *) memlimit=$v ;; esac; break; fi
done
per=""
if [ -n "$memlimit" ] && [ "$memlimit" -lt 100000000000 ]; then
  per=$((memlimit * 85 / 100 / N))
  if [ "$per" -lt 50000000 ]; then
    echo "CẢNH BÁO: RAM container $((memlimit / 1048576)) MB cho $N nhóm là ít (< 60 MB/nhóm) — tăng MQTT_MEM_LIMIT" >&2
  fi
fi

off="${MQTT_CORE_OFFSET:-}"
if [ -z "$off" ]; then
  if [ "$cores" -gt "$N" ]; then off=1; else off=0; fi    # chừa core 0 cho app/haproxy/hệ điều hành khi còn core
fi

have_taskset=0
command -v taskset >/dev/null 2>&1 && have_taskset=1

gen_conf() {  # $1 = nhóm k → in đường dẫn file cấu hình
  k=$1
  if [ "$k" -eq 0 ]; then cdir="$CONF_DIR"; ddir="$DATA_DIR"; else cdir="$CONF_DIR/shard$k"; ddir="$DATA_DIR/shard$k"; fi
  mkdir -p "$cdir" "$ddir"
  for f in passwd acl acl-monitor; do [ -e "$cdir/$f" ] || : > "$cdir/$f"; done   # app ghi nội dung thật; file phải tồn tại để broker khởi động
  out="$OUT_DIR/mosq-shard$k.conf"
  awk -v k="$k" -v stride="$STRIDE" -v cdir="$cdir" -v ddir="$ddir" -v per="$per" '
    /^listener[ \t]+[0-9]+/ { printf "listener %d\n", $2 + stride * k; next }
    /^(password_file|acl_file)[ \t]/ { n = split($2, p, "/"); printf "%s %s/%s\n", $1, cdir, p[n]; next }
    /^persistence_location[ \t]/ { printf "persistence_location %s/\n", ddir; next }
    /^memory_limit[ \t]/ && per != "" { printf "memory_limit %d\n", per; next }
    { print }
  ' "$CONF_DIR/mosquitto.conf" > "$out"
  chmod 644 "$out"
  echo "$out"
}

echo "Mosquitto: $N nhóm trên $cores core (core đầu = $off)"
chown -R mosquitto:mosquitto /mosquitto 2>/dev/null || true
k=0
sups=""
while [ "$k" -lt "$N" ]; do
  cfg=$(gen_conf "$k")
  core=$(((k + off) % cores))
  ports=$(awk '/^listener/ {printf "%s ", $2}' "$cfg")
  echo "  nhóm $k: core $core, cổng $ports, cấu hình $cfg"
  if [ -z "${MQTT_DRY_RUN:-}" ]; then
    (
      while :; do
        if [ "$have_taskset" -eq 1 ]; then taskset -c "$core" mosquitto -c "$cfg" || true; else mosquitto -c "$cfg" || true; fi
        echo "Mosquitto nhóm $k thoát, khởi động lại sau 2 s" >&2
        sleep 2
      done
    ) &
    sups="$sups $!"
  fi
  k=$((k + 1))
done

[ -z "${MQTT_DRY_RUN:-}" ] || exit 0

trap 'for p in $(pidof mosquitto); do kill -HUP "$p" 2>/dev/null || true; done' HUP
trap 'kill $sups 2>/dev/null || true; for p in $(pidof mosquitto); do kill -TERM "$p" 2>/dev/null || true; done; exit 0' TERM INT
# wait bị trap ngắt trả mã > 128: không để set -e thoát
while :; do sleep 3600 & wait $! || true; done
