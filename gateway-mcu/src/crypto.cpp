// Danh tính mật mã của board (khớp scada/src/Plciot.Scada.Services/Ui/GatewayIdentity.cs) và kiểm chữ ký lệnh cloud
// (khớp scada/src/Plciot.Scada.Core/CmdSignature.cs, cloud/app/src/cmdSign.js): ECDSA P-256 / SHA-256, chữ ký IEEE P1363 (r||s).
// Khoá riêng sinh trên board lần đầu, lưu NVS ("gw_key", PKCS#8/SEC1 DER), không bao giờ rời board.
#include "gw.h"
#include <ETH.h>
#include <mbedtls/pk.h>
#include <mbedtls/ecp.h>
#include <mbedtls/sha256.h>
#include <mbedtls/base64.h>
#include <mbedtls/x509_crt.h>
#include <esp_random.h>

namespace {
mbedtls_pk_context s_pk;
std::vector<uint8_t> s_spki;
const char* B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

int rng(void*, unsigned char* buf, size_t len) { esp_fill_random(buf, len); return 0; }

void sha256(const uint8_t* p, size_t n, uint8_t out[32]) { mbedtls_sha256(p, n, out, 0); }

// DER ECDSA-Sig-Value { r INTEGER, s INTEGER } ↔ r||s 32+32 byte
bool derToRaw(const uint8_t* d, size_t n, uint8_t out[64]) {
  size_t i = 0;
  auto len = [&](size_t& L) -> bool {
    if (i >= n) return false;
    uint8_t b = d[i++];
    if (b < 0x80) { L = b; return true; }
    int k = b & 0x7f; if (k > 2) return false; L = 0;
    while (k--) { if (i >= n) return false; L = (L << 8) | d[i++]; }
    return true;
  };
  size_t L;
  if (i >= n || d[i++] != 0x30 || !len(L)) return false;
  memset(out, 0, 64);
  for (int part = 0; part < 2; part++) {
    if (i >= n || d[i++] != 0x02 || !len(L) || i + L > n) return false;
    const uint8_t* v = d + i; size_t vl = L; i += L;
    while (vl > 32 && *v == 0) { v++; vl--; }
    if (vl > 32) return false;
    memcpy(out + part * 32 + (32 - vl), v, vl);
  }
  return true;
}

size_t rawToDer(const uint8_t raw[64], uint8_t* out) {
  uint8_t tmp[2][34]; size_t tl[2];
  for (int part = 0; part < 2; part++) {
    const uint8_t* v = raw + part * 32; size_t vl = 32;
    while (vl > 1 && *v == 0) { v++; vl--; }
    size_t k = 0;
    if (*v & 0x80) tmp[part][k++] = 0;
    memcpy(tmp[part] + k, v, vl); tl[part] = k + vl;
  }
  size_t i = 0;
  out[i++] = 0x30; out[i++] = (uint8_t)(tl[0] + tl[1] + 4);
  for (int part = 0; part < 2; part++) { out[i++] = 0x02; out[i++] = (uint8_t)tl[part]; memcpy(out + i, tmp[part], tl[part]); i += tl[part]; }
  return i;
}
}  // namespace

String b64u(const uint8_t* p, size_t n) {
  size_t olen = 0;
  std::vector<uint8_t> buf(4 * ((n + 2) / 3) + 4);
  mbedtls_base64_encode(buf.data(), buf.size(), &olen, p, n);
  String s; s.reserve(olen);
  for (size_t i = 0; i < olen; i++) { char c = buf[i]; if (c == '=') break; s += c == '+' ? '-' : c == '/' ? '_' : c; }
  return s;
}

std::vector<uint8_t> fromB64u(const String& in) {
  String s = in; s.replace('-', '+'); s.replace('_', '/');
  while (s.length() % 4) s += '=';
  std::vector<uint8_t> out(s.length() * 3 / 4 + 3);
  size_t olen = 0;
  if (mbedtls_base64_decode(out.data(), out.size(), &olen, (const uint8_t*)s.c_str(), s.length()) != 0) return {};
  out.resize(olen);
  return out;
}

String sha256Hex(const uint8_t* p, size_t n) {
  uint8_t h[32]; sha256(p, n, h);
  char hex[65]; for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", h[i]);
  return String(hex);
}

void cryptoBegin() {
  mbedtls_pk_init(&s_pk);
  String stored = secretGet("gw_key");
  bool ok = false;
  if (stored.length()) {
    auto der = fromB64u(stored);
    ok = !der.empty() && mbedtls_pk_parse_key(&s_pk, der.data(), der.size(), nullptr, 0, rng, nullptr) == 0;
    if (!ok) { mbedtls_pk_free(&s_pk); mbedtls_pk_init(&s_pk); logf("Khoá danh tính hỏng — sinh khoá mới (phải đăng ký cloud lại)"); }
  }
  if (!ok) {
    mbedtls_pk_setup(&s_pk, mbedtls_pk_info_from_type(MBEDTLS_PK_ECKEY));
    mbedtls_ecp_gen_key(MBEDTLS_ECP_DP_SECP256R1, mbedtls_pk_ec(s_pk), rng, nullptr);
    uint8_t buf[256];
    int n = mbedtls_pk_write_key_der(&s_pk, buf, sizeof buf);   // ghi vào CUỐI bộ đệm
    if (n > 0) secretSet("gw_key", b64u(buf + sizeof buf - n, n));
    logf("Đã sinh khoá danh tính ECDSA P-256 mới");
  }
  uint8_t buf[160];
  int n = mbedtls_pk_write_pubkey_der(&s_pk, buf, sizeof buf);
  if (n > 0) s_spki.assign(buf + sizeof buf - n, buf + sizeof buf);
}

String idPublicKey() { return b64u(s_spki.data(), s_spki.size()); }

String idHw() {
  uint8_t h[32]; sha256(s_spki.data(), s_spki.size(), h);
  String s; uint32_t acc = 0; int bits = 0;
  for (int i = 0; i < 32 && s.length() < 20; i++) {
    acc = (acc << 8) | h[i]; bits += 8;
    while (bits >= 5 && s.length() < 20) { s += B32[(acc >> (bits - 5)) & 31]; bits -= 5; }
  }
  return s;
}

String idSign(const String& msg) {
  uint8_t h[32]; sha256((const uint8_t*)msg.c_str(), msg.length(), h);
  uint8_t der[MBEDTLS_ECDSA_MAX_LEN]; size_t dl = 0;
  if (mbedtls_pk_sign(&s_pk, MBEDTLS_MD_SHA256, h, 32, der, sizeof der, &dl, rng, nullptr) != 0) return "";
  uint8_t raw[64];
  if (!derToRaw(der, dl, raw)) return "";
  return b64u(raw, 64);
}

/// Kiểm chữ ký ECDSA P-256 / SHA-256 dạng IEEE P1363 (r||s, base64url) bằng khoá công khai SPKI (base64url) — dùng cho
/// lệnh ký của server và chữ ký đăng nhập của PC admin (GatewayIdentity.Sign của GatewayApp).
bool verifySig(const String& spkiB64u, const String& msg, const String& sigB64u) {
  auto sig = fromB64u(sigB64u);
  auto spki = fromB64u(spkiB64u);
  if (sig.size() != 64 || spki.empty()) return false;
  mbedtls_pk_context pk; mbedtls_pk_init(&pk);
  bool ok = false;
  if (mbedtls_pk_parse_public_key(&pk, spki.data(), spki.size()) == 0 && mbedtls_pk_can_do(&pk, MBEDTLS_PK_ECKEY)) {
    uint8_t h[32]; sha256((const uint8_t*)msg.c_str(), msg.length(), h);
    uint8_t der[80]; size_t dl = rawToDer(sig.data(), der);
    ok = mbedtls_pk_verify(&pk, MBEDTLS_MD_SHA256, h, 32, der, dl) == 0;
  }
  mbedtls_pk_free(&pk);
  return ok;
}

bool verifySigned(const char* domain, const String& raw, const String& mqttId, const String& keyB64u, String& unsignedOut) {
  static const char* marker = ",\"sig\":\"";
  int i = raw.lastIndexOf(marker);
  if (i < 0 || !raw.endsWith("\"}")) return false;
  String json = raw.substring(0, i) + "}";
  if (!verifySig(keyB64u, String(domain) + "|" + mqttId + "|" + json, raw.substring(i + strlen(marker), raw.length() - 2))) return false;
  unsignedOut = json;
  return true;
}

bool verifyCmd(const String& raw, const String& mqttId, const String& keyB64u, String& unsignedOut) {
  return verifySigned("cmd1", raw, mqttId, keyB64u, unsignedOut);
}

mbedtls_pk_context* idKey() { return &s_pk; }

/// Chứng chỉ TLS tự ký từ CHÍNH khoá danh tính: admin ghim khoá này, dấu nhận dạng = mã phần cứng (idHw, in ra cổng USB / tem).
/// Không cần CA: GatewayApp kiểm khoá công khai, không kiểm chuỗi chứng chỉ.
std::vector<uint8_t> tlsCertDer() {
  std::vector<uint8_t> out;
  mbedtls_x509write_cert crt; mbedtls_x509write_crt_init(&crt);
  String cn = "CN=plciot-" + idHw() + ",O=plciot";
  mbedtls_x509write_crt_set_subject_key(&crt, &s_pk);
  mbedtls_x509write_crt_set_issuer_key(&crt, &s_pk);
  mbedtls_x509write_crt_set_subject_name(&crt, cn.c_str());
  mbedtls_x509write_crt_set_issuer_name(&crt, cn.c_str());
  mbedtls_x509write_crt_set_version(&crt, MBEDTLS_X509_CRT_VERSION_3);
  mbedtls_x509write_crt_set_md_alg(&crt, MBEDTLS_MD_SHA256);
  uint8_t serial[8]; esp_fill_random(serial, sizeof serial); serial[0] &= 0x7f;
  mbedtls_x509write_crt_set_serial_raw(&crt, serial, sizeof serial);
  mbedtls_x509write_crt_set_validity(&crt, "20250101000000", "20991231235959");
  static uint8_t buf[1024];
  int n = mbedtls_x509write_crt_der(&crt, buf, sizeof buf, rng, nullptr);   // ghi vào CUỐI bộ đệm
  if (n > 0) out.assign(buf + sizeof buf - n, buf + sizeof buf);
  else logf("Tạo chứng chỉ TLS lỗi %d", n);
  mbedtls_x509write_crt_free(&crt);
  return out;
}

String fingerprint() {
  String raw = "mcu|" + ETH.macAddress() + "|" + g_cfg.device;
  String h = sha256Hex((const uint8_t*)raw.c_str(), raw.length()); h.toUpperCase();
  return h.substring(0, 4) + "-" + h.substring(4, 8);
}
