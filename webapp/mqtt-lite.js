/* Minimal MQTT 3.1.1 client over WebSocket (QoS0 publish/subscribe, auto-reconnect).
   No dependencies so the whole app works offline from local files. */
'use strict';
class MqttLite {
  // keepalive 60 s (broker cho tối đa 120): app ở nền trên Android/desktop bị trình duyệt giãn hẹn giờ tới ~1 lần/phút — với 30 s, PINGREQ
  // không kịp gửi, broker cắt sau 45 s rồi lúc quay lại phải bắt tay TLS lại. Ping mỗi 30 s, broker chờ 90 s → sống qua khi bị giãn.
  constructor({ url, user, pass, clientId, keepalive = 60 }) {
    Object.assign(this, { url, user, pass, keepalive });
    this.clientId = clientId || 'app-' + Math.random().toString(16).slice(2, 10);
    this.subs = []; this.h = {}; this.buf = new Uint8Array(0); this.closed = false;
  }
  on(ev, fn) { this.h[ev] = fn; return this; }
  _emit(ev, ...a) { if (this.h[ev]) this.h[ev](...a); }

  connect() {
    this.closed = false;
    this._detach();
    this.buf = new Uint8Array(0);   // byte dở dang của kết nối trước sẽ làm lệch CONNACK/gói đầu của kết nối sau
    this._ready = false;
    let ws;
    try { ws = this.ws = new WebSocket(this.url, 'mqtt'); }
    catch (e) { this._emit('error', e); return this._retry(); }
    ws.binaryType = 'arraybuffer';
    this.lastRx = Date.now();
    // Mọi sự kiện của socket đã bị thay/đóng (vd. socket "zombie" của iOS sau khi app ở nền) bị bỏ qua: nếu không, 'close' đến trễ
    // sẽ ghi đè trạng thái "trực tuyến" của kết nối mới thành "offline".
    ws.onopen = () => {
      if (ws !== this.ws) return;
      const flags = 0x02 | (this.user ? 0x80 : 0) | (this.user && this.pass ? 0x40 : 0);
      const body = [0, 4, 77, 81, 84, 84, 4, flags, this.keepalive >> 8, this.keepalive & 255,
        ...MqttLite._str(this.clientId)];
      if (this.user) body.push(...MqttLite._str(this.user));
      if (this.user && this.pass) body.push(...MqttLite._str(this.pass));
      this._send(MqttLite._pkt(0x10, body));
    };
    ws.onmessage = (e) => { if (ws !== this.ws) return; this.lastRx = Date.now(); this._rx(new Uint8Array(e.data)); };
    ws.onclose = () => { if (ws === this.ws) this._lost(); };
    ws.onerror = () => {};
    // Không có CONNACK trong 10 giây, hoặc đang nối mà im lặng quá 1,5 × keepalive: coi như mất kết nối rồi nối lại.
    // Bộ đếm này bị ĐÓNG BĂNG khi app ở nền (iOS) / bị giãn (Android): lần chạy đầu sau khoảng hở dài KHÔNG kết luận "im lặng = chết"
    // (đó là do ta ngủ, không phải do mạng) mà ping thử và chờ 3 giây — socket còn sống thì dùng tiếp, khỏi bắt tay TLS lại.
    clearInterval(this.wd);
    let tick = Date.now(), grace = 0, pingAt = 0;
    this.wd = setInterval(() => {
      if (ws !== this.ws) return;
      const t = Date.now(), gap = t - tick; tick = t;
      if (gap > 5000 && this._ready) { grace = t + 3000; pingAt = t; this._send(new Uint8Array([0xC0, 0])); return; }
      if (t < grace) return;
      if (pingAt) { const alive = this.lastRx >= pingAt; pingAt = 0; if (!alive) return this._lost(); }   // ping thử không ai trả lời: socket đã chết
      const quiet = t - this.lastRx;
      if (this._ready ? quiet > this.keepalive * 1500 : quiet > 10000) this._lost();
    }, 1000);
  }
  /** Bỏ socket hiện tại (không còn nhận sự kiện của nó) và dừng các bộ đếm. */
  _detach() {
    clearInterval(this.ping); this.ping = null;
    clearInterval(this.wd); this.wd = null;
    const ws = this.ws; this.ws = null; this._ready = false;
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(); } catch {} }
  }
  _lost() { this._detach(); this._emit('close'); this._retry(); }
  // Mỗi lần nối lại = TCP + bắt tay TLS + nâng cấp WebSocket + CONNECT/SUBSCRIBE: thử lại GIÃN dần 1 → 2 → 4 → 8 → 16 giây (± ngẫu nhiên,
  // tránh cả xưởng sau một NAT cùng nối lại một lúc và vượt giới hạn 60 kết nối/phút/IP của HAProxy). Nối được (CONNACK) thì về lại 1 giây.
  _retry() {
    if (this.closed) return;
    clearTimeout(this.rt);
    const base = Math.min(30000, 1000 * 2 ** Math.min(this.fails = (this.fails || 0) + 1, 5) / 2);
    this.rt = setTimeout(() => this.connect(), base * (0.8 + Math.random() * 0.4));
  }
  /** Nối lại ngay (mạng vừa có lại / người dùng quay lại app) thay vì chờ hết thời gian giãn. Đang nối/đang sống thì thôi. */
  kick() { if (!this.closed && !this.ws) { this.fails = 0; clearTimeout(this.rt); this.connect(); } }
  close() { this.closed = true; clearTimeout(this.rt); this._detach(); }

  subscribe(topic) { this.subs.push(topic); if (this.ready) this._sub(topic); }
  _sub(topic) { this._send(MqttLite._pkt(0x82, [0, 1, ...MqttLite._str(topic), 0])); }
  publish(topic, payload, retain = false) {
    if (!this.ready) return false;
    this._send(MqttLite._pkt(0x30 | (retain ? 1 : 0),
      [...MqttLite._str(topic), ...new TextEncoder().encode(payload)]));
    return true;
  }
  _send(u8) { if (this.ws && this.ws.readyState === 1) this.ws.send(u8); }

  _rx(chunk) {
    const b0 = new Uint8Array(this.buf.length + chunk.length);
    b0.set(this.buf); b0.set(chunk, this.buf.length); this.buf = b0;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      let mul = 1, len = 0, i = 1, d;
      do { if (i >= b.length) return; d = b[i++]; len += (d & 127) * mul; mul *= 128; } while (d & 128);
      if (b.length < i + len) return;
      const body = b.subarray(i, i + len);
      this.buf = b.subarray(i + len);
      this._pkt(b[0], body);
    }
  }
  _pkt(first, body) {
    const type = first >> 4;
    if (type === 2) {                                   // CONNACK
      if (body[1] !== 0) { this._emit('error', new Error('CONNACK ' + body[1])); this._lost(); return; }
      this.ready = true; this.fails = 0;
      this.subs.forEach((t) => this._sub(t));
      this.ping = setInterval(() => this._send(new Uint8Array([0xC0, 0])), this.keepalive * 500);
      this._emit('connect');
    } else if (type === 3) {                            // PUBLISH
      const qos = (first >> 1) & 3, tl = body[0] << 8 | body[1];
      const topic = new TextDecoder().decode(body.subarray(2, 2 + tl));
      let pos = 2 + tl;
      if (qos) { if (qos === 1) this._send(new Uint8Array([0x40, 2, body[pos], body[pos + 1]])); pos += 2; }
      this._emit('message', topic, new TextDecoder().decode(body.subarray(pos)));
    }
  }
  static _str(s) { const b = new TextEncoder().encode(s); return [b.length >> 8, b.length & 255, ...b]; }
  static _pkt(first, body) {
    const rl = []; let n = body.length;
    do { let d = n % 128; n = Math.floor(n / 128); rl.push(n ? d | 128 : d); } while (n);
    return new Uint8Array([first, ...rl, ...body]);
  }
}
// "ready" must reset on close
Object.defineProperty(MqttLite.prototype, 'ready', {
  get() { return this._ready && this.ws && this.ws.readyState === 1; },
  set(v) { this._ready = v; },
});

if (typeof module !== 'undefined' && module.exports) module.exports = MqttLite;   // cho test chạy bằng Node
