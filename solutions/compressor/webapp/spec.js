/* Cấu hình giao diện ngành (sinh bởi tools/solution-kit/gen.py từ specs.py) */
window.INDUSTRY = {
 "title": "Khí nén & máy nén",
 "icon": "compressor",
 "style": "dense",
 "metrics": [
  {
   "id": "pressure",
   "label": "Áp suất",
   "unit": "bar",
   "keys": [
    "pressure_bar",
    "pressure"
   ],
   "agg": "avg",
   "dec": 1,
   "min": 0,
   "max": 12,
   "th": {
    "lo": 5.5,
    "loLo": 4.5,
    "hi": 8.5,
    "hiHi": 9.5
   }
  },
  {
   "id": "flow",
   "label": "Lưu lượng",
   "unit": "m³/ph",
   "keys": [
    "flow_m3min",
    "flow"
   ],
   "agg": "sum",
   "dec": 1
  },
  {
   "id": "kw",
   "label": "Công suất",
   "unit": "kW",
   "keys": [
    "kw"
   ],
   "agg": "sum",
   "dec": 1
  },
  {
   "id": "load",
   "label": "Tải",
   "unit": "%",
   "keys": [
    "load_pct"
   ],
   "agg": "avg",
   "dec": 0,
   "min": 0,
   "max": 100
  },
  {
   "id": "temp",
   "label": "Nhiệt độ đầu nén",
   "unit": "°C",
   "keys": [
    "temp_c",
    "temp"
   ],
   "agg": "max",
   "dec": 0,
   "min": 20,
   "max": 120,
   "th": {
    "hi": 95,
    "hiHi": 105
   }
  },
  {
   "id": "run",
   "label": "Trạng thái",
   "keys": [
    "run"
   ],
   "agg": "max",
   "map": {
    "0": "Dừng",
    "1": "Chạy tải",
    "2": "Không tải",
    "3": "LỖI"
   },
   "lv": {
    "0": "off",
    "1": "ok",
    "2": "warn",
    "3": "bad"
   }
  },
  {
   "id": "sp",
   "label": "Công suất riêng",
   "unit": "kW/(m³/ph)",
   "keys": [
    "sp"
   ],
   "agg": "avg",
   "dec": 1
  },
  {
   "id": "hours",
   "label": "Giờ chạy",
   "unit": "h",
   "keys": [
    "hours"
   ],
   "agg": "sum",
   "dec": 0
  },
  {
   "id": "dew",
   "label": "Điểm sương",
   "unit": "°C",
   "keys": [
    "dewpoint"
   ],
   "agg": "max",
   "dec": 0,
   "th": {
    "hi": 5,
    "hiHi": 10
   }
  }
 ],
 "overview": [
  {
   "type": "gauges",
   "items": [
    "pressure",
    "temp",
    "load"
   ]
  },
  {
   "type": "kpis",
   "items": [
    "flow",
    "kw",
    "sp",
    "hours"
   ]
  },
  {
   "type": "tiles",
   "title": "Các máy nén",
   "main": "run",
   "subs": [
    "pressure",
    "kw",
    "temp"
   ]
  },
  {
   "type": "alarms"
  },
  {
   "type": "trend",
   "metric": "pressure",
   "title": "Áp suất mạng khí"
  }
 ],
 "tabs": [
  {
   "id": "eff",
   "label": "Hiệu suất",
   "title": "Hiệu suất năng lượng",
   "icon": "bolt",
   "blocks": [
    {
     "type": "kpis",
     "items": [
      "kw",
      "sp",
      "flow"
     ]
    },
    {
     "type": "bars",
     "items": [
      "load",
      "dew"
     ]
    },
    {
     "type": "trend",
     "metric": "kw",
     "title": "Công suất"
    }
   ]
  },
  {
   "id": "maint",
   "label": "Bảo trì",
   "title": "Bảo trì",
   "icon": "gear",
   "blocks": [
    {
     "type": "kpis",
     "items": [
      "hours",
      "temp"
     ]
    },
    {
     "type": "alarms"
    }
   ]
  }
 ],
 "demo": {
  "devices": {
   "cp1": {
    "title": "Máy nén 1",
    "dec": {
     "pressure_bar": 1,
     "flow_m3min": 1,
     "kw": 1,
     "sp": 1,
     "load_pct": 0,
     "temp_c": 0,
     "hours": 0,
     "dewpoint": 0
    },
    "f": {
     "pressure_bar": [
      7.2,
      0.4,
      70,
      0
     ],
     "flow_m3min": [
      14,
      2,
      90,
      0
     ],
     "kw": [
      75,
      8,
      80,
      0
     ],
     "load_pct": [
      72,
      12,
      120,
      0
     ],
     "temp_c": [
      84,
      4,
      150,
      0
     ],
     "run": {
      "sq": [
       2,
       1
      ],
      "p": 200,
      "duty": 0.7
     },
     "sp": [
      5.4,
      0.2,
      100,
      0
     ],
     "hours": {
      "cnt": 0.0003,
      "start": 21480
     },
     "dewpoint": [
      3,
      1,
      200,
      0
     ]
    }
   },
   "cp2": {
    "title": "Máy nén 2",
    "dec": {
     "pressure_bar": 1,
     "flow_m3min": 1,
     "kw": 1,
     "sp": 1,
     "load_pct": 0,
     "temp_c": 0,
     "hours": 0,
     "dewpoint": 0
    },
    "f": {
     "pressure_bar": [
      7.1,
      0.4,
      75,
      10
     ],
     "flow_m3min": [
      11,
      2,
      95,
      5
     ],
     "kw": [
      60,
      7,
      85,
      0
     ],
     "load_pct": [
      60,
      12,
      130,
      0
     ],
     "temp_c": [
      88,
      5,
      160,
      0
     ],
     "run": {
      "sq": [
       0,
       1
      ],
      "p": 300,
      "duty": 0.8
     },
     "sp": [
      5.6,
      0.2,
      110,
      0
     ],
     "hours": {
      "cnt": 0.0003,
      "start": 17200
     },
     "dewpoint": [
      4,
      1,
      210,
      0
     ]
    }
   }
  }
 },
 "id": "compressor",
 "required": [
  "pressure",
  "run"
 ],
 "why": "Áp suất mạng khí và trạng thái máy (tải/không tải/lỗi)."
};
