/* Cấu hình giao diện ngành (sinh bởi tools/solution-kit/gen.py từ specs.py) */
window.INDUSTRY = {
 "title": "Sản xuất & OEE",
 "icon": "factory",
 "style": "sharp",
 "metrics": [
  {
   "id": "oee",
   "label": "OEE",
   "unit": "%",
   "keys": [
    "oee"
   ],
   "agg": "avg",
   "dec": 0,
   "min": 0,
   "max": 100,
   "th": {
    "lo": 60,
    "loLo": 40
   }
  },
  {
   "id": "avail",
   "label": "Sẵn sàng",
   "unit": "%",
   "keys": [
    "avail"
   ],
   "agg": "avg",
   "dec": 0,
   "min": 0,
   "max": 100,
   "th": {
    "lo": 75,
    "loLo": 60
   }
  },
  {
   "id": "perf",
   "label": "Hiệu suất",
   "unit": "%",
   "keys": [
    "perf"
   ],
   "agg": "avg",
   "dec": 0,
   "min": 0,
   "max": 100,
   "th": {
    "lo": 75,
    "loLo": 60
   }
  },
  {
   "id": "qual",
   "label": "Chất lượng",
   "unit": "%",
   "keys": [
    "qual"
   ],
   "agg": "avg",
   "dec": 1,
   "min": 0,
   "max": 100,
   "th": {
    "lo": 95,
    "loLo": 90
   }
  },
  {
   "id": "count",
   "label": "Sản lượng ca",
   "unit": "sp",
   "keys": [
    "count"
   ],
   "agg": "max",
   "dec": 0
  },
  {
   "id": "reject",
   "label": "Phế phẩm",
   "unit": "sp",
   "keys": [
    "reject"
   ],
   "agg": "sum",
   "dec": 0
  },
  {
   "id": "scrap",
   "label": "Tỷ lệ phế phẩm",
   "unit": "%",
   "expr": "reject / count * 100",
   "dec": 1,
   "th": {
    "hi": 3,
    "hiHi": 6
   }
  },
  {
   "id": "speed",
   "label": "Tốc độ",
   "unit": "sp/ph",
   "keys": [
    "speed"
   ],
   "agg": "avg",
   "dec": 0,
   "min": 0,
   "max": 100
  },
  {
   "id": "state",
   "label": "Trạng thái",
   "keys": [
    "state"
   ],
   "agg": "max",
   "map": {
    "0": "Dừng",
    "1": "Chạy",
    "2": "LỖI",
    "3": "Chờ"
   },
   "lv": {
    "0": "off",
    "1": "ok",
    "2": "bad",
    "3": "warn"
   }
  },
  {
   "id": "down",
   "label": "Dừng máy",
   "unit": "phút",
   "keys": [
    "down"
   ],
   "agg": "sum",
   "dec": 0
  },
  {
   "id": "kw",
   "label": "Công suất",
   "unit": "kW",
   "keys": [
    "kw"
   ],
   "agg": "sum"
  }
 ],
 "overview": [
  {
   "type": "ring",
   "main": "oee",
   "subs": [
    "avail",
    "perf",
    "qual"
   ]
  },
  {
   "type": "kpis",
   "items": [
    "count",
    "reject",
    "scrap",
    "kw"
   ]
  },
  {
   "type": "line",
   "title": "Dây chuyền",
   "state": "state",
   "sub": "speed"
  },
  {
   "type": "alarms"
  },
  {
   "type": "trend",
   "metric": "oee",
   "title": "OEE"
  }
 ],
 "tabs": [
  {
   "id": "lines",
   "label": "Công đoạn",
   "title": "Các công đoạn",
   "icon": "gear",
   "blocks": [
    {
     "type": "tiles",
     "main": "state",
     "subs": [
      "count",
      "speed",
      "reject"
     ]
    }
   ]
  },
  {
   "id": "quality",
   "label": "Chất lượng",
   "title": "Chất lượng & dừng máy",
   "icon": "chart",
   "blocks": [
    {
     "type": "bars",
     "items": [
      "avail",
      "perf",
      "qual"
     ]
    },
    {
     "type": "kpis",
     "items": [
      "reject",
      "down"
     ]
    },
    {
     "type": "trend",
     "metric": "reject",
     "title": "Phế phẩm"
    }
   ]
  }
 ],
 "demo": {
  "devices": {
   "st1": {
    "title": "Cắt",
    "dec": {
     "oee": 0,
     "avail": 0,
     "perf": 0,
     "qual": 1,
     "speed": 0,
     "count": 0
    },
    "f": {
     "oee": [
      78,
      4,
      140,
      0
     ],
     "avail": [
      91,
      2,
      160,
      0
     ],
     "perf": [
      87,
      3,
      130,
      0
     ],
     "qual": [
      98.6,
      0.3,
      120,
      0
     ],
     "count": {
      "cnt": 1.0,
      "start": 2400
     },
     "reject": {
      "cnt": 0.02,
      "start": 20
     },
     "speed": [
      60,
      5,
      70,
      0
     ],
     "state": 1,
     "down": {
      "cnt": 0.002,
      "start": 22
     },
     "kw": [
      14,
      2,
      80,
      0
     ]
    }
   },
   "st2": {
    "title": "Hàn",
    "dec": {
     "oee": 0,
     "avail": 0,
     "perf": 0,
     "qual": 1,
     "speed": 0,
     "count": 0
    },
    "f": {
     "oee": [
      74,
      5,
      150,
      10
     ],
     "avail": [
      88,
      2,
      170,
      0
     ],
     "perf": [
      84,
      3,
      140,
      0
     ],
     "qual": [
      98.2,
      0.3,
      130,
      0
     ],
     "count": {
      "cnt": 0.96,
      "start": 2300
     },
     "reject": {
      "cnt": 0.03,
      "start": 31
     },
     "speed": [
      58,
      5,
      75,
      0
     ],
     "state": {
      "sq": [
       3,
       1
      ],
      "p": 300,
      "duty": 0.9
     },
     "down": {
      "cnt": 0.003,
      "start": 34
     },
     "kw": [
      22,
      3,
      90,
      0
     ]
    }
   },
   "st3": {
    "title": "Sơn",
    "dec": {
     "oee": 0,
     "avail": 0,
     "perf": 0,
     "qual": 1,
     "speed": 0,
     "count": 0
    },
    "f": {
     "oee": [
      70,
      6,
      160,
      20
     ],
     "avail": [
      84,
      3,
      180,
      0
     ],
     "perf": [
      82,
      3,
      150,
      0
     ],
     "qual": [
      97.4,
      0.5,
      140,
      0
     ],
     "count": {
      "cnt": 0.9,
      "start": 2150
     },
     "reject": {
      "cnt": 0.05,
      "start": 52
     },
     "speed": [
      55,
      4,
      80,
      0
     ],
     "state": {
      "sq": [
       2,
       1
      ],
      "p": 360,
      "duty": 0.92
     },
     "down": {
      "cnt": 0.004,
      "start": 47
     },
     "kw": [
      30,
      3,
      100,
      0
     ]
    }
   },
   "st4": {
    "title": "Lắp ráp",
    "dec": {
     "oee": 0,
     "avail": 0,
     "perf": 0,
     "qual": 1,
     "speed": 0,
     "count": 0
    },
    "f": {
     "oee": [
      80,
      4,
      130,
      30
     ],
     "avail": [
      93,
      2,
      150,
      0
     ],
     "perf": [
      88,
      3,
      120,
      0
     ],
     "qual": [
      99,
      0.2,
      110,
      0
     ],
     "count": {
      "cnt": 0.9,
      "start": 2100
     },
     "reject": {
      "cnt": 0.01,
      "start": 11
     },
     "speed": [
      52,
      4,
      90,
      0
     ],
     "state": 1,
     "down": {
      "cnt": 0.001,
      "start": 12
     },
     "kw": [
      9,
      1,
      70,
      0
     ]
    }
   },
   "st5": {
    "title": "Đóng gói",
    "dec": {
     "oee": 0,
     "avail": 0,
     "perf": 0,
     "qual": 1,
     "speed": 0,
     "count": 0
    },
    "f": {
     "oee": [
      83,
      3,
      120,
      40
     ],
     "avail": [
      95,
      1.5,
      140,
      0
     ],
     "perf": [
      90,
      2,
      110,
      0
     ],
     "qual": [
      99.5,
      0.2,
      100,
      0
     ],
     "count": {
      "cnt": 0.88,
      "start": 2050
     },
     "reject": {
      "cnt": 0.005,
      "start": 6
     },
     "speed": [
      50,
      3,
      100,
      0
     ],
     "state": {
      "sq": [
       0,
       1
      ],
      "p": 500,
      "duty": 0.95
     },
     "down": {
      "cnt": 0.001,
      "start": 8
     },
     "kw": [
      6,
      0.8,
      60,
      0
     ]
    }
   }
  }
 },
 "id": "factory",
 "required": [
  "state",
  "count"
 ],
 "why": "Trạng thái máy và bộ đếm sản phẩm là nền để tính OEE; avail/perf/qual nếu có thì hiện vòng chi tiết."
};
