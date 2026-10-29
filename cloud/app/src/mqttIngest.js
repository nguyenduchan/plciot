import mqtt from 'mqtt';
import { findNotifyUsers } from './db.js';
import { insertEvent } from './historyStore.js';
import { purgeByPlan, defaultDays } from './retention.js';
import { noteTelemetry } from './plcProof.js';
import { countDoneMessage, sendTelegramMessage, telegramConfigured } from './telegram.js';
import { parseTopic, ingestTopicFilters, DEFAULT_TENANT } from './contract.js';
import { emitWebhook } from './webhooks.js';
import { evaluateIngest, recordDeny, takeRejectStats } from './policy.js';
import { isOpsOpen } from './opsFlags.js';

function u32(r, i) {
  return (r[i] | 0) + (r[i + 1] | 0) * 65536;
}

/**
 * MQTT ingest + policy: chặn gói trái phép / vi phạm trước khi lưu hoặc webhook.
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
  const topics = ingestTopicFilters();
  const minInterval = Number(process.env.MQTT_INGEST_MIN_MS || 0);

  const prevC = new Map();
  const prevStatus = new Map();
  const prevAlarm = new Map();
  const lastTeleStore = new Map();
  const insert = db.transaction((row) => insertEvent(db, row));

  setInterval(() => {
    const s = takeRejectStats();
    if (Object.keys(s).length) console.warn('ingest policy deny', s);
  }, 60_000);

  const client = mqtt.connect(url, {
    username,
    password,
    clientId: `plciot-ingest-${Math.random().toString(16).slice(2, 8)}`,
    reconnectPeriod: 5000,
  });

  client.on('connect', () => {
    client.subscribe(topics, (err) => {
      if (err) console.error('ingest subscribe', err);
      else console.log('MQTT ingest subscribed', topics.join(', '), minInterval ? `min ${minInterval}ms` : 'all msgs');
    });
  });

  client.on('message', (t, buf) => {
    try {
      if (!isOpsOpen('mqtt_ingest_open')) return;
      const parsed = parseTopic(t);
      if (!parsed) return;
      const { site, device, kind } = parsed;
      if (!['telemetry', 'status', 'history', 'ack', 'cmd'].includes(kind)) return;

      const verdict = evaluateIngest(db, { topic: t, parsed, payloadBuf: buf });
      if (!verdict.allow) {
        // cmd trên đường ingest: im lặng (không spam log)
        if (verdict.reason !== 'cmd_on_ingest_path') {
          recordDeny(db, {
            reason: verdict.reason,
            detail: verdict.detail,
            site,
            device,
            tenantId: parsed.tenant || verdict.sub?.tenantId,
            kind,
          });
        }
        return;
      }

      const sub = verdict.sub;
      const tenantId = sub.tenantId || DEFAULT_TENANT;
      const now = Date.now();
      const text = buf.toString();

      if (kind === 'telemetry') {
        const data = JSON.parse(text);
        const r = data.r;
        noteTelemetry(site, device, r[0] | 0, now);
        const key = `${tenantId}/${site}/${device}`;
        const cstate = r[8] | 0;
        onCountDone(db, { tenantId, site, device, cstate, r, appUrl, prevC });
        maybeWebhookAlarm(db, tenantId, site, device, r[2] | 0, prevAlarm);

        if (minInterval > 0) {
          const prev = lastTeleStore.get(key) || 0;
          if (now - prev < minInterval) return;
          lastTeleStore.set(key, now);
        }

        insert({
          ts: now, site, device, kind, payload: text,
          o: r[1] | 0, i: r[0] | 0, a: r[2] | 0, c: u32(r, 16), s: cstate,
        });
        return;
      }

      if (kind === 'status' && tenantId) {
        const sk = `${tenantId}/${site}/${device}`;
        const was = prevStatus.get(sk);
        prevStatus.set(sk, text);
        if (was !== undefined && was !== text) {
          emitWebhook(db, {
            tenantId, site, device, event: 'status', data: { status: text, previous: was },
          });
        }
      }

      insert({
        ts: now, site, device, kind, payload: text,
        o: null, i: null, a: null, c: null, s: null,
      });
    } catch (e) {
      console.error('ingest message', e.message);
    }
  });

  client.on('error', (e) => console.error('ingest mqtt', e.message));
  return client;
}

function onCountDone(db, { tenantId, site, device, cstate, r, appUrl, prevC }) {
  const key = `${site}/${device}`;
  const was = prevC.get(key);
  prevC.set(key, cstate);
  if (cstate !== 2 || was === undefined || was === 2) return;

  const target = r[7] | 0;
  const count = u32(r, 14);
  if (tenantId) {
    emitWebhook(db, {
      tenantId, site, device, event: 'count_done',
      data: { count, target },
    });
  }
  if (!telegramConfigured()) return;
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

function maybeWebhookAlarm(db, tenantId, site, device, alarmMask, prevAlarm) {
  if (!tenantId) return;
  const key = `${site}/${device}`;
  const was = prevAlarm.get(key);
  prevAlarm.set(key, alarmMask);
  if (was === undefined || was === alarmMask) return;
  if (alarmMask === 0 && was === 0) return;
  emitWebhook(db, {
    tenantId, site, device, event: 'alarm',
    data: { alarm: alarmMask, previous: was ?? 0 },
  });
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
