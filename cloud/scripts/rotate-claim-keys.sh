#!/bin/bash
# Chạy trên VPS: ssh plciot-vps "bash -s" < cloud/scripts/rotate-claim-keys.sh
# PHASE TEST: sinh cặp khoá ký tem NGAY TRÊN VPS, đặt cả khoá công khai và khoá riêng vào cloud/.env
# để trang admin tự ký QR mỗi lần bấm "Thêm & tạo QR" / reissue (không ai phải nhớ khoá).
# Tem đã in bằng khoá cũ (gw01/gw02) mất hiệu lực. Trước production: xoá CLAIM_ROOT_PRIVATE_KEY khỏi .env + compose, xoay khoá lại.
set -euo pipefail
cd /root/plciot/cloud
cp .env ".env.bak.$(date +%Y%m%d%H%M%S)"
umask 077
docker exec plciot-app node scripts/provision-device-qr.js gen-keys > .claim-keys.txt
sed -n 2,4p .claim-keys.txt > .claim-pub.pem
sed -n 7,9p .claim-keys.txt > .claim-priv.pem
rm -f .claim-keys.txt
# bỏ khối cũ (nhiều dòng, trong dấu nháy kép) rồi thêm khối mới
perl -0pi -e 's/^CLAIM_ROOT_PUBLIC_KEY="[^"]*"\n//mg; s/^CLAIM_ROOT_PRIVATE_KEY="[^"]*"\n//mg' .env
{
  printf 'CLAIM_ROOT_PUBLIC_KEY="'; sed '$s/$/"/' .claim-pub.pem
  printf 'CLAIM_ROOT_PRIVATE_KEY="'; sed '$s/$/"/' .claim-priv.pem
} >> .env
grep -c '^CLAIM_ROOT_P' .env
COMPOSE_BAKE=false docker compose up -d app 2>&1 | tail -1
sleep 6
docker exec plciot-app sh -c 'test -n "$CLAIM_ROOT_PRIVATE_KEY" && echo priv=OK || echo priv=MISSING'
echo "Xong: vao admin.html -> Them & tao QR."
