#!/usr/bin/env bash
# Chuyển toàn bộ hệ thống sang VPS MỚI. CHẠY TRÊN VPS MỚI (đã cài docker, git; có SSH vào VPS cũ).
#
#   bash migrate-vps.sh <ssh-vps-cũ> [/root/plciot] [--dry-run]
#   vd: bash migrate-vps.sh root@14.225.224.218
#
# Làm gì (không tắt VPS cũ, không đổi DNS):
#   1. Chụp bản DB nhất quán trên VPS cũ (API backup, app vẫn chạy)
#   2. Chép mã nguồn + cloud/.env + config (passwd, acl, shard*) qua rsync
#   3. Chép dữ liệu app (trừ app.db đang chạy) + bản chụp DB thành app.db mới
#   4. Chép các docker volume QUAN TRỌNG: chứng chỉ MQTTS tự ký (giữ nguyên hash ghim → gateway không biết đã đổi máy),
#      hàng đợi/phiên MQTT, dữ liệu caddy
#   5. Khởi động bằng docker compose và chạy kiểm tra
# Cắt DNS làm tay sau khi kiểm tra xong (xem docs/MIGRATE-VPS.md).
set -euo pipefail

OLD="${1:?usage: migrate-vps.sh <ssh-vps-cũ> [đường-dẫn] [--dry-run]}"
DIR="${2:-/root/plciot}"
DRY=""; for a in "$@"; do [ "$a" = "--dry-run" ] && DRY="--dry-run"; done
case "$DIR" in --*) DIR=/root/plciot;; esac

say() { printf '\n== %s\n' "$*"; }
command -v rsync >/dev/null || { echo "Cần rsync: apt-get install -y rsync"; exit 1; }
command -v docker >/dev/null || { echo "Cần docker"; exit 1; }
ssh -o BatchMode=yes "$OLD" true || { echo "Không SSH được vào $OLD (thêm khoá công khai của máy này vào authorized_keys của máy cũ)"; exit 1; }

say "Kiểm tra chỗ trống"
need_kb=$(ssh "$OLD" "du -sk $DIR --exclude=node_modules 2>/dev/null | cut -f1")
free_kb=$(df -k --output=avail "$(dirname "$DIR")" | tail -1)
echo "Cần ~$((need_kb/1024)) MB (+ bản chụp DB), còn trống $((free_kb/1024)) MB"
[ "$free_kb" -gt $((need_kb*2)) ] || { echo "Không đủ chỗ trống (cần ≥ 2× kích thước hiện tại)"; exit 1; }

say "1. Chụp DB nhất quán trên VPS cũ"
ssh "$OLD" "docker exec plciot-app node scripts/db-snapshot.js /app/data/backups/migrate-snapshot.db"

say "2. Chép mã nguồn, .env, config"
mkdir -p "$DIR"
rsync -aH $DRY --info=stats1 --exclude 'node_modules' --exclude 'cloud/app/data' "$OLD:$DIR/" "$DIR/"

say "3. Chép dữ liệu app (không chép app.db/-wal/-shm đang chạy)"
mkdir -p "$DIR/cloud/app/data"
rsync -aH $DRY --info=stats1 --exclude 'app.db' --exclude 'app.db-wal' --exclude 'app.db-shm' --exclude 'backups/migrate-snapshot.db' "$OLD:$DIR/cloud/app/data/" "$DIR/cloud/app/data/"
rsync -a $DRY --progress "$OLD:$DIR/cloud/app/data/backups/migrate-snapshot.db" "$DIR/cloud/app/data/app.db.incoming"
if [ -z "$DRY" ]; then
  rm -f "$DIR/cloud/app/data/app.db-wal" "$DIR/cloud/app/data/app.db-shm"
  mv "$DIR/cloud/app/data/app.db.incoming" "$DIR/cloud/app/data/app.db"
  chmod 600 "$DIR/cloud/app/data/app.db"
fi

say "4. Chép docker volume (chứng chỉ MQTTS, phiên MQTT, caddy)"
for v in plciot_mqtt-cert plciot_mqtt_data plciot_caddy_data; do
  echo "- $v"
  if [ -z "$DRY" ]; then
    docker volume create "$v" >/dev/null
    ssh "$OLD" "docker run --rm -v $v:/v alpine tar czf - -C /v ." | docker run --rm -i -v "$v":/v alpine tar xzf - -C /v
  fi
done

[ -n "$DRY" ] && { say "Chạy thử (--dry-run) xong: chưa ghi gì quan trọng."; exit 0; }

say "5. Khởi động"
cd "$DIR/cloud"
docker compose up -d --build
sleep 15
docker compose ps
docker exec plciot-app node scripts/verify-backup.js /app/data/app.db || { echo "DB mới lỗi kiểm tra"; exit 1; }

cat <<EOF

XONG phần chép. Còn lại (làm tay, theo thứ tự):
  1. Thử bằng hosts-file/SSH tunnel: đăng nhập web + admin, xem lịch sử, gateway thử kết nối tới IP máy mới.
  2. Hạ TTL DNS xuống 60s từ trước; đổi bản ghi của tên miền MQTT (DNS only) sang IP máy này; đổi tunnel/Cloudflare cho web.
  3. Gateway sẽ tự kết nối lại; theo dõi: docker logs -f plciot-app
  4. Giữ VPS cũ ≥ 7 ngày rồi mới xoá. Khoá SSH, ADMIN_*, Face ID: kiểm tra lại trên máy mới (cloud/.env đã chép).
EOF
