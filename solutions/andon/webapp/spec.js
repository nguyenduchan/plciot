/* Cấu hình giao diện ngành (sinh bởi tools/solution-kit/gen.py từ specs.py) */
window.INDUSTRY = {
 "title": "Bảng Andon sản xuất",
 "icon": "andon",
 "style": "sharp",
 "metrics": [
  {
   "id": "state",
   "label": "Trạng thái",
   "keys": [
    "state"
   ],
   "agg": "max",
   "map": {
    "0": "DỪNG",
    "1": "ĐANG CHẠY",
    "2": "LỖI",
    "3": "CHỜ"
   },
   "lv": {
    "0": "off",
    "1": "ok",
    "2": "bad",
    "3": "warn"
   }
  },
  {
   "id": "count",
   "label": "Sản lượng",
   "unit": "sp",
   "keys": [
    "count"
   ],
   "agg": "sum",
   "dec": 0
  },
  {
   "id": "plan",
   "label": "Kế hoạch",
   "unit": "sp",
   "keys": [
    "plan"
   ],
   "agg": "sum",
   "dec": 0
  },
  {
   "id": "good",
   "label": "Đạt",
   "unit": "sp",
   "keys": [
    "good"
   ],
   "agg": "sum",
   "dec": 0
  },
  {
   "id": "takt",
   "label": "Takt time",
   "unit": "s",
   "keys": [
    "takt"
   ],
   "agg": "avg",
   "dec": 0
  },
  {
   "id": "attain",
   "label": "Đạt kế hoạch",
   "unit": "%",
   "expr": "count / plan * 100",
   "dec": 0,
   "th": {
    "lo": 60,
    "loLo": 40
   }
  },
  {
   "id": "down",
   "label": "Dừng lâu nhất",
   "unit": "phút",
   "keys": [
    "down_min"
   ],
   "agg": "max",
   "dec": 0,
   "th": {
    "hi": 30,
    "hiHi": 60
   }
  }
 ],
 "overview": [
  {
   "type": "andon",
   "state": "state",
   "value": "count"
  },
  {
   "type": "progress",
   "title": "Kế hoạch ca",
   "items": [
    {
     "actual": "count",
     "target": "plan",
     "label": "Sản lượng toàn xưởng"
    },
    {
     "actual": "good",
     "target": "count",
     "label": "Tỷ lệ đạt"
    }
   ]
  },
  {
   "type": "kpis",
   "items": [
    "count",
    "good",
    "attain",
    "down"
   ]
  },
  {
   "type": "alarms"
  }
 ],
 "tabs": [
  {
   "id": "lines",
   "label": "Chuyền",
   "title": "Từng chuyền",
   "icon": "factory",
   "blocks": [
    {
     "type": "tiles",
     "main": "count",
     "subs": [
      "takt",
      "down",
      "state"
     ]
    },
    {
     "type": "trend",
     "metric": "count",
     "title": "Sản lượng"
    }
   ]
  }
 ],
 "demo": {
  "devices": {
   "L1": {
    "title": "Chuyền 1",
    "dec": {},
    "f": {
     "state": 1,
     "count": {
      "cnt": 0.4,
      "start": 612
     },
     "plan": 900,
     "good": {
      "cnt": 0.39,
      "start": 600
     },
     "takt": [
      32,
      2,
      90,
      0
     ],
     "down_min": 8
    }
   },
   "L2": {
    "title": "Chuyền 2",
    "dec": {},
    "f": {
     "state": {
      "sq": [
       3,
       1
      ],
      "p": 280,
      "duty": 0.8
     },
     "count": {
      "cnt": 0.35,
      "start": 540
     },
     "plan": 900,
     "good": {
      "cnt": 0.34,
      "start": 520
     },
     "takt": [
      36,
      3,
      100,
      0
     ],
     "down_min": 22
    }
   },
   "L3": {
    "title": "Chuyền 3",
    "dec": {},
    "f": {
     "state": {
      "sq": [
       2,
       1
      ],
      "p": 320,
      "duty": 0.88
     },
     "count": {
      "cnt": 0.3,
      "start": 470
     },
     "plan": 800,
     "good": {
      "cnt": 0.285,
      "start": 440
     },
     "takt": [
      40,
      3,
      110,
      0
     ],
     "down_min": 36
    }
   },
   "L4": {
    "title": "Chuyền 4",
    "dec": {},
    "f": {
     "state": 1,
     "count": {
      "cnt": 0.42,
      "start": 690
     },
     "plan": 900,
     "good": {
      "cnt": 0.41,
      "start": 680
     },
     "takt": [
      30,
      2,
      80,
      0
     ],
     "down_min": 5
    }
   },
   "L5": {
    "title": "Đóng gói",
    "dec": {},
    "f": {
     "state": {
      "sq": [
       0,
       1
      ],
      "p": 400,
      "duty": 0.9
     },
     "count": {
      "cnt": 0.8,
      "start": 1220
     },
     "plan": 1800,
     "good": {
      "cnt": 0.79,
      "start": 1200
     },
     "takt": [
      18,
      1,
      80,
      0
     ],
     "down_min": 12
    }
   },
   "L6": {
    "title": "Kiểm tra",
    "dec": {},
    "f": {
     "state": 1,
     "count": {
      "cnt": 0.78,
      "start": 1190
     },
     "plan": 1800,
     "good": {
      "cnt": 0.74,
      "start": 1130
     },
     "takt": [
      19,
      1,
      80,
      0
     ],
     "down_min": 9
    }
   }
  }
 },
 "id": "andon",
 "required": [
  "state",
  "count",
  "plan"
 ],
 "why": "Bảng Andon cần trạng thái từng chuyền, sản lượng và kế hoạch ca."
};
