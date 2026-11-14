#!/usr/bin/env node
/**
 * Sinh cấu hình chia nhóm Mosquitto (mỗi nhóm một tiến trình, ghim một core).
 *
 *   node scripts/gen-shards.js --cores 4 [--reserve 1] [--shards N] [--out ../shards-out] [--mqtts-port 48263]
 *
 * Số nhóm mặc định = cores - reserve (reserve = số core dành cho app ingest + haproxy + hệ điều hành; mặc định 1).
 * Máy chỉ chạy broker (ingest ở máy khác): --reserve 0.
 * Ghi vào thư mục --out (KHÔNG đụng vào cấu hình đang chạy):
 *   docker-compose.shards.yml   — dịch vụ mqtt-1…mqtt-(N-1), ghim cpuset; nhóm 0 là dịch vụ `mqtt` hiện có (ghim core 1 bằng override)
 *   haproxy.shards.cfg          — backend + frontend MQTTS theo cổng công khai gốc + k, gộp vào config/haproxy.cfg
 *   Caddyfile.shards            — đường dẫn wss /mqtt-k → haproxy ws_behind_caddy
 *   shard<k>/mosquitto.conf     — cấu hình từng nhóm (từ config/mosquitto.conf); acl/passwd do app sinh khi MQTT_SHARDS=N
 * Sau đó đặt MQTT_SHARDS=N cho service app và triển khai theo docs/SHARDING.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def;
};

export function planShards({ cores, reserve = 1, shards = null }) {
  const c = Math.max(1, Number(cores) | 0);
  const r = Math.max(0, Number(reserve) | 0);
  const n = shards != null ? Math.max(1, Number(shards) | 0) : Math.max(1, c - r);
  // nhóm k ghim core (k + reserve) % cores: core 0.. dành cho app/haproxy/OS khi reserve > 0
  return Array.from({ length: n }, (_, k) => ({ k, cpuset: String((k + r) % c) }));
}

export function renderCompose(plan) {
  const lines = ['# Sinh bởi scripts/gen-shards.js — gộp bằng: docker compose -f docker-compose.yml -f docker-compose.shards.yml up -d', 'services:'];
  for (const { k, cpuset } of plan) {
    const name = k === 0 ? 'mqtt' : `mqtt-${k}`;
    if (k === 0) {
      lines.push(`  ${name}:`, `    cpuset: "${cpuset}"`, '    cpus: 1.0');
      continue;
    }
    lines.push(
      `  ${name}:`,
      '    image: eclipse-mosquitto:2',
      `    container_name: plciot-mqtt-${k}`,
      '    restart: unless-stopped',
      '    mem_limit: 256m',
      '    cpus: 1.0',
      `    cpuset: "${cpuset}"`,
      '    pids_limit: 64',
      '    volumes:',
      `      - ./config/shard${k}:/mosquitto/config`,
      `      - mqtt-data-${k}:/mosquitto/data`,
      '    networks: [plciot]',
    );
  }
  lines.push('volumes:');
  for (const { k } of plan) if (k > 0) lines.push(`  mqtt-data-${k}: {}`);
  return lines.join('\n') + '\n';
}

export function renderHaproxy(plan, basePort = 48263) {
  const out = ['# Sinh bởi scripts/gen-shards.js — dán vào config/haproxy.cfg; nhóm 0 dùng backend mqtt_tcp_secure có sẵn.'];
  for (const { k } of plan) {
    if (k === 0) continue;
    out.push(
      '',
      `backend mqtt_tcp_secure_${k}`,
      `    server mqtt mqtt-${k}:1884 resolvers docker init-addr libc,none check inter 5s`,
      '',
      `backend mqtt_ws_secure_${k}`,
      '    mode http',
      `    server mqtt mqtt-${k}:9002 resolvers docker init-addr libc,none check inter 5s`,
      '',
      `frontend mqtt_tls_${k}`,
      `    bind :${8883 + k} ssl crt /tmp/mqtt.pem alpn mqtt   # công khai ${basePort + k} → ${8883 + k} (thêm ports vào compose của haproxy)`,
      '    mode tcp',
      '    tcp-request connection accept if { src -f /usr/local/etc/haproxy/trusted.lst }',
      '    tcp-request connection track-sc0 src table t_abuse',
      '    tcp-request connection sc-inc-gpc0(0) if { sc0_conn_rate gt 300 }',
      '    tcp-request connection reject if { sc0_get_gpc0 gt 0 }',
      '    tcp-request connection reject if { sc0_conn_cur gt 30 }',
      '    tcp-request connection reject if { sc0_conn_rate gt 60 }',
      '    tcp-request connection reject if { sc0_bytes_in_rate gt 262144 }',
      '    tcp-request inspect-delay 5s',
      '    tcp-request content accept if { req.len ge 14 } { req.payload(0,1),hex -m str 10 }',
      '    tcp-request content reject',
      `    default_backend mqtt_tcp_secure_${k}`,
    );
  }
  // WebSocket (wss qua Caddy): chọn backend theo đường dẫn do Caddy giữ nguyên /mqtt-k
  const k2 = plan.filter((p) => p.k > 0);
  if (k2.length) {
    out.push('', '# Trong frontend ws_behind_caddy, thêm TRƯỚC default_backend:');
    for (const { k } of k2) out.push(`#   use_backend mqtt_ws_secure_${k} if { path_beg /mqtt-${k} }`);
  }
  return out.join('\n') + '\n';
}

export function renderCaddy(plan) {
  const out = ['# Sinh bởi scripts/gen-shards.js — thêm vào site có /mqtt hiện tại (giữ nguyên đường dẫn, HAProxy tách theo /mqtt-k)'];
  for (const { k } of plan) if (k > 0) out.push(`handle /mqtt-${k}* {\n    reverse_proxy haproxy:9002\n}`);
  return out.join('\n') + '\n';
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cores = Number(arg('cores', 2));
  const reserve = Number(arg('reserve', 1));
  const shards = arg('shards', null);
  const plan = planShards({ cores, reserve, shards });
  const out = path.resolve(arg('out', path.join(here, '..', '..', 'shards-out')));
  const basePort = Number(arg('mqtts-port', 48263));
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'docker-compose.shards.yml'), renderCompose(plan));
  fs.writeFileSync(path.join(out, 'haproxy.shards.cfg'), renderHaproxy(plan, basePort));
  fs.writeFileSync(path.join(out, 'Caddyfile.shards'), renderCaddy(plan));
  const confSrc = path.join(here, '..', '..', 'config', 'mosquitto.conf');
  if (fs.existsSync(confSrc)) {
    for (const { k } of plan) {
      if (k === 0) continue;
      fs.mkdirSync(path.join(out, `shard${k}`), { recursive: true });
      fs.copyFileSync(confSrc, path.join(out, `shard${k}`, 'mosquitto.conf'));
    }
  }
  console.log(`${plan.length} nhóm Mosquitto cho ${cores} core (dành riêng ${reserve} core): ${plan.map((p) => `#${p.k}→core ${p.cpuset}`).join(', ')}`);
  console.log(`Đã ghi vào ${out}. Đặt MQTT_SHARDS=${plan.length} cho service app, rồi theo docs/SHARDING.md.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
