/* Cấu hình giao diện ngành (sinh bởi tools/solution-kit/gen.py từ specs.py) */
window.INDUSTRY = {
 "title": "Trạm sạc xe điện",
 "icon": "plug",
 "style": "glass",
 "metrics": [
  {
   "id": "state",
   "label": "Trạng thái",
   "keys": [
    "state"
   ],
   "agg": "max",
   "map": {
    "0": "Rảnh",
    "1": "Đang sạc",
    "2": "LỖI",
    "3": "Đã cắm"
   },
   "lv": {
    "0": "off",
    "1": "ok",
    "2": "bad",
    "3": "warn"
   }
  },
  {
   "id": "kw",
   "label": "Công suất",
   "unit": "kW",
   "keys": [
    "kw"
   ],
   "agg": "sum",
   "dec": 1,
   "min": 0,
   "max": 150
  },
  {
   "id": "kwh",
   "label": "Điện sạc hôm nay",
   "unit": "kWh",
   "keys": [
    "kwh_today",
    "kwh"
   ],
   "agg": "sum",
   "dec": 0
  },
  {
   "id": "soc",
   "label": "SOC xe",
   "unit": "%",
   "keys": [
    "soc"
   ],
   "agg": "avg",
   "dec": 0,
   "min": 0,
   "max": 100
  },
  {
   "id": "sessions",
   "label": "Phiên sạc",
   "keys": [
    "sessions"
   ],
   "agg": "sum",
   "dec": 0
  },
  {
   "id": "rev",
   "label": "Doanh thu",
   "unit": "k₫",
   "keys": [
    "rev_k",
    "rev"
   ],
   "agg": "sum",
   "dec": 0
  },
  {
   "id": "temp",
   "label": "Nhiệt độ trụ",
   "unit": "°C",
   "keys": [
    "temp"
   ],
   "agg": "max",
   "dec": 0,
   "th": {
    "hi": 60,
    "hiHi": 75
   }
  },
  {
   "id": "busy",
   "label": "Trụ đang sạc",
   "keys": [
    "state"
   ],
   "agg": "count",
   "dec": 0
  }
 ],
 "overview": [
  {
   "type": "kpis",
   "items": [
    "kw",
    "kwh",
    "sessions",
    "rev"
   ]
  },
  {
   "type": "tiles",
   "title": "Các trụ sạc",
   "main": "state",
   "subs": [
    "kw",
    "soc",
    "temp"
   ]
  },
  {
   "type": "alarms"
  },
  {
   "type": "trend",
   "metric": "kw",
   "title": "Công suất cả trạm"
  }
 ],
 "tabs": [
  {
   "id": "sessions",
   "label": "Phiên sạc",
   "title": "Phiên sạc & doanh thu",
   "icon": "chart",
   "blocks": [
    {
     "type": "kpis",
     "items": [
      "sessions",
      "kwh",
      "rev"
     ]
    },
    {
     "type": "bars",
     "items": [
      "soc"
     ]
    },
    {
     "type": "trend",
     "metric": "kwh",
     "title": "Điện năng đã sạc"
    }
   ]
  }
 ],
 "demo": {
  "devices": {
   "c1": {
    "title": "Trụ AC-01",
    "dec": {
     "kw": 1
    },
    "f": {
     "state": {
      "sq": [
       0,
       1
      ],
      "p": 240,
      "duty": 0.7
     },
     "kw": [
      6.8,
      0.4,
      50,
      0
     ],
     "kwh_today": {
      "cnt": 0.02,
      "start": 38
     },
     "soc": [
      58,
      25,
      300,
      0
     ],
     "sessions": 9,
     "rev_k": {
      "cnt": 0.05,
      "start": 120
     },
     "temp": [
      34,
      3,
      90,
      0
     ]
    }
   },
   "c2": {
    "title": "Trụ DC-02",
    "dec": {
     "kw": 1
    },
    "f": {
     "state": 1,
     "kw": [
      62,
      8,
      70,
      10
     ],
     "kwh_today": {
      "cnt": 0.2,
      "start": 210
     },
     "soc": [
      68,
      22,
      260,
      0
     ],
     "sessions": 14,
     "rev_k": {
      "cnt": 0.5,
      "start": 790
     },
     "temp": [
      52,
      6,
      90,
      0
     ]
    }
   },
   "c3": {
    "title": "Trụ DC-03",
    "dec": {
     "kw": 1
    },
    "f": {
     "state": {
      "sq": [
       3,
       0
      ],
      "p": 200,
      "duty": 0.5
     },
     "kw": 0,
     "kwh_today": {
      "cnt": 0.0,
      "start": 164
     },
     "soc": 0,
     "sessions": 11,
     "rev_k": 590,
     "temp": [
      30,
      2,
      100,
      0
     ]
    }
   },
   "c4": {
    "title": "Trụ AC-04",
    "dec": {
     "kw": 1
    },
    "f": {
     "state": {
      "sq": [
       2,
       1
      ],
      "p": 280,
      "duty": 0.9
     },
     "kw": [
      7,
      0.3,
      50,
      0
     ],
     "kwh_today": {
      "cnt": 0.02,
      "start": 52
     },
     "soc": [
      40,
      15,
      200,
      0
     ],
     "sessions": 7,
     "rev_k": {
      "cnt": 0.04,
      "start": 160
     },
     "temp": [
      36,
      3,
      90,
      0
     ]
    }
   }
  }
 },
 "id": "ev",
 "required": [
  "state",
  "kw"
 ],
 "why": "Trạng thái trụ (rảnh/đang sạc/lỗi) và công suất để tính phiên sạc."
};
