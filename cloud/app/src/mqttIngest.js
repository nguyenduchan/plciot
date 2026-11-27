import { shardCount, shardUrls } from './shards.js';
import { recordReportedLogic } from './gatewayLogic.js';
import { onRpcReply } from './remoteAdmin.js';
import { onFwRequest } from './mcuOta.js';
import mqtt from 'mqtt';
import { insertEvent } from './historyStore.js';
import { evaluateBackfill } from './backfill.js';
import { purgeByPlanAsync, defaultDays, thinOldTelemetryAsync } from './retention.js';
import { noteTelemetry } from './plcProof.js';
import { parseTopic, ingestTopicFilters, DEFAULT_TENANT } from './contract.js';
import { deviceByMqttId } from './mqttIds.js';
import { emitWebhook } from './webhooks.js';
import { evaluateIngest, recordDeny, takeRejectStats } from './policy.js';
import { isOpsOpen } from './opsFlags.js';
import { audit } from '@plciot/security';
import { noteStatusChange, dupConfig } from './dupDetect.js';
import { applyGatewayConfig } from './gatewayConfig.js';
import { planTelemetryMinMs, planStoreEveryMs } from './entitlements.js';
import { createTeleAggregator } from './aggregate.js';
import { evaluateStatusAlert, parseGatewayAlert, forwardGatewayAlert } from './pushAlerts.js';
import { featureOn } from './serverProfile.js';
import { onNocodeRaw, onNocodeStatus, onNocodeAckRaw } from './nocode.js';

/** Tem chưa có user? Cache 5 giây để không truy vấn DB cho từng gói telemetry (gateway cũng đã ngừng gửi khi chưa claim). */
const unclaimedCache = new Map();
function isUnclaimedGateway(db, site, device) {
  const key = `${site}/${device}`;
  const now = Date.now();
  const hit = unclaimedCache.get(key);
  if (hit && now - hit.at < 5000) return hit.v;
  const r = db.prepare('SELECT claimed_by FROM hardware_devices WHERE site = ? AND device = ?').get(site, device);
  const v = Boolean(r) && !r.claimed_by;
  if (unclaimedCache.size > 5000) unclaimedCache.clear();
  unclaimedCache.set(key, { v, at: now });
  return v;
}

/** Giới hạn tần suất theo gói của chủ gateway (cache 5 giây). */
const planMsCache = new Map();
function ownerPlanMinMs(db, site, device) {
  const key = `${site}/${device}`;
  const now = Date.now();
  const hit = planMsCache.get(key);
  if (hit && now - hit.at < 5000) return hit.v;
  const o = db.prepare('SELECT u.* FROM hardware_devices h JOIN users u ON u.id = h.claimed_by WHERE h.site = ? AND h.device = ?').get(site, device);
  const v = o ? planTelemetryMinMs(o) : 0;
  if (planMsCache.size > 5000) planMsCache.clear();
  planMsCache.set(key, { v, at: now, store: o ? planStoreEveryMs(o) : 0 });
  return v;
}
/** Chu kỳ LƯU vào DB theo gói của chủ gateway (ms; 0 = lưu theo nhịp telemetry như cũ). Dùng chung cache với ownerPlanMinMs. */
function ownerStoreEveryMs(db, site, device) {
  ownerPlanMinMs(db, site, device);
  return planMsCache.get(`${site}/${device}`)?.store || 0;
}

/**
 * gw/<mqttId>/<kind> → { ns, mqttId, kind, tenant, site, device }.
 * Tra id ngẫu nhiên trong bảng devices; id lạ / thiết bị đã thu hồi hoặc bị khoá → null (gói bị bỏ, không ghi gì).
 */
export function resolveIngestTopic(db, topic) {
  const pt = parseTopic(topic);
  if (!pt) return null;
  const dev = deviceByMqttId(db, pt.mqttId);
  if (!dev) return null;
  return { ...pt, tenant: dev.tenant_id, site: dev.site, device: dev.device };
}

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
  // HISTORY_ON_CHANGE: bỏ mẫu telemetry có giá trị y hệt mẫu đã lưu gần nhất; vẫn lưu một mẫu nhịp tim mỗi HISTORY_HEARTBEAT_MS
  // để đồ thị không đứt và biết gateway còn sống. Chỉ ảnh hưởng LƯU lịch sử — webapp xem trực tiếp vẫn nhận mọi mẫu từ broker.
  const onChange = featureOn('HISTORY_ON_CHANGE', false);
  const heartbeatMs = Math.max(1000, Number(process.env.HISTORY_HEARTBEAT_MS) || 60_000);
  const lastTeleValue = new Map();   // key → { v: chuỗi giá trị, at: lúc lưu }
  // Hàng đợi do BROKER giữ (phiên persistent + QoS 1, xem mosquitto.conf listener 1883): app xử lý tới đâu nhận tới đó, broker xếp phần còn lại
  // và giữ cả khi app khởi động lại. App chỉ gom ghi: các message cùng một lượt đọc socket được ghi trong MỘT transaction SQLite.
  let batchRows = [];
  let flushScheduled = false;
  const insertMany = db.transaction((rows) => { for (const r of rows) insertEvent(db, r); });
  const flush = () => {
    flushScheduled = false;
    if (!batchRows.length) return;
    const rows = batchRows; batchRows = [];
    try { insertMany(rows); } catch (e) { console.error('ingest batch insert', e.message); }
  };
  const insert = (row) => { batchRows.push(row); if (!flushScheduled) { flushScheduled = true; setImmediate(flush); } };

  // Đẩy các cửa sổ gộp đã kết thúc (cửa sổ cuối của gateway ngừng gửi vẫn được lưu)
  const aggregator = createTeleAggregator();
  setInterval(() => {
    for (const r of aggregator.sweep(Date.now())) insert({ ts: r.ts, site: r.meta.site, device: r.meta.device, kind: 'telemetry', payload: r.payload, o: null, i: null, a: null, c: null, s: null });
  }, 15_000).unref?.();

  setInterval(() => {
    const s = takeRejectStats();
    if (Object.keys(s).length) console.warn('ingest policy deny', s);
  }, 60_000);

  // Mỗi nhóm broker một kết nối ingest (MQTT_SHARDS=1: đúng một kết nối như cũ). Tất cả dùng chung MỘT luồng xử lý + ghi lô.
  const ingestUrls = process.env.MQTT_INGEST_URL && shardCount() <= 1 ? [process.env.MQTT_INGEST_URL] : shardUrls('MQTT_INGEST_URLS', 'MQTT_INGEST_URL', 1885);
  const clients = ingestUrls.map((u, k) => {
    const c = mqtt.connect(u || url, {
      username,
      password,
      clientId: (process.env.MQTT_INGEST_CLIENT_ID || 'plciot-ingest') + (k ? `-${k}` : ''),   // cố định + clean:false → broker giữ hàng đợi khi app tắt/khởi động lại
      clean: false,
      reconnectPeriod: 5000,
    });
    c.on('connect', () => {
      c.subscribe(topics, { qos: 1 }, (err) => {
        if (err) console.error(`ingest subscribe (nhóm ${k})`, err);
        else console.log(`MQTT ingest subscribed (nhóm ${k})`, topics.join(', '), minInterval ? `min ${minInterval}ms` : 'all msgs');
      });
    });
    return c;
  });
  const client = clients[0];

  const processMessage = (t, buf, ts) => {
    try {
      if (!isOpsOpen('mqtt_ingest_open')) return;
      const parsed = resolveIngestTopic(db, t);
      if (!parsed) return;
      const { site, device, kind } = parsed;
      if (kind === 'rpcr') { onRpcReply(parsed.mqttId, buf); return; }   // trả lời cài đặt từ xa: không lưu, chỉ chuyển cho yêu cầu đang chờ
      if (kind === 'fwq') { onFwRequest(db, parsed.mqttId, buf); return; }   // board hỏi firmware qua MQTT (HTTPS hỏng): không lưu
      if (kind === 'ackraw') {
        // Phản hồi lệnh của gateway no-code → server phát ack chuẩn (quay lại đây như ack thường)
        const r = onNocodeAckRaw(db, parsed, buf);
        if (!r.ok && r.reason !== 'unknown_id') recordDeny(db, { reason: `nocode_${r.reason}`, detail: 'ackraw', site, device, tenantId: parsed.tenant, kind });
        return;
      }
      if (kind === 'cmdraw') return;   // lệnh server gửi gateway no-code: không lưu
      if (kind === 'raw') {
        // Gateway no-code: chuẩn hoá theo ánh xạ rồi server phát lại lên <base>/telemetry (quay lại đây như telemetry thường)
        const r = onNocodeRaw(db, parsed, buf, ts);
        if (!r.ok && (r.reason === 'not_nocode' || r.reason === 'rate_limited')) {
          recordDeny(db, { reason: `nocode_${r.reason}`, detail: 'raw', site, device, tenantId: parsed.tenant, kind });
        }
        return;
      }
      if (!['telemetry', 'status', 'history', 'ack', 'cmd', 'config', 'alert'].includes(kind)) return;

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
      const now = ts;   // giờ message ĐẾN broker app (không phải giờ xử lý), để lịch sử đúng thời điểm
      const text = buf.toString();

      if (kind === 'config') {
        // Gateway khai báo cấu trúc thiết bị: upsert + đồng bộ dashboard, không lưu vào lịch sử telemetry.
        let payload;
        try { payload = JSON.parse(text); } catch { recordDeny(db, { reason: 'invalid_json', detail: 'config', site, device, tenantId, kind }); return; }
        const r = applyGatewayConfig(db, { tenantId, site, device, payload });
        if (payload && typeof payload.logic === 'object') { try { recordReportedLogic(db, { site, device, logic: payload.logic }); } catch (e) { console.error('[logic]', e.message); } }
        if (r.error) {
          recordDeny(db, { reason: 'policy_config_shape', detail: r.error, site, device, tenantId, kind });
          return;
        }
        if (r.changed) {
          audit(db, 'gateway_config', { detail: `${site}/${device} rev ${r.rev}: ${r.devices} thiết bị (+${r.added || 0}/-${r.removed || 0})` });
          console.log(`[config] ${site}/${device} rev ${r.rev}: ${r.devices} thiết bị`);
        }
        return;
      }

      // Tem chưa có user (chưa claim): chỉ nhận config/status, bỏ telemetry/history
      if ((kind === 'telemetry' || kind === 'history') && isUnclaimedGateway(db, site, device)) {
        return;   // im lặng: không ghi deny mỗi gói (gateway cũ vẫn có thể gửi)
      }

      if (kind === 'telemetry' && verdict.resolved?.canonical?.bf) {
        // Gói BÙ dữ liệu offline: đường riêng, không lẫn live (xem backfill.js)
        const bf = evaluateBackfill(db, { site, device, canonical: verdict.resolved.canonical, now, gapMs: Math.max(minInterval, ownerPlanMinMs(db, site, device)) });
        if (bf.ok) insert(bf.row);
        return;
      }

      if (kind === 'telemetry') {
        const canonical = verdict.resolved?.canonical || JSON.parse(text);
        const storeText = verdict.resolved?.text || text;
        const r = Array.isArray(canonical.r) ? canonical.r : null;

        if (r) {
          noteTelemetry(site, device, r[0] | 0, now);
          const cstate = r[8] | 0;
          onCountDone(db, { tenantId, site, device, cstate, r, appUrl, prevC });
          maybeWebhookAlarm(db, tenantId, site, device, r[2] | 0, prevAlarm, appUrl);
        } else {
          // schema:2 / d — đánh dấu online; không map conveyor r[]
          noteTelemetry(site, device, 1, now);
        }

        const key = `${tenantId}/${site}/${device}`;
        // Gói có chu kỳ lưu (miễn phí: 1 phút): gộp trung bình/nhỏ nhất/lớn nhất mỗi cửa sổ, chỉ lưu MỘT dòng; xem aggregate.js
        const storeEvery = canonical.d ? ownerStoreEveryMs(db, site, device) : 0;
        if (storeEvery > 0) {
          const row = aggregator.add(key, now, canonical.d, storeEvery, { site, device });
          if (row) insert({ ts: row.ts, site: row.meta.site, device: row.meta.device, kind: 'telemetry', payload: row.payload, o: null, i: null, a: null, c: null, s: null });
          return;
        }
        const gap = Math.max(minInterval, ownerPlanMinMs(db, site, device));
        if (gap > 0) {
          const prev = lastTeleStore.get(key) || 0;
          if (now - prev < gap) return;
          lastTeleStore.set(key, now);
        }
        if (onChange) {
          const v = canonical.d ? JSON.stringify(canonical.d) : r ? JSON.stringify(r) : storeText;
          const last = lastTeleValue.get(key);
          if (last && last.v === v && now - last.at < heartbeatMs) return;
          if (lastTeleValue.size > 50_000) lastTeleValue.clear();   // chặn phình bộ nhớ; hệ quả chỉ là lưu thừa một mẫu
          lastTeleValue.set(key, { v, at: now });
        }

        insert({
          ts: now, site, device, kind, payload: storeText,
          o: r ? (r[1] | 0) : null,
          i: r ? (r[0] | 0) : null,
          a: r ? (r[2] | 0) : null,
          c: r ? u32(r, 16) : null,
          s: r ? (r[8] | 0) : null,
        });
        return;
      }

      if (kind === 'alert') {
        // Gateway tự tính cảnh báo: server chỉ chuyển tiếp đúng tài khoản + lưu sự kiện vào DB
        const alert = parseGatewayAlert(text);
        if (!alert) return;
        forwardGatewayAlert(db, { site, device, alert });
      }

      if (kind === 'status') onNocodeStatus(db, parsed, text);   // gateway no-code: theo dõi online/offline để server tự báo offline
      if (kind === 'status' && tenantId) {
        const sk = `${tenantId}/${site}/${device}`;
        const was = prevStatus.get(sk);
        prevStatus.set(sk, text);
        if (was !== undefined && was !== text) {
          evaluateStatusAlert(db, { site, device, text, now });
          emitWebhook(db, {
            tenantId, site, device, event: 'status', data: { status: text, previous: was },
          });
          const n = noteStatusChange(sk, now);
          if (n) {
            audit(db, 'device_duplicate_suspect', {
              detail: `${site}/${device}: ${n} lần đổi trạng thái trong ${Math.round(dupConfig.WINDOW_MS / 60000)} phút — nghi hai máy cùng ID (gateway bị chép)`,
            });
          }
        }
      }

      insert({
        ts: now, site, device, kind, payload: text,
        o: null, i: null, a: null, c: null, s: null,
      });
    } catch (e) {
      console.error('ingest message', e.message);
    }
  };
  for (const c of clients) {
    c.on('message', (t, buf) => processMessage(t, buf, Date.now()));
    c.on('error', (e) => console.error('ingest mqtt', e.message));
  }
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
  // Telegram/email đã tắt (danh tính theo thiết bị). Cảnh báo chỉ còn trong app.
  return;
}

function pushAlarm() { /* push ngoài đã tắt */ }

function maybeWebhookAlarm(db, tenantId, site, device, alarmMask, prevAlarm, appUrl) {
  const key = `${site}/${device}`;
  const was = prevAlarm.get(key);
  prevAlarm.set(key, alarmMask);
  if (was === undefined || was === alarmMask) return;
  pushAlarm(db, { site, device, mask: alarmMask, was, appUrl });
  if (!tenantId) return;
  emitWebhook(db, {
    tenantId, site, device, event: 'alarm',
    data: { alarm: alarmMask, previous: was ?? 0 },
  });
}

export function startHistoryPurge(db) {
  let busy = false;   // không chạy chồng khi một vòng xoá/gộp còn dở (DB lớn)
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      const n = await purgeByPlanAsync(db);
      if (n) console.log(`history purge: deleted ${n} expired rows (default ${defaultDays()}d, per-plan overrides)`);
      const t = await thinOldTelemetryAsync(db);
      if (t) console.log(`history thin: gộp thưa ${t} mẫu cũ của gói không giới hạn`);
    } catch (e) {
      console.error('history purge', e.message);
    } finally { busy = false; }
  };
  run();
  return setInterval(run, 3600e3);
}
