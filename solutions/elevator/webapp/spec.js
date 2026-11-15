/* Cấu hình giao diện ngành (sinh bởi tools/solution-kit/gen.py từ specs.py) */
window.INDUSTRY = {
 "title": "Thang máy & tòa nhà",
 "icon": "elevator",
 "style": "dense",
 "metrics": [
  {
   "id": "floor",
   "label": "Tầng",
   "keys": [
    "floor"
   ],
   "agg": "avg",
   "dec": 0
  },
  {
   "id": "door",
   "label": "Cửa",
   "keys": [
    "door"
   ],
   "agg": "max",
   "map": {
    "0": "Đóng",
    "1": "Mở"
   },
   "lv": {
    "0": "ok",
    "1": "warn"
   }
  },
  {
   "id": "load",
   "label": "Tải",
   "unit": "%",
   "keys": [
    "load"
   ],
   "agg": "avg",
   "dec": 0,
   "min": 0,
   "max": 100,
   "th": {
    "hi": 85,
    "hiHi": 100
   }
  },
  {
   "id": "trips",
   "label": "Chuyến hôm nay",
   "keys": [
    "trips"
   ],
   "agg": "sum",
   "dec": 0
  },
  {
   "id": "fault",
   "label": "Sự cố",
   "keys": [
    "fault"
   ],
   "map": {
    "0": "Không",
    "1": "Lỗi"
   },
   "lv": {
    "0": "ok",
    "1": "bad"
   },
   "agg": "max"
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
  }
 ],
 "overview": [
  {
   "type": "elevator",
   "floors": 12,
   "floor": "floor",
   "door": "door",
   "load": "load",
   "fault": "fault"
  },
  {
   "type": "kpis",
   "items": [
    "trips",
    "load",
    "kw",
    "fault"
   ]
  },
  {
   "type": "alarms"
  }
 ],
 "tabs": [
  {
   "id": "usage",
   "label": "Vận hành",
   "title": "Vận hành thang máy",
   "icon": "chart",
   "blocks": [
    {
     "type": "tiles",
     "main": "trips",
     "subs": [
      "load",
      "kw",
      "door"
     ]
    },
    {
     "type": "trend",
     "metric": "load",
     "title": "Tải trung bình"
    }
   ]
  }
 ],
 "demo": {
  "devices": {
   "l1": {
    "title": "Thang 1",
    "dec": {
     "floor": 2,
     "load": 0,
     "kw": 1
    },
    "f": {
     "floor": {
      "sin": [
       6.5,
       5.5,
       70
      ]
     },
     "door": {
      "sq": [
       0,
       1
      ],
      "p": 35,
      "duty": 0.88,
      "ph": 5
     },
     "load": [
      42,
      30,
      110,
      0
     ],
     "trips": {
      "cnt": 0.02,
      "start": 310
     },
     "fault": 0,
     "kw": [
      3.4,
      1.2,
      40,
      0
     ]
    }
   },
   "l2": {
    "title": "Thang 2",
    "dec": {
     "floor": 2,
     "load": 0,
     "kw": 1
    },
    "f": {
     "floor": {
      "sin": [
       6.5,
       5.5,
       95,
       30
      ]
     },
     "door": {
      "sq": [
       0,
       1
      ],
      "p": 47,
      "duty": 0.85
     },
     "load": [
      35,
      25,
      130,
      0
     ],
     "trips": {
      "cnt": 0.015,
      "start": 270
     },
     "fault": 0,
     "kw": [
      3,
      1.1,
      50,
      0
     ]
    }
   },
   "l3": {
    "title": "Thang chở hàng",
    "dec": {
     "floor": 2,
     "load": 0,
     "kw": 1
    },
    "f": {
     "floor": {
      "sin": [
       4,
       3,
       120,
       10
      ]
     },
     "door": {
      "sq": [
       0,
       1
      ],
      "p": 60,
      "duty": 0.9
     },
     "load": [
      60,
      28,
      150,
      0
     ],
     "trips": {
      "cnt": 0.008,
      "start": 96
     },
     "fault": {
      "sq": [
       1,
       0
      ],
      "p": 500,
      "duty": 0.97
     },
     "kw": [
      5,
      1.5,
      60,
      0
     ]
    }
   }
  }
 },
 "id": "elevator",
 "required": [
  "floor",
  "door"
 ],
 "why": "Cần số tầng hiện tại (số, 1…12) và trạng thái cửa để vẽ cabin; nên khai load, fault."
};
