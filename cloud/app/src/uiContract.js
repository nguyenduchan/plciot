/**
 * UI contract chuẩn hóa — webapp và C# cùng consume.
 * GET /api/v1/ui/schema | /types | /dashboard
 */
import { applyControlSpec } from './childControl.js';

export const UI_CONTRACT_VERSION = '2026-11-05';
export const UI_SCHEMA = 1;

/** Các kind ổn định giữa clients; kind lạ → fallback kpi/text. */
export const WIDGET_KINDS = Object.freeze({
  kpi: { fields: ['bind', 'label', 'unit?'] },
  gauge: { fields: ['bind', 'label', 'unit?', 'min', 'max'] },
  ring: { fields: ['bind', 'label'] },
  sparkline: { fields: ['bind', 'label', 'unit?'] },
  line: { fields: ['bind', 'label', 'unit?'] },
  bar: { fields: ['bind', 'label'] },
  table: { fields: ['columns'] },
  chip: { fields: ['bind', 'label'] },
  toggle: { fields: ['bind', 'label', 'cmd'] },
  button: { fields: ['label', 'cmd'] },
  status: { fields: ['bind', 'label'] },
  text: { fields: ['bind', 'label'] },
});

/**
 * Catalog loại thiết bị + widget mặc định.
 * profile trên hardware_devices trỏ vào id này (hoặc alias control profile conveyor-v1 → conveyor).
 */
export const DEVICE_TYPES = Object.freeze({
  conveyor: {
    id: 'conveyor',
    title: 'Băng tải',
    controlProfile: 'conveyor-v1',
    source: { path: 'r', map: 'conveyor-v1' },
    widgets: [
      { id: 'cnt', kind: 'kpi', bind: 'count', label: 'Số lượng' },
      { id: 'run', kind: 'ring', bind: 'runPct', label: 'Thời gian chạy' },
      { id: 'spd', kind: 'kpi', bind: 'speed', label: 'Tốc độ', unit: 'sp/phút' },
      { id: 'ctl', kind: 'toggle', bind: 'runReq', label: 'Chạy / Dừng', cmd: { a: 6, on: 1, off: 0 } },
    ],
  },
  env: {
    id: 'env',
    title: 'Môi trường',
    source: { path: 'd.{childId}' },
    widgets: [
      { id: 't', kind: 'gauge', bind: 't', label: 'Nhiệt độ', unit: '°C', min: -10, max: 60 },
      { id: 'h', kind: 'gauge', bind: 'h', label: 'Độ ẩm', unit: '%', min: 0, max: 100 },
      { id: 'spark', kind: 'sparkline', bind: 't', label: 'Nhiệt độ' },
    ],
  },
  switch: {
    id: 'switch',
    title: 'Công tắc',
    source: { path: 'd.{childId}' },
    widgets: [
      { id: 'on', kind: 'toggle', bind: 'on', label: 'Bật / Tắt', cmd: { key: 'on', on: 1, off: 0 } },
      { id: 'st', kind: 'status', bind: 'on', label: 'Trạng thái' },
    ],
  },
  relay: {
    id: 'relay',
    title: 'Relay',
    source: { path: 'd.{childId}' },
    widgets: [
      { id: 'on', kind: 'toggle', bind: 'on', label: 'Relay', cmd: { key: 'on', on: 1, off: 0 } },
    ],
  },
  di: {
    id: 'di',
    title: 'Đầu vào số',
    source: { path: 'd.{childId}' },
    widgets: [{ id: 'v', kind: 'chip', bind: 'v', label: 'DI' }],
  },
  do: {
    id: 'do',
    title: 'Đầu ra số',
    source: { path: 'd.{childId}' },
    widgets: [
      { id: 'v', kind: 'toggle', bind: 'v', label: 'DO', cmd: { key: 'v', on: 1, off: 0 } },
    ],
  },
  pump: {
    id: 'pump',
    title: 'Bơm',
    source: { path: 'd.{childId}' },
    widgets: [
      { id: 'run', kind: 'toggle', bind: 'run', label: 'Bơm', cmd: { key: 'run', on: 1, off: 0 } },
      { id: 'hours', kind: 'kpi', bind: 'hours', label: 'Giờ chạy', unit: 'h' },
      { id: 'flow', kind: 'gauge', bind: 'flow', label: 'Lưu lượng', unit: 'L/phút', min: 0, max: 100 },
    ],
  },
  motor: {
    id: 'motor',
    title: 'Động cơ',
    source: { path: 'd.{childId}' },
    widgets: [
      { id: 'run', kind: 'toggle', bind: 'run', label: 'Chạy', cmd: { key: 'run', on: 1, off: 0 } },
      { id: 'rpm', kind: 'kpi', bind: 'rpm', label: 'RPM' },
    ],
  },
  energy: {
    id: 'energy',
    title: 'Điện năng',
    source: { path: 'd.{childId}' },
    widgets: [
      { id: 'kw', kind: 'kpi', bind: 'kw', label: 'Công suất', unit: 'kW' },
      { id: 'kwh', kind: 'kpi', bind: 'kwh', label: 'Điện năng', unit: 'kWh' },
      { id: 'line', kind: 'line', bind: 'kw', label: 'kW' },
    ],
  },
  tank: {
    id: 'tank',
    title: 'Bồn / mức',
    source: { path: 'd.{childId}' },
    widgets: [
      { id: 'level', kind: 'gauge', bind: 'level', label: 'Mức', unit: '%', min: 0, max: 100 },
      { id: 'st', kind: 'status', bind: 'level', label: 'Trạng thái' },
    ],
  },
  'iot-hub': {
    id: 'iot-hub',
    title: 'Gateway IoT',
    source: { path: 'd' },
    widgets: [
      { id: 'online', kind: 'status', bind: 'online', label: 'Gateway' },
    ],
  },
  generic: {
    id: 'generic',
    title: 'Tuỳ chọn',
    source: { path: 'd.{childId}' },
    widgets: [
      { id: 'v', kind: 'kpi', bind: 'v', label: 'Giá trị' },
      { id: 't', kind: 'text', bind: 't', label: 'Ghi chú' },
    ],
  },
});

/** Alias control / legacy profile → device type id. */
const PROFILE_ALIAS = Object.freeze({
  'conveyor-v1': 'conveyor',
  'monitor-only': 'generic',
  'generic-holding-v1': 'generic',
});

export function resolveDeviceTypeId(profileOrType) {
  const raw = String(profileOrType || '').trim();
  if (!raw) return null;
  if (DEVICE_TYPES[raw]) return raw;
  if (PROFILE_ALIAS[raw]) return PROFILE_ALIAS[raw];
  return null;
}

export function getDeviceType(typeId) {
  const id = resolveDeviceTypeId(typeId);
  return id ? DEVICE_TYPES[id] : null;
}

export function listDeviceTypes() {
  return Object.values(DEVICE_TYPES).map(({ id, title, widgets, controlProfile }) => ({
    id, title, controlProfile: controlProfile || null, widgetCount: widgets.length,
  }));
}

export function uiSchemaPublic() {
  return {
    schema: UI_SCHEMA,
    version: UI_CONTRACT_VERSION,
    modes: ['simple', 'pro'],
    widgetKinds: { ...WIDGET_KINDS },
    deviceTypes: Object.keys(DEVICE_TYPES),
  };
}

function cloneWidgets(type, childId) {
  return (type.widgets || []).map((w) => ({ ...w, id: `${childId}_${w.id}` }));
}

function sourceFor(type, childId) {
  const path = String(type.source?.path || 'd.{childId}').replace(/\{childId\}/g, childId);
  return { ...type.source, path };
}

/**
 * @param {{ id: string, childId: string, type: string, title?: string }} row
 */
export function deviceToUiNode(row) {
  const type = getDeviceType(row.type) || DEVICE_TYPES.generic;
  const childId = row.childId || row.child_id || type.id;
  return {
    id: String(row.id),
    childId,
    type: type.id,
    title: row.title || type.title,
    source: sourceFor(type, childId),
    widgets: applyControlSpec(cloneWidgets(type, childId), { spec: row.spec, userCritical: row.userCritical }),
  };
}

/**
 * @param {object} opts
 * @param {object} opts.user
 * @param {Array} opts.devices — rows from user_devices
 * @param {'simple'|'pro'} [opts.mode]
 */
export function resolveDashboard({ user, devices, mode = 'simple' } = {}) {
  const m = mode === 'pro' ? 'pro' : 'simple';
  const site = user?.notify_site || '';
  const gateway = user?.notify_device || '';
  const nodes = (devices || []).map(deviceToUiNode);
  const order = nodes.map((d) => d.id);
  return {
    schema: UI_SCHEMA,
    version: UI_CONTRACT_VERSION,
    mode: m,
    site,
    gateway,
    telemetry: {
      topicBase: site && gateway ? `plc/${site}/${gateway}` : null,
      legacyRegs: nodes.some((d) => d.type === 'conveyor'),
      devicesPath: 'd',
      schema: 2,
    },
    control: {
      topicCmd: site && gateway ? `plc/${site}/${gateway}/cmd` : null,
      topicAck: site && gateway ? `plc/${site}/${gateway}/ack` : null,
    },
    devices: nodes,
    layout: {
      simple: { columns: 2, order },
      pro: {
        grid: nodes.map((d, i) => ({ deviceId: d.id, x: (i % 2) * 4, y: Math.floor(i / 2) * 2, w: 4, h: 2 })),
      },
    },
  };
}
