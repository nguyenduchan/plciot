/* Cấu hình giao diện ngành (sinh bởi tools/solution-kit/gen.py từ specs.py) */
window.INDUSTRY = {
 "title": "Nông nghiệp nhà kính",
 "icon": "leaf",
 "style": "soft",
 "metrics": [
  {
   "id": "temp",
   "label": "Nhiệt độ",
   "unit": "°C",
   "keys": [
    "temp_c",
    "temp"
   ],
   "agg": "avg",
   "min": 0,
   "max": 50,
   "th": {
    "lo": 16,
    "loLo": 10,
    "hi": 32,
    "hiHi": 38
   }
  },
  {
   "id": "hum",
   "label": "Độ ẩm KK",
   "unit": "%",
   "keys": [
    "hum_pct",
    "hum"
   ],
   "agg": "avg",
   "min": 0,
   "max": 100,
   "dec": 0,
   "th": {
    "lo": 45,
    "loLo": 30,
    "hi": 90,
    "hiHi": 96
   }
  },
  {
   "id": "soil",
   "label": "Độ ẩm đất",
   "unit": "%",
   "keys": [
    "soil_pct",
    "soil"
   ],
   "agg": "avg",
   "min": 0,
   "max": 100,
   "dec": 0,
   "th": {
    "lo": 30,
    "loLo": 20,
    "hi": 85,
    "hiHi": 92
   }
  },
  {
   "id": "light",
   "label": "Ánh sáng",
   "unit": "lux",
   "keys": [
    "light_lux",
    "lux"
   ],
   "agg": "avg",
   "min": 0,
   "max": 60000,
   "dec": 0
  },
  {
   "id": "co2",
   "label": "CO₂",
   "unit": "ppm",
   "keys": [
    "co2_ppm",
    "co2"
   ],
   "agg": "avg",
   "min": 300,
   "max": 2000,
   "dec": 0,
   "th": {
    "hi": 1500,
    "hiHi": 1900
   }
  },
  {
   "id": "ec",
   "label": "EC",
   "unit": "mS/cm",
   "keys": [
    "ec"
   ],
   "agg": "avg"
  },
  {
   "id": "ph",
   "label": "pH dung dịch",
   "keys": [
    "ph"
   ],
   "agg": "avg",
   "min": 4,
   "max": 9,
   "th": {
    "lo": 5.5,
    "loLo": 5,
    "hi": 6.8,
    "hiHi": 7.5
   }
  },
  {
   "id": "water",
   "label": "Nước đã tưới",
   "unit": "L",
   "keys": [
    "water_l"
   ],
   "agg": "sum",
   "dec": 0
  },
  {
   "id": "fan",
   "label": "Quạt",
   "keys": [
    "fan"
   ],
   "map": {
    "0": "Dừng",
    "1": "Chạy"
   },
   "lv": {
    "0": "off",
    "1": "ok"
   },
   "agg": "max"
  },
  {
   "id": "mist",
   "label": "Phun sương",
   "keys": [
    "mist"
   ],
   "map": {
    "0": "Dừng",
    "1": "Chạy"
   },
   "lv": {
    "0": "off",
    "1": "ok"
   },
   "agg": "max"
  },
  {
   "id": "pump",
   "label": "Bơm tưới",
   "keys": [
    "pump"
   ],
   "map": {
    "0": "Dừng",
    "1": "Chạy"
   },
   "lv": {
    "0": "off",
    "1": "ok"
   },
   "agg": "max"
  },
  {
   "id": "shade",
   "label": "Lưới che",
   "keys": [
    "shade"
   ],
   "map": {
    "0": "Mở",
    "1": "Đóng"
   },
   "lv": {
    "0": "off",
    "1": "ok"
   },
   "agg": "max"
  }
 ],
 "overview": [
  {
   "type": "kpis",
   "items": [
    "temp",
    "hum",
    "light",
    "co2"
   ]
  },
  {
   "type": "tiles",
   "title": "Các vùng trồng",
   "main": "soil",
   "subs": [
    "temp",
    "hum",
    "light"
   ]
  },
  {
   "type": "state",
   "title": "Thiết bị chấp hành",
   "items": [
    "fan",
    "mist",
    "pump",
    "shade"
   ]
  },
  {
   "type": "trend",
   "metric": "temp",
   "title": "Nhiệt độ"
  }
 ],
 "tabs": [
  {
   "id": "climate",
   "label": "Khí hậu",
   "title": "Khí hậu nhà kính",
   "icon": "thermo",
   "blocks": [
    {
     "type": "gauges",
     "items": [
      "temp",
      "hum",
      "co2"
     ]
    },
    {
     "type": "trend",
     "metric": "hum",
     "title": "Độ ẩm không khí"
    },
    {
     "type": "trend",
     "metric": "co2",
     "title": "CO₂"
    }
   ]
  },
  {
   "id": "irrig",
   "label": "Tưới",
   "title": "Tưới & dinh dưỡng",
   "icon": "drop",
   "blocks": [
    {
     "type": "state",
     "items": [
      "pump",
      "mist"
     ]
    },
    {
     "type": "bars",
     "items": [
      "soil",
      "ec",
      "ph"
     ]
    },
    {
     "type": "kpis",
     "items": [
      "water",
      "ec",
      "ph"
     ]
    }
   ]
  }
 ],
 "demo": {
  "devices": {
   "gh1": {
    "title": "Nhà kính A",
    "f": {
     "temp_c": [
      27,
      3,
      120,
      0
     ],
     "hum_pct": [
      72,
      6,
      150,
      0
     ],
     "soil_pct": [
      58,
      8,
      220,
      0
     ],
     "light_lux": [
      32000,
      9000,
      300,
      0
     ],
     "co2_ppm": [
      820,
      120,
      160,
      0
     ],
     "ec": [
      1.8,
      0.1,
      90,
      0
     ],
     "ph": [
      6.1,
      0.1,
      100,
      0
     ],
     "water_l": {
      "cnt": 0.4,
      "start": 1200
     },
     "fan": {
      "sq": [
       0,
       1
      ],
      "p": 120,
      "duty": 0.6
     },
     "mist": {
      "sq": [
       0,
       1
      ],
      "p": 90,
      "duty": 0.3
     },
     "pump": {
      "sq": [
       0,
       1
      ],
      "p": 180,
      "duty": 0.25
     },
     "shade": 0
    },
    "dec": {
     "light_lux": 0,
     "co2_ppm": 0,
     "hum_pct": 0,
     "soil_pct": 0
    }
   },
   "gh2": {
    "title": "Nhà kính B",
    "f": {
     "temp_c": [
      29,
      4,
      130,
      20
     ],
     "hum_pct": [
      66,
      7,
      140,
      0
     ],
     "soil_pct": [
      36,
      9,
      200,
      0
     ],
     "light_lux": [
      30000,
      8000,
      300,
      0
     ],
     "co2_ppm": [
      900,
      100,
      170,
      0
     ],
     "ec": [
      2.1,
      0.1,
      80,
      0
     ],
     "ph": [
      6.3,
      0.1,
      110,
      0
     ],
     "water_l": {
      "cnt": 0.3,
      "start": 900
     },
     "fan": 1,
     "mist": 0,
     "pump": {
      "sq": [
       0,
       1
      ],
      "p": 200,
      "duty": 0.3,
      "ph": 30
     },
     "shade": 1
    },
    "dec": {
     "light_lux": 0,
     "co2_ppm": 0,
     "hum_pct": 0,
     "soil_pct": 0
    }
   },
   "gh3": {
    "title": "Vườn ngoài trời",
    "f": {
     "temp_c": [
      31,
      5,
      140,
      40
     ],
     "hum_pct": [
      58,
      8,
      160,
      0
     ],
     "soil_pct": [
      44,
      7,
      240,
      0
     ],
     "light_lux": [
      48000,
      12000,
      300,
      0
     ],
     "co2_ppm": [
      430,
      20,
      170,
      0
     ],
     "water_l": {
      "cnt": 0.2,
      "start": 500
     },
     "fan": 0,
     "mist": 0,
     "pump": 0,
     "shade": 0
    },
    "dec": {
     "light_lux": 0,
     "co2_ppm": 0,
     "hum_pct": 0,
     "soil_pct": 0
    }
   }
  }
 },
 "id": "agri",
 "required": [
  "temp",
  "hum",
  "soil"
 ],
 "why": "Nhiệt độ, độ ẩm khí và độ ẩm đất quyết định tưới/thông gió; thiếu một trong ba, khối vùng trồng không đánh giá được."
};
