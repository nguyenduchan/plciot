import mqtt from 'mqtt';
import { findNotifyUsers } from './db.js';
import { insertEvent } from './historyStore.js';
import { purgeByPlan, defaultDays } from './retention.js';
import { noteTelemetry } from './plcProof.js';
import { countDoneMessage, sendTelegramMessage, telegramConfigured } from './telegram.js';

function u32(r, i) {
  return (r[i] | 0) + (r[i + 1] | 0) * 65536;
}

/**
 * Single MQTT client: persist every plc/+/+/* event + Telegram on count-done.
 */
export function startMqttIngest(db) {
  const enabled = String(process.env.MQTT_INGEST || 'true').toLowerCase() !== 'false';
  if (!enabled) {
    console.warn('MQTT ingest disabled (MQTT_INGEST=false)');
    return null;
  }

  const url = process.env.MQTT_URL || 'mqtt://mqtt:1883';
  const username = process.env.MQTT_USER || 'app';
  const password = process.env.MQTT_PASS || '';
  const appUrl = process.env.WEBAPP_PUBLIC_URL || 'https://plc.dieukhientudong.net';
  const topic = process.env.MQTT_INGEST_TOPIC || 'plc/+/+/+';
  /** Optional throttle for telemetry only (0 = store every MQTT message). */
  const minInterval = Number(process.env.MQTT_INGEST_MIN_MS || 0);

  const prevC = new Map();
  const lastTeleStore = new Map();
  const insert = db.transaction((row) => insertEvent(db, row));

  const client = mqtt.connect(url, {
    username,
    password,
    clientId: `plciot-ingest-${Math.random().toString(16).slice(2, 8)}`,
    reconnectPeriod: 5000,
  });

  client.on('connect', () => {
    client.subscribe(topic, (err) => {
      if (err) console.error('ingest subscribe', err);
      else console.log('MQTT ingest subscribed', topic, minInterval ? `min ${minInterval}ms` : 'all msgs');
    });
  });

  client.on('message', (t, buf) => {
    try {
      const parts = t.split('/');
      if (parts.length < 4 || parts[0] !== 'plc') return;
      const site = parts[1];
      const device = parts[2];
      const kind = parts[3];
      if (!['telemetry', 'status', 'history', 'ack', 'cmd'].includes(kind)) return;

      const now = Date.now();
      const text = buf.toString();

      if (kind === 'telemetry') {
        let data;
        try { data = JSON.parse(text); } catch { return; }
        const r = data.r;
        if (!Array.isArray(r) || r.length < 18) return;

        noteTelemetry(site, device, r[0] | 0, now);
        const key = `${site}/${device}`;
        const cstate = r[8] | 0;
        maybeNotify(db, site, device, cstate, r, appUrl, prevC);

        if (minInterval > 0) {
          const prev = lastTeleStore.get(key) || 0;
          if (now - prev < minInterval) return;
          lastTeleStore.set(key, now);
        }

        insert({
          ts: now,
          site,
          device,
          kind,
          payload: text,
          o: r[1] | 0,
          i: r[0] | 0,
          a: r[2] | 0,
          c: u32(r, 16),
          s: cstate,
        });
        return;
      }

      insert({
        ts: now,
        site,
        device,
        kind,
        payload: text,
        o: null,
        i: null,
        a: null,
        c: null,
        s: null,
      });
    } catch (e) {
      console.error('ingest message', e.message);
    }
  });

  client.on('error', (e) => console.error('ingest mqtt', e.message));
  return client;
}

function maybeNotify(db, site, device, cstate, r, appUrl, prevC) {
  if (!telegramConfigured()) return;
  const key = `${site}/${device}`;
  const was = prevC.get(key);
  prevC.set(key, cstate);
  if (cstate !== 2) return;
  if (was === undefined || was === 2) return;

  const target = r[7] | 0;
  const count = u32(r, 14);
  const text = countDoneMessage({ site, device, count, target, appUrl });
  const users = findNotifyUsers(db, site, device);
  const chatIds = new Set(users.map((u) => u.chat_id).filter(Boolean));
  for (const id of (process.env.TELEGRAM_NOTIFY_CHAT_IDS || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    chatIds.add(Number(id) || id);
  }
  for (const chatId of chatIds) {
    sendTelegramMessage(chatId, text).catch((e) => console.error('Telegram send', e.message));
  }
}

export function startHistoryPurge(db) {
  const run = () => {
    try {
      const n = purgeByPlan(db);
      if (n) console.log(`history purge: deleted ${n} expired rows (default ${defaultDays()}d, per-plan overrides)`);
    } catch (e) {
      console.error('history purge', e.message);
    }
  };
  run();
  return setInterval(run, 3600e3);
}
