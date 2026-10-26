#!/bin/sh
# Dùng lại chứng chỉ Let's Encrypt mà Caddy đã xin (volume caddy-data, chỉ đọc) cho cổng MQTTS 8883.
# Gộp crt+key thành /tmp/mqtt.pem; kiểm tra lại mỗi 12 giờ và nạp lại HAProxy khi Caddy gia hạn.
set -eu
DOMAIN="${MQTT_DOMAIN:?MQTT_DOMAIN chưa đặt}"
PEM=/tmp/mqtt.pem

build() {
  crt=$(ls /caddy/caddy/certificates/*/"$DOMAIN"/"$DOMAIN".crt 2>/dev/null | head -n1 || true)
  key=${crt%.crt}.key
  [ -n "$crt" ] && [ -f "$key" ] || return 1
  umask 077
  cat "$crt" "$key" > "$PEM.new"
  if [ -f "$PEM" ] && cmp -s "$PEM" "$PEM.new"; then rm -f "$PEM.new"; return 2; fi
  mv "$PEM.new" "$PEM"
}

i=0
until build; do
  [ $? -eq 2 ] && break
  i=$((i + 1))
  [ "$i" -gt 60 ] && { echo "Chưa có chứng chỉ của $DOMAIN từ Caddy sau 5 phút" >&2; exit 1; }
  sleep 5
done

haproxy -W -db -f /usr/local/etc/haproxy/haproxy.cfg &
pid=$!
trap 'kill -TERM $pid' TERM INT
(
  while sleep 43200; do
    build && kill -USR2 $pid 2>/dev/null || true
  done
) &
wait $pid
