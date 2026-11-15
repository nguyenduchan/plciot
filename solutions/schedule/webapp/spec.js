/* Cấu hình giao diện ngành (sinh bởi tools/solution-kit/gen.py từ specs.py) */
window.INDUSTRY = {
 "title": "Lịch vận hành thiết bị",
 "icon": "calendar",
 "style": "soft",
 "metrics": [
  {
   "id": "z1",
   "label": "Tưới vùng 1",
   "keys": [
    "zone1"
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
   "id": "z2",
   "label": "Tưới vùng 2",
   "keys": [
    "zone2"
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
   "id": "lamp",
   "label": "Đèn sân",
   "keys": [
    "lamp"
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
   "id": "pond",
   "label": "Bơm hồ",
   "keys": [
    "pond"
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
   "id": "water",
   "label": "Nước hôm nay",
   "unit": "L",
   "keys": [
    "water_l"
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
   "agg": "sum",
   "dec": 1
  },
  {
   "id": "kwh",
   "label": "Điện hôm nay",
   "unit": "kWh",
   "keys": [
    "kwh"
   ],
   "agg": "sum",
   "dec": 1
  }
 ],
 "overview": [
  {
   "type": "schedule",
   "title": "Lịch trong tuần (theo cài đặt)",
   "rows": [
    {
     "label": "Tưới vùng 1",
     "on": "05:30",
     "off": "06:15"
    },
    {
     "label": "Tưới vùng 2",
     "on": "17:00",
     "off": "17:45",
     "days": [
      1,
      3,
      5
     ]
    },
    {
     "label": "Đèn sân",
     "on": "18:00",
     "off": "23:00"
    },
    {
     "label": "Bơm hồ cá",
     "on": "08:00",
     "off": "10:00",
     "days": [
      6,
      7
     ]
    }
   ]
  },
  {
   "type": "state",
   "title": "Trạng thái thực tế từ thiết bị",
   "items": [
    "z1",
    "z2",
    "lamp",
    "pond"
   ]
  },
  {
   "type": "kpis",
   "items": [
    "water",
    "kwh",
    "kw"
   ]
  }
 ],
 "tabs": [
  {
   "id": "usage",
   "label": "Tiêu thụ",
   "title": "Nước & điện",
   "icon": "chart",
   "blocks": [
    {
     "type": "kpis",
     "items": [
      "water",
      "kwh"
     ]
    },
    {
     "type": "trend",
     "metric": "kw",
     "title": "Công suất"
    }
   ]
  }
 ],
 "demo": {
  "devices": {
   "s1": {
    "title": "Bộ điều khiển sân vườn",
    "f": {
     "zone1": {
      "sq": [
       0,
       1
      ],
      "p": 200,
      "duty": 0.4
     },
     "zone2": {
      "sq": [
       0,
       1
      ],
      "p": 260,
      "duty": 0.3,
      "ph": 60
     },
     "lamp": {
      "sq": [
       0,
       1
      ],
      "p": 300,
      "duty": 0.6
     },
     "pond": {
      "sq": [
       0,
       1
      ],
      "p": 150,
      "duty": 0.5
     },
     "water_l": {
      "cnt": 0.8,
      "start": 240
     },
     "kw": [
      1.8,
      0.6,
      120,
      0
     ],
     "kwh": {
      "cnt": 0.001,
      "start": 6.2
     }
    },
    "dec": {}
   }
  }
 },
 "id": "schedule",
 "required": [
  "z1",
  "lamp"
 ],
 "why": "Cần trạng thái thực tế của các kênh để đối chiếu với lịch cài đặt."
};
