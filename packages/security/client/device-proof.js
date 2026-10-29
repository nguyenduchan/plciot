'use strict';
(function () {
  let pendingKey;
  const encode = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  function deviceKey() {
    if (pendingKey) return pendingKey;
    pendingKey = new Promise((resolve, reject) => {
      if (!window.isSecureContext || !crypto.subtle || !window.indexedDB) { reject(new Error('secure_context_required')); return; }
      const request = indexedDB.open('security-device', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('keys');
      request.onerror = () => reject(new Error('device_storage_unavailable'));
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction('keys').objectStore('keys').get('current');
        read.onerror = () => { db.close(); reject(new Error('device_storage_unavailable')); };
        read.onsuccess = async () => {
          if (read.result) { db.close(); try { localStorage.setItem('devId', JSON.stringify(read.result.id)); } catch {} resolve(read.result); return; }
          try {
            let id;
            try { id = localStorage.getItem('devId') && JSON.parse(localStorage.getItem('devId')); } catch {}
            id ||= crypto.randomUUID();
            const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
            const record = { id, privateKey: keys.privateKey, publicKey: await crypto.subtle.exportKey('jwk', keys.publicKey) };
            const transaction = db.transaction('keys', 'readwrite');
            let selected = record;
            const store = transaction.objectStore('keys');
            const existing = store.get('current');
            existing.onsuccess = () => { if (existing.result) selected = existing.result; else store.put(record, 'current'); };
            transaction.oncomplete = () => { db.close(); try { localStorage.setItem('devId', JSON.stringify(selected.id)); } catch {} resolve(selected); };
            transaction.onerror = () => { db.close(); reject(new Error('device_storage_unavailable')); };
          } catch { db.close(); reject(new Error('device_storage_unavailable')); }
        };
      };
    }).catch((error) => { pendingKey = null; throw error; });
    return pendingKey;
  }
  async function proof(subject, action) {
    const key = await deviceKey();
    const deviceProof = { timestamp: Date.now(), nonce: encode(crypto.getRandomValues(new Uint8Array(24))) };
    const message = new TextEncoder().encode(JSON.stringify([String(subject), key.id, action, deviceProof.timestamp, deviceProof.nonce]));
    deviceProof.signature = encode(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, message));
    const publicKey = { kty: 'EC', crv: 'P-256', x: key.publicKey.x, y: key.publicKey.y };
    return { deviceId: key.id, publicKey, deviceProof };
  }
  window.SecurityDevice = { proof };
})();