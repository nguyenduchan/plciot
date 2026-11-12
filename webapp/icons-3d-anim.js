'use strict';
/**
 * Bổ sung lớp chuyển động nhẹ cho các icon 3D chưa có (tank, silo, van, lọc, máy phát, biến áp, gia nhiệt, cảm biến, PLC…).
 * Mỗi icon được chèn thêm vài phần tử có class ic-* ngay trước </svg>; hiệu ứng CHỈ chạy khi bật "Hiệu ứng chuyển động"
 * và thiết bị đang hoạt động (CSS trong style.css). Không sửa hình gốc nên không ảnh hưởng icon khi tắt chuyển động.
 */
(function () {
  const A = window.PlcIcons3D; if (!A) return;
  const EXTRA = {
    tank: '<path class="ic-liq" d="M10 27c3-2 5 2 8 0s5 2 8 0 5 2 8 0 3-1 4 0v11a15 5 0 0 1-30 0z" fill="url(#g3-liq)" fill-opacity=".85"/><path class="ic-wave" d="M10 27c3-2 5 2 8 0s5 2 8 0 5 2 8 0 3-1 4 0" stroke="#e1f2ff" stroke-width="2" fill="none" stroke-linecap="round"/><circle class="ic-pulse" cx="24" cy="7" r="1.8" fill="#7cc4ff"/>',
    silo: '<path class="ic-flow" d="M24 14v22" stroke="#fde68a" stroke-width="2.4" stroke-linecap="round"/>',
    valve: '<path class="ic-flow" d="M2 30.5h9M37 30.5h9" stroke="#7cc4ff" stroke-width="2.4" stroke-linecap="round"/>',
    filter: '<path class="ic-flow" d="M3 22.5h5M40 22.5h5" stroke="#7cc4ff" stroke-width="2.4" stroke-linecap="round"/><rect class="ic-pulse" x="14" y="15" width="20" height="20" rx="2" fill="#7cc4ff" fill-opacity=".2"/>',
    generator: '<g class="ic-rot"><path d="M20 17v2M20 32v2M12 25.5h2M26 25.5h2" stroke="#ffd43b" stroke-width="1.8" stroke-linecap="round"/></g>',
    transformer: '<path class="ic-pulse" d="M16 20v12M24 20v12M32 20v12" stroke="#ffd43b" stroke-width="1.8" stroke-linecap="round"/>',
    heater: '<path class="ic-pulse" d="M13 19h22M13 24h22M13 29h22" stroke="#ff4d1a" stroke-width="3.2" stroke-linecap="round" opacity=".7"/>',
    env: '<rect class="ic-merc" x="22" y="12" width="4" height="22" rx="2" fill="#ff5a5a"/><circle class="ic-pulse" cx="24" cy="36" r="8.5" fill="#ff8a8a" fill-opacity=".45"/>',
    humidity: '<circle class="ic-pulse" cx="21" cy="33" r="3" fill="#fff"/>',
    ph: '<circle class="ic-pulse" cx="20" cy="34" r="1.6" fill="#fff"/><circle class="ic-pulse" cx="28" cy="36" r="1.2" fill="#fff"/>',
    gas: '<path class="ic-pulse" d="M17 22c3-3 5 3 8 0s5 3 8 0" stroke="#4ade80" stroke-width="1.8" fill="none" stroke-linecap="round"/>',
    sensor: '<circle class="ic-pulse" cx="33" cy="18" r="4" fill="#4ade80" fill-opacity=".5"/>',
    scale: '<rect class="ic-pulse" x="19" y="8" width="10" height="5" fill="#4ade80" fill-opacity=".5"/>',
    breaker: '<rect class="ic-pulse" x="19" y="24" width="10" height="8" rx="1.5" fill="#4ade80" fill-opacity=".45"/>',
    relay: '<circle class="ic-pulse" cx="35" cy="31" r="3.6" fill="#4ade80" fill-opacity=".5"/>',
    door: '<circle class="ic-pulse" cx="30" cy="25" r="3" fill="#fde68a"/>',
    crane: '<g class="ic-sway"><path d="M24 17v13" stroke="#e8eef6" stroke-width="1.8"/><path d="M20 30h8l-1 4a3 3 0 1 1-6 0z" fill="#b9c4d2" stroke="rgba(0,0,0,.4)" stroke-width="1"/></g>',
    plc: '<circle class="ic-pulse" cx="14" cy="21" r="3" fill="#4ade80" fill-opacity=".5"/><circle class="ic-pulse" cx="29" cy="21" r="3" fill="#f87171" fill-opacity=".5"/>',
    counter: '<rect class="ic-pulse" x="8" y="16" width="32" height="16" rx="2" fill="#4ade80" fill-opacity=".12"/>',
    di: '<ellipse class="ic-pulse" cx="21" cy="19" rx="4" ry="2.6" fill="#fff" fill-opacity=".6"/>',
    do: '<circle class="ic-pulse" cx="24" cy="26" r="12" fill="#4ade80" fill-opacity=".18"/>',
    power: '<circle class="ic-pulse" cx="24" cy="24" r="19" stroke="#4ade80" stroke-width="2" fill="none"/>',
  };
  for (const [id, extra] of Object.entries(EXTRA)) {
    const orig = A[id]; if (!orig) continue;
    A[id] = () => orig().replace('</svg>', `${extra}</svg>`);
  }
}());
