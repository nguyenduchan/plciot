// Cấu hình IP của board. Mặc định như thiết bị Ethernet công nghiệp sẵn firmware của Waveshare: IP TĨNH 192.168.1.200/24,
// gateway 192.168.1.1. Lưu NVS riêng (không nằm trong ApiConfig) để admin đẩy cấu hình thiết bị không làm đổi IP.
#include "gw.h"
#include "board.h"
#include <ETH.h>

static bool parseIp(const String& s, IPAddress& out) {
  int p[4]; char tail;
  if (sscanf(s.c_str(), "%d.%d.%d.%d%c", &p[0], &p[1], &p[2], &p[3], &tail) != 4) return false;
  for (int v : p) if (v < 0 || v > 255) return false;
  out = IPAddress(p[0], p[1], p[2], p[3]);
  return true;
}

NetCfg netLoad() {
  NetCfg n;
  n.dhcp = secretGet("net_mode") == "dhcp";
  n.ip = secretGet("net_ip"); n.mask = secretGet("net_mask"); n.gw = secretGet("net_gw"); n.dns = secretGet("net_dns");
  if (!n.ip.length()) n.ip = NET_DEFAULT_IP;
  if (!n.mask.length()) n.mask = NET_DEFAULT_MASK;
  if (!n.gw.length()) n.gw = NET_DEFAULT_GW;
  if (!n.dns.length()) n.dns = NET_DEFAULT_DNS;
  return n;
}

String netValidate(const NetCfg& n) {
  if (n.dhcp) return "";
  IPAddress ip, m, g, d;
  if (!parseIp(n.ip, ip) || ip == IPAddress(0, 0, 0, 0)) return "Địa chỉ IP không hợp lệ.";
  if (!parseIp(n.mask, m)) return "Subnet mask không hợp lệ.";
  uint32_t mv = ((uint32_t)m[0] << 24) | (m[1] << 16) | (m[2] << 8) | m[3];
  if (mv == 0 || ((~mv + 1) & ~mv) != 0) return "Subnet mask phải liền bit (vd. 255.255.255.0).";
  if (n.gw.length() && !parseIp(n.gw, g)) return "Gateway không hợp lệ.";
  if (n.dns.length() && !parseIp(n.dns, d)) return "DNS không hợp lệ.";
  if (n.gw.length()) {
    for (int i = 0; i < 4; i++) if ((ip[i] & m[i]) != (g[i] & m[i])) return "Gateway phải cùng mạng con với IP của board.";
  }
  return "";
}

void netSave(const NetCfg& n) {
  secretSet("net_mode", n.dhcp ? "dhcp" : "static");
  secretSet("net_ip", n.ip); secretSet("net_mask", n.mask); secretSet("net_gw", n.gw); secretSet("net_dns", n.dns);
}

void netReset() { NetCfg d; d.ip = NET_DEFAULT_IP; d.mask = NET_DEFAULT_MASK; d.gw = NET_DEFAULT_GW; d.dns = NET_DEFAULT_DNS; netSave(d); }

void netApply() {
  NetCfg n = netLoad();
  if (n.dhcp) { logf("Mạng: DHCP"); return; }
  IPAddress ip, m, g, d;
  parseIp(n.ip, ip); parseIp(n.mask, m);
  if (!parseIp(n.gw, g)) g = IPAddress(0, 0, 0, 0);
  if (!parseIp(n.dns, d)) d = IPAddress(8, 8, 8, 8);
  ETH.config(ip, g, m, d);
  logf("Mạng: IP tĩnh %s/%s, gateway %s, DNS %s", n.ip.c_str(), n.mask.c_str(), n.gw.c_str(), n.dns.c_str());
}

String netMask() { NetCfg n = netLoad(); return n.dhcp ? ETH.subnetMask().toString() : n.mask; }
