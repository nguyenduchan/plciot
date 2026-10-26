#!/usr/bin/env python3
"""Thử các kịch bản DDoS cơ bản vào chính broker của bạn (CHỈ dùng trên hệ thống của mình).

  python scripts/ddos-probe.py HOST [--port 38417] [--tls]

Kịch bản: (1) slowloris: mở socket, không gửi gì  (2) rác không phải MQTT
(3) lũ kết nối đồng thời  (4) lũ kết nối mới / phút (dò mật khẩu).
Mong đợi: (1)(2) bị cắt ≤ ~6 s, (3) bị từ chối sau MAX_CONN_PER_IP, (4) bị từ chối sau MAX_CONN_RATE.
Chạy từ IP không nằm trong trusted.lst; IP của bạn có thể bị khoá ~10 phút sau khi thử.
"""
import argparse
import socket
import ssl
import time


def conn(host, port, tls):
    s = socket.create_connection((host, port), timeout=5)
    if tls:
        c = ssl.create_default_context()
        c.check_hostname = False
        c.verify_mode = ssl.CERT_NONE
        s = c.wrap_socket(s, server_hostname=host)
    return s


def closed_within(s, secs):
    s.settimeout(secs)
    t = time.time()
    try:
        return s.recv(1) == b'', time.time() - t
    except socket.timeout:
        return False, secs
    except OSError:
        return True, time.time() - t


def refused_now(x):
    """True nếu server đóng ngay (reject) thay vì chờ dữ liệu."""
    x.settimeout(0.3)
    try:
        return x.recv(1) == b''
    except socket.timeout:
        return False
    except OSError:
        return True


ap = argparse.ArgumentParser()
ap.add_argument('host')
ap.add_argument('--port', type=int, default=38417)
ap.add_argument('--tls', action='store_true')
a = ap.parse_args()

s = conn(a.host, a.port, a.tls)
ok, t = closed_within(s, 8)
print(f"[slowloris]  {'bị cắt sau %.1fs  OK' % t if ok else 'KHÔNG bị cắt  FAIL'}")

s = conn(a.host, a.port, a.tls)
s.sendall(b'GET / HTTP/1.1\r\n\r\n')
ok, t = closed_within(s, 8)
print(f"[rác]        {'bị cắt sau %.1fs  OK' % t if ok else 'KHÔNG bị cắt  FAIL'}")

held, refused = [], 0
for _ in range(200):
    try:
        x = conn(a.host, a.port, a.tls)
        if refused_now(x):
            refused += 1
        else:
            held.append(x)
    except OSError:
        refused += 1
print(f"[đồng thời]  giữ được {len(held)}, bị từ chối {refused}  {'OK' if refused else 'FAIL (chưa có giới hạn?)'}")
for x in held:
    x.close()

time.sleep(1)
refused = 0
for _ in range(150):
    try:
        x = conn(a.host, a.port, a.tls)
        refused += refused_now(x)
        x.close()
    except OSError:
        refused += 1
print(f"[tốc độ mới] {refused}/150 bị từ chối  {'OK' if refused else 'FAIL'}")
