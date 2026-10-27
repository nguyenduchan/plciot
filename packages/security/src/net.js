/** IP của client sau proxy, "mạng" của một IP và so khớp CIDR. */

function v4(ip) {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(ip || '');
  return m ? m.slice(1).map(Number) : null;
}

function expandV6(ip) {
  if (!ip.includes(':')) return null;
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = ip.includes('::') ? new Array(Math.max(0, 8 - h.length - t.length)).fill('0') : [];
  return [...h, ...fill, ...t].map((x) => x.padStart(4, '0').toLowerCase());
}

/** "Mạng" của một IP: /24 cho IPv4, /64 cho IPv6 — 4G đổi IP trong cùng nhà mạng thường vẫn giữ nhóm này. */
export function netOf(ip) {
  const a = v4(ip);
  if (a) return `${a[0]}.${a[1]}.${a[2]}`;
  const g = expandV6(String(ip || ''));
  return g ? g.slice(0, 4).join(':') : String(ip || 'unknown');
}

export function ipInCidrs(ip, cidrs) {
  const a = v4(ip);
  for (const c of cidrs) {
    const [base, bitsStr] = c.split('/');
    const b = v4(base);
    if (a && b) {
      const bits = bitsStr === undefined ? 32 : Number(bitsStr);
      if (!(bits >= 0 && bits <= 32)) continue;
      const toInt = (x) => ((x[0] << 24) | (x[1] << 16) | (x[2] << 8) | x[3]) >>> 0;
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      if ((toInt(a) & mask) === (toInt(b) & mask)) return true;
    } else if (!a && !b && base.toLowerCase() === String(ip).toLowerCase()) {
      return true; // IPv6: chỉ khớp chính xác
    }
  }
  return false;
}

/**
 * Chỉ tin CF-Connecting-IP / X-Forwarded-For khi kết nối TCP đến từ proxy tin cậy (TRUST_PROXY_CIDRS, mặc định
 * loopback + dải riêng của Docker/LAN). Truy cập thẳng từ internet không giả được IP bằng header.
 * X-Forwarded-For đọc từ phải sang trái, bỏ các hop tin cậy; phần tử đầu tiên không tin cậy là client.
 */
const DEFAULT_TRUSTED = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '::1'];
const trustedList = () => (process.env.TRUST_PROXY_CIDRS ? process.env.TRUST_PROXY_CIDRS.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_TRUSTED);

export function clientIp(req) {
  const remote = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '') || 'unknown';
  const trusted = trustedList();
  if (!ipInCidrs(remote, trusted)) return remote;
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const hops = String(xff).split(',').map((x) => x.trim()).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) if (!ipInCidrs(hops[i], trusted)) return hops[i];
    return hops[0] || remote;
  }
  return remote;
}
