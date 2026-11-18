/* Cấu hình giao diện ngành (sinh bởi tools/solution-kit/gen.py từ specs.py) */
window.INDUSTRY = {
 "title": "Lò hơi công nghiệp",
 "icon": "flame",
 "style": "sharp",
 "metrics": [
  {
   "id": "wl",
   "label": "Mức nước",
   "unit": "%",
   "keys": [
    "water_lvl"
   ],
   "agg": "avg",
   "dec": 0,
   "min": 0,
   "max": 100,
   "th": {
    "lo": 35,
    "loLo": 25,
    "hi": 85,
    "hiHi": 92
   }
  },
  {
   "id": "press",
   "label": "Áp suất hơi",
   "unit": "bar",
   "keys": [
    "press_bar"
   ],
   "agg": "avg",
   "dec": 1,
   "min": 0,
   "max": 12,
   "th": {
    "hi": 9,
    "hiHi": 10.5
   }
  },
  {
   "id": "temp",
   "label": "Nhiệt độ hơi",
   "unit": "°C",
   "keys": [
    "temp_c"
   ],
   "agg": "avg",
   "dec": 0,
   "min": 0,
   "max": 250,
   "th": {
    "hi": 185,
    "hiHi": 200
   }
  },
  {
   "id": "flame",
   "label": "Ngọn lửa",
   "keys": [
    "flame"
   ],
   "agg": "max",
   "map": {
    "0": "Tắt",
    "1": "Cháy"
   },
   "lv": {
    "0": "off",
    "1": "ok"
   }
  },
  {
   "id": "pump",
   "label": "Bơm cấp nước",
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
   "id": "feedv",
   "label": "Van cấp",
   "keys": [
    "feed_v"
   ],
   "map": {
    "0": "Đóng",
    "1": "Mở"
   },
   "lv": {
    "0": "off",
    "1": "ok"
   },
   "agg": "max"
  },
  {
   "id": "steamv",
   "label": "Van hơi",
   "keys": [
    "steam_v"
   ],
   "map": {
    "0": "Đóng",
    "1": "Mở"
   },
   "lv": {
    "0": "off",
    "1": "ok"
   },
   "agg": "max"
  },
  {
   "id": "fuel",
   "label": "Nhiên liệu",
   "unit": "%",
   "keys": [
    "fuel"
   ],
   "agg": "avg",
   "dec": 0,
   "min": 0,
   "max": 100,
   "th": {
    "lo": 20,
    "loLo": 10
   }
  },
  {
   "id": "steam",
   "label": "Sản lượng hơi",
   "unit": "kg/h",
   "keys": [
    "steam_kgh"
   ],
   "agg": "sum",
   "dec": 0
  },
  {
   "id": "eff",
   "label": "Hiệu suất",
   "unit": "%",
   "keys": [
    "eff"
   ],
   "agg": "avg",
   "dec": 1
  }
 ],
 "overview": [
  {
   "type": "pid",
   "w": 130,
   "h": 70,
   "pipes": [
    {
     "pts": [
      [
       23,
       24
      ],
      [
       66,
       24
      ]
     ],
     "on": "pump",
     "color": "var(--acc)"
    },
    {
     "pts": [
      [
       93,
       30
      ],
      [
       128,
       30
      ]
     ],
     "on": "steamv",
     "color": "var(--warn)"
    }
   ],
   "nodes": [
    {
     "kind": "tank",
     "x": 14,
     "y": 10,
     "w": 18,
     "h": 28,
     "metric": "wl",
     "label": "Bồn nước cấp"
    },
    {
     "kind": "pump",
     "x": 38,
     "y": 24,
     "metric": "pump",
     "label": "Bơm cấp"
    },
    {
     "kind": "valve",
     "x": 52,
     "y": 24,
     "metric": "feedv",
     "label": "Van cấp"
    },
    {
     "kind": "vessel",
     "x": 80,
     "y": 12,
     "w": 26,
     "h": 36,
     "metric": "press",
     "label": "Nồi hơi"
    },
    {
     "kind": "valve",
     "x": 108,
     "y": 30,
     "metric": "steamv",
     "label": "Van hơi"
    },
    {
     "kind": "sensor",
     "x": 80,
     "y": 58,
     "metric": "temp",
     "label": "Nhiệt độ hơi"
    },
    {
     "kind": "sensor",
     "x": 50,
     "y": 58,
     "metric": "flame",
     "label": "Lửa"
    }
   ]
  },
  {
   "type": "kpis",
   "items": [
    "press",
    "temp",
    "steam",
    "eff"
   ]
  },
  {
   "type": "state",
   "items": [
    "flame",
    "pump",
    "feedv",
    "steamv"
   ]
  },
  {
   "type": "alarms"
  },
  {
   "type": "trend",
   "metric": "press",
   "title": "Áp suất hơi"
  }
 ],
 "tabs": [
  {
   "id": "safe",
   "label": "An toàn",
   "title": "An toàn lò hơi",
   "icon": "bell",
   "blocks": [
    {
     "type": "gauges",
     "items": [
      "press",
      "wl",
      "temp"
     ]
    },
    {
     "type": "bars",
     "items": [
      "wl",
      "press",
      "fuel"
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
   "b1": {
    "title": "Lò hơi 1",
    "dec": {
     "water_lvl": 0,
     "press_bar": 1,
     "temp_c": 0,
     "fuel": 0,
     "steam_kgh": 0,
     "eff": 1
    },
    "f": {
     "water_lvl": [
      60,
      14,
      200,
      0
     ],
     "press_bar": [
      7.8,
      1.3,
      120,
      0
     ],
     "temp_c": [
      172,
      12,
      140,
      0
     ],
     "flame": {
      "sq": [
       0,
       1
      ],
      "p": 180,
      "duty": 0.8
     },
     "pump": {
      "sq": [
       0,
       1
      ],
      "p": 200,
      "duty": 0.6
     },
     "feed_v": {
      "sq": [
       0,
       1
      ],
      "p": 200,
      "duty": 0.65
     },
     "steam_v": 1,
     "fuel": [
      58,
      10,
      500,
      0
     ],
     "steam_kgh": [
      1800,
      300,
      100,
      0
     ],
     "eff": [
      86,
      1.5,
      150,
      0
     ]
    }
   }
  }
 },
 "id": "boiler",
 "required": [
  "wl",
  "press",
  "flame"
 ],
 "why": "Mức nước, áp suất hơi và ngọn lửa là ba tín hiệu an toàn bắt buộc của lò hơi; thiếu thì không được coi là giám sát đủ điều kiện."
};
