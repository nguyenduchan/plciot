#!/bin/bash
# Kiểm tra mqtt-entrypoint.sh chịu được nhiều SIGHUP: không rò tiến trình "sleep", container không thoát.
# Chạy trên VPS (cần docker): bash cloud/scripts/test-mqtt-hup.sh [số_HUP=300]
set -eu
N="${1:-300}"; DIR=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d); cp -r "$DIR/config/." "$T/"
docker rm -f mqhup-test >/dev/null 2>&1 || true
docker run -d --name mqhup-test -e MQTT_SHARDS=2 --entrypoint /bin/sh --memory 192m --pids-limit 128 \
  -v "$T:/mosquitto/config" eclipse-mosquitto:2 /mosquitto/config/mqtt-entrypoint.sh >/dev/null
trap 'docker rm -f mqhup-test >/dev/null 2>&1; rm -rf "$T"' EXIT
sleep 3
for _ in $(seq 1 "$N"); do docker exec mqhup-test kill -HUP 1; done
sleep 2
st=$(docker inspect -f '{{.State.Running}}' mqhup-test)
procs=$(docker exec mqhup-test ps | wc -l)
echo "running=$st tiến_trình=$procs sau $N HUP"
[ "$st" = true ] && [ "$procs" -lt 20 ] && echo OK || { echo FAIL; exit 1; }
