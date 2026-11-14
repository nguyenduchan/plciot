#!/bin/sh
# Chứng chỉ cho cổng MQTTS :8883.
# Ưu tiên chứng chỉ Let's Encrypt của Caddy (volume caddy-data).
# Nếu chưa có (DNS chưa trỏ / chưa bật Caddy) → tạo self-signed để SCADA/gateway
# vẫn nối mqtts:// thẳng IP VPS (C# dùng CloudPinSha256).
set -eu
DOMAIN="${MQTT_DOMAIN:?MQTT_DOMAIN chưa đặt}"
PEM=/tmp/mqtt.pem
PERSIST=/persist/mqtt.pem   # self-signed được giữ trong volume để KHÔNG đổi dấu vân tay (CloudPinSha256) mỗi lần tạo lại container

build_from_caddy() {
  crt=$(ls /caddy/caddy/certificates/*/"$DOMAIN"/"$DOMAIN".crt 2>/dev/null | head -n1 || true)
  key=${crt%.crt}.key
  [ -n "$crt" ] && [ -f "$key" ] || return 1
  umask 077
  cat "$crt" "$key" > "$PEM.new"
  if [ -f "$PEM" ] && cmp -s "$PEM" "$PEM.new"; then rm -f "$PEM.new"; return 2; fi
  mv "$PEM.new" "$PEM"
  echo "HAProxy MQTTS: dùng chứng chỉ Caddy của $DOMAIN"
  return 0
}

build_self_signed() {
  echo "HAProxy MQTTS: chưa có chứng chỉ Caddy — tạo self-signed cho $DOMAIN (test mqtts thẳng VPS)" >&2
  command -v openssl >/dev/null 2>&1 || apk add --no-cache openssl >/dev/null
  san="DNS:${DOMAIN}"
  if [ -n "${MQTT_PUBLIC_IP:-}" ]; then
    san="${san},IP:${MQTT_PUBLIC_IP}"
  fi
  umask 077
  openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
    -keyout /tmp/mqtt.key -out /tmp/mqtt.crt \
    -subj "/CN=${DOMAIN}" \
    -addext "subjectAltName=${san}"
  cat /tmp/mqtt.crt /tmp/mqtt.key > "$PEM"
  chmod 600 "$PEM"
  mkdir -p /persist 2>/dev/null && cp "$PEM" "$PERSIST" 2>/dev/null || true
  # In SHA-256 (hex) để ghim trên SCADA CloudPinSha256
  openssl x509 -in /tmp/mqtt.crt -outform DER 2>/dev/null | sha256sum | awk '{print "CloudPinSha256="$1}'
}

ensure_pem() {
  set +e
  build_from_caddy
  rc=$?
  set -e
  if [ "$rc" -eq 0 ] || [ "$rc" -eq 2 ]; then
    return 0
  fi
  if [ -f "$PEM" ]; then
    return 0
  fi
  if [ -f "$PERSIST" ]; then
    cp "$PERSIST" "$PEM" && echo "HAProxy MQTTS: dùng lại chứng chỉ self-signed đã lưu (giữ nguyên CloudPinSha256)"
    return 0
  fi
  build_self_signed
}

ensure_pem

# Chia nhóm Mosquitto (MQTT_SHARDS, "auto" = số core − MQTT_RESERVE_CORES; phải khớp config/mqtt-entrypoint.sh):
# mỗi nhóm k ≥ 1 có cổng mqtts nghe :8883+k (công khai = cổng gốc + k) và wss ở đường dẫn /mqtt-k, sinh tự động vào /tmp/haproxy.shards.cfg.
# Nhóm 0 dùng cấu hình tĩnh trong haproxy.cfg (như trước). Nhóm ≥ 1 chỉ có kênh mã hoá (không có mqtt/ws thuần).
SHARDS_CFG=/tmp/haproxy.shards.cfg
: > "$SHARDS_CFG"
N="${MQTT_SHARDS:-1}"
if [ "$N" = "auto" ]; then N=$(( $(nproc 2>/dev/null || echo 1) - ${MQTT_RESERVE_CORES:-1} )); fi
case "$N" in ''|*[!0-9]*) N=1 ;; esac
[ "$N" -ge 1 ] || N=1
[ "$N" -le 16 ] || N=16
k=1
while [ "$k" -lt 16 ]; do
  # backend wss luôn được khai báo cho k=1..15 (haproxy.cfg có use_backend tĩnh cho /mqtt-k); nhóm chưa dùng thì disabled → 503
  if [ "$k" -lt "$N" ]; then ws_state="check inter 5s"; else ws_state="disabled"; fi
  cat >> "$SHARDS_CFG" <<EOF

backend mqtt_ws_secure_$k
    mode http
    server mqtt mqtt:$((9002 + 10 * k)) resolvers docker init-addr libc,none $ws_state
EOF
  if [ "$k" -lt "$N" ]; then
    cat >> "$SHARDS_CFG" <<EOF

backend mqtt_tcp_secure_$k
    server mqtt mqtt:$((1884 + 10 * k)) resolvers docker init-addr libc,none check inter 5s

frontend mqtt_tls_$k
    bind :$((8883 + k)) ssl crt /tmp/mqtt.pem alpn mqtt
    mode tcp
    tcp-request connection accept if { src -f /usr/local/etc/haproxy/trusted.lst }
    tcp-request connection track-sc0 src table t_abuse
    tcp-request connection sc-inc-gpc0(0) if { sc0_conn_rate gt 300 }
    tcp-request connection reject if { sc0_get_gpc0 gt 0 }
    tcp-request connection reject if { sc0_conn_cur gt 30 }
    tcp-request connection reject if { sc0_conn_rate gt 60 }
    tcp-request connection reject if { sc0_bytes_in_rate gt 262144 }
    tcp-request inspect-delay 5s
    tcp-request content accept if { req.len ge 14 } { req.payload(0,1),hex -m str 10 }
    tcp-request content reject
    default_backend mqtt_tcp_secure_$k
EOF
  fi
  k=$((k + 1))
done
echo "HAProxy: $N nhóm Mosquitto (nhóm >= 1: mqtts :8884.. và wss /mqtt-k)"

# Chỉ kiểm tra cấu hình (không chạy): HAPROXY_CHECK_ONLY=1 → dùng khi kiểm thử/triển khai thử
if [ -n "${HAPROXY_CHECK_ONLY:-}" ]; then
  exec haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg -f "$SHARDS_CFG"
fi

haproxy -W -db -f /usr/local/etc/haproxy/haproxy.cfg -f "$SHARDS_CFG" &
pid=$!
trap 'kill -TERM $pid' TERM INT
(
  while sleep 43200; do
    set +e
    build_from_caddy
    rc=$?
    set -e
    if [ "$rc" -eq 0 ]; then
      kill -USR2 $pid 2>/dev/null || true
    fi
  done
) &
wait $pid
