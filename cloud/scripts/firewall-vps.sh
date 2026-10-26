#!/bin/bash
# Lớp bảo vệ ở nhân Linux trước Docker/HAProxy: SYN flood + giới hạn kết nối mới theo IP.
# Chạy bằng root trên VPS. Docker bỏ qua UFW nên luật đặt ở chuỗi DOCKER-USER. Idempotent.
set -eu
sysctl -w net.ipv4.tcp_syncookies=1 net.ipv4.tcp_max_syn_backlog=4096 net.ipv4.tcp_synack_retries=3 >/dev/null

add() { iptables -C DOCKER-USER "$@" 2>/dev/null || iptables -I DOCKER-USER "$@"; }

for port in "${PUB_PORT_MQTT:-38417}" "${PUB_PORT_MQTTS:-48263}" "${PUB_PORT_WS:-36921}" 443; do
  # lưới thô ở nhân, rộng hơn HAProxy (60/phút): >120 kết nối MỚI / phút / IP / cổng thì drop
  add -p tcp -m conntrack --ctorigdstport "$port" --ctstate NEW \
      -m hashlimit --hashlimit-name "mqtt_$port" --hashlimit-mode srcip \
      --hashlimit-above 120/minute --hashlimit-burst 40 --hashlimit-htable-expire 120000 -j DROP
  # tối đa 100 kết nối đồng thời / IP / cổng (CGNAT: nâng nếu cần)
  add -p tcp -m conntrack --ctorigdstport "$port" --ctstate NEW \
      -m connlimit --connlimit-above 100 --connlimit-mask 32 -j DROP
done
echo "OK. Lưu bền vững: apt install iptables-persistent && netfilter-persistent save"
