/**
 * Chuẩn hoá telemetry về contract dùng cho monitor / history / UI.
 * Canonical: { schema: 2, d: { childId: { field: number } } }
 * Legacy conveyor: { schema: 1, r: [...] } — chấp nhận, không phải format cần cấu hình.
 * Không còn “ingest map” / format thương mại trên admin — gateway phải đóng gói đúng pack[].
 */
export function normalizeTelemetryPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { error: 'not_object' };
  }

  if (data.d && typeof data.d === 'object' && !Array.isArray(data.d)) {
    return {
      schema: 2,
      d: data.d,
      r: Array.isArray(data.r) ? data.r : undefined,
      adapted: false,
    };
  }
  if (Array.isArray(data.r)) {
    return { schema: 1, r: data.r, adapted: false };
  }
  return { error: 'policy_telemetry_shape' };
}

/**
 * Parse buffer → canonical object cho policy + lưu history.
 */
export function resolveTelemetryMessage(_db, { payloadBuf }) {
  const text = payloadBuf.toString();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid_json', detail: 'telemetry' };
  }

  const norm = normalizeTelemetryPayload(data);
  if (norm.error) {
    return { ok: false, reason: 'policy_telemetry_shape', detail: norm.error };
  }

  const canonical = { schema: norm.schema };
  if (norm.d) canonical.d = norm.d;
  if (norm.r) canonical.r = norm.r;
  if (data.ts != null) canonical.ts = data.ts;

  return {
    ok: true,
    canonical,
    text: JSON.stringify(canonical),
    adapted: false,
    originalText: text,
  };
}
