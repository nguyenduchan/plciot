/* Minimal MQTT 3.1.1 client over WebSocket (QoS0 publish/subscribe, auto-reconnect).
   No dependencies so the whole app works offline from local files. */
'use strict';
class MqttLite {
  constructor({ url, user, pass, clientId, keepalive = 30 }) {
    Object.assign(this, { url, user, pass, keepalive });
    this.clientId = clientId || 'app-' + Math.random().toString(16).slice(2, 10);
    this.subs = []; this.h = {}; this.buf = new Uint8Array(0); this.closed = false;
  }
  on(ev, fn) { this.h[ev] = fn; return this; }
  _emit(ev, ...a) { if (this.h[ev]) this.h[ev](...a); }

  connect() {
    this.closed = false;
    let ws;
    try { ws = this.ws = new WebSocket(this.url, 'mqtt'); }
    catch (e) { this._emit('error', e); return this._retry(); }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      const flags = 0x02 | (this.user ? 0x80 : 0) | (this.user && this.pass ? 0x40 : 0);
      const body = [0, 4, 77, 81, 84, 84, 4, flags, this.keepalive >> 8, this.keepalive & 255,
        ...MqttLite._str(this.clientId)];
      if (this.user) body.push(...MqttLite._str(this.user));
      if (this.user && this.pass) body.push(...MqttLite._str(this.pass));
      this._send(MqttLite._pkt(0x10, body));
    };
    ws.onmessage = (e) => this._rx(new Uint8Array(e.data));
    ws.onclose = () => {
      clearInterval(this.ping); this.ping = null;
      this._emit('close');
      if (ws === this.ws) this._retry();
    };
    ws.onerror = () => {};
  }
  _retry() { if (!this.closed) { clearTimeout(this.rt); this.rt = setTimeout(() => this.connect(), 3000); } }
  close() { this.closed = true; clearTimeout(this.rt); clearInterval(this.ping); if (this.ws) this.ws.close(); }

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
      if (body[1] !== 0) { this._emit('error', new Error('CONNACK ' + body[1])); this.ws.close(); return; }
      this.ready = true;
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
