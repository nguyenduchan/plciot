#!/usr/bin/env bash
# Test ACL topic gw/<mqttId>/<kind> trên MỘT BROKER MOSQUITTO THẬT (container tạm), không đụng broker/DB đang chạy.
# Cần: Docker và container trợ giúp `plciot-test` (xem memory/CLAUDE.md: image plciot-app, symlink /cloud/app → /app, đã copy src+scripts).
#   bash cloud/scripts/test-broker-acl.sh
set -euo pipefail
export MSYS_NO_PATHCONV=1
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'docker rm -f mqtest-broker >/dev/null 2>&1; docker network rm mqtest >/dev/null 2>&1; rm -rf "$TMP"' EXIT
WIN() { command -v cygpath >/dev/null && cygpath -m "$1" || echo "$1"; }
ROOTW="$(WIN "$ROOT")"

docker cp "$ROOTW/cloud/app/src" plciot-test:/app/ >/dev/null
docker cp "$ROOTW/cloud/app/scripts" plciot-test:/app/ >/dev/null
docker exec plciot-test sh -c "find /app/src /app/scripts -name '*.js' -exec sed -i 's/\r$//' {} +; rm -rf /tmp/mq"
docker exec -w /app plciot-test node scripts/gen-broker-test-config.js /tmp/mq
docker cp plciot-test:/tmp/mq/. "$(WIN "$TMP")"
cp "$ROOT/cloud/config/mosquitto.conf" "$TMP/mosquitto.conf"
docker run --rm -v "$(WIN "$TMP"):/c" eclipse-mosquitto:2 sh /c/mkpw.sh >/dev/null 2>&1
docker network create mqtest >/dev/null 2>&1 || true
docker run -d --name mqtest-broker --network mqtest -v "$(WIN "$TMP"):/mosquitto/config" eclipse-mosquitto:2 >/dev/null
docker network connect mqtest plciot-test >/dev/null 2>&1 || true
sleep 3
docker cp "$(WIN "$TMP")/info.json" plciot-test:/tmp/info.json
docker exec -w /app -e INFO=/tmp/info.json -e BROKER=mqtt://mqtest-broker:1883 -e BROKER_CTL=mqtt://mqtest-broker:1884 plciot-test node scripts/smoke-mqtt-id-broker.js
