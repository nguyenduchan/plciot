// Kiểm tra bản JS của bộ chọn icon đại lượng đo (webapp/metric-icons.js) cho CÙNG kết quả với Python/C# (icon-vectors.json).
// Chạy: node tools/solution-kit/test-icons.js   (bản C#: dotnet test tools/GatewayApp.Tests)
'use strict';
const path = require('path');
global.window = {};
require(path.join(__dirname, '..', '..', 'webapp', 'metric-icons.js'));
const Q = window.PlcQIcons;
const vec = require(path.join(__dirname, 'icon-vectors.json'));
const bad = vec.filter((t) => Q.forMetric(t.m) !== t.icon).map((t) => `${t.m.label} [${t.m.unit || ''}] → ${Q.forMetric(t.m)} (cần ${t.icon})`);
const missing = [...new Set(vec.map((t) => t.icon))].filter((id) => !Q.has(id));
if (bad.length || missing.length) { console.error('SAI:', bad.concat(missing.map((m) => 'thiếu icon ' + m)).join('\n')); process.exit(1); }
console.log(`ok: ${vec.length} chỉ số, ${Q.names.length} icon`);
