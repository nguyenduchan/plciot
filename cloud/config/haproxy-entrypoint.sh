#!/bin/sh
# Chứng chỉ cho cổng MQTTS :8883.
# Ưu tiên chứng chỉ Let's Encrypt của Caddy (volume caddy-data).
# Nếu chưa có (DNS chưa trỏ / chưa bật Caddy) → tạo self-signed để SCADA/gateway
# vẫn nối mqtts:// thẳng IP VPS (C# dùng CloudPinSha256).
set -eu
DOMAIN="${MQTT_DOMAIN:?MQTT_DOMAIN chưa đặt}"
PEM=/tmp/mqtt.pem

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
  build_self_signed
}

ensure_pem

haproxy -W -db -f /usr/local/etc/haproxy/haproxy.cfg &
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
