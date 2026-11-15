/* Cấu hình giao diện ngành (sinh bởi tools/solution-kit/gen.py từ specs.py) */
window.INDUSTRY = {
 "title": "Giám sát điện năng 3 pha",
 "icon": "bolt",
 "style": "dense",
 "metrics": [
  {
   "id": "v1",
   "label": "Điện áp L1",
   "unit": "V",
   "keys": [
    "v_l1",
    "v1",
    "ua"
   ],
   "agg": "avg",
   "dec": 0,
   "min": 180,
   "max": 260,
   "th": {
    "lo": 207,
    "loLo": 198,
    "hi": 245,
    "hiHi": 253
   }
  },
  {
   "id": "v2",
   "label": "Điện áp L2",
   "unit": "V",
   "keys": [
    "v_l2",
    "v2",
    "ub"
   ],
   "agg": "avg",
   "dec": 0,
   "min": 180,
   "max": 260,
   "th": {
    "lo": 207,
    "loLo": 198,
    "hi": 245,
    "hiHi": 253
   }
  },
  {
   "id": "v3",
   "label": "Điện áp L3",
   "unit": "V",
   "keys": [
    "v_l3",
    "v3",
    "uc"
   ],
   "agg": "avg",
   "dec": 0,
   "min": 180,
   "max": 260,
   "th": {
    "lo": 207,
    "loLo": 198,
    "hi": 245,
    "hiHi": 253
   }
  },
  {
   "id": "i1",
   "label": "Dòng L1",
   "unit": "A",
   "keys": [
    "i_l1",
    "i1",
    "ia"
   ],
   "agg": "sum",
   "dec": 1,
   "min": 0,
   "max": 100,
   "th": {
    "hi": 80,
    "hiHi": 95
   }
  },
  {
   "id": "i2",
   "label": "Dòng L2",
   "unit": "A",
   "keys": [
    "i_l2",
    "i2",
    "ib"
   ],
   "agg": "sum",
   "dec": 1,
   "min": 0,
   "max": 100,
   "th": {
    "hi": 80,
    "hiHi": 95
   }
  },
  {
   "id": "i3",
   "label": "Dòng L3",
   "unit": "A",
   "keys": [
    "i_l3",
    "i3",
    "ic"
   ],
   "agg": "sum",
   "dec": 1,
   "min": 0,
   "max": 100,
   "th": {
    "hi": 80,
    "hiHi": 95
   }
  },
  {
   "id": "kw",
   "label": "Công suất P",
   "unit": "kW",
   "keys": [
    "kw",
    "p_kw"
   ],
   "agg": "sum",
   "dec": 1
  },
  {
   "id": "kvar",
   "label": "Phản kháng Q",
   "unit": "kVAr",
   "keys": [
    "kvar",
    "q_kvar"
   ],
   "agg": "sum",
   "dec": 1
  },
  {
   "id": "kva",
   "label": "Biểu kiến S",
   "unit": "kVA",
   "expr": "sqrt(kw*kw + kvar*kvar)",
   "dec": 1
  },
  {
   "id": "pf",
   "label": "Hệ số công suất",
   "keys": [
    "pf",
    "cosphi"
   ],
   "agg": "avg",
   "dec": 2,
   "min": 0,
   "max": 1,
   "th": {
    "lo": 0.85,
    "loLo": 0.7
   }
  },
  {
   "id": "hz",
   "label": "Tần số",
   "unit": "Hz",
   "keys": [
    "hz",
    "freq"
   ],
   "agg": "avg",
   "dec": 2,
   "min": 49,
   "max": 51,
   "th": {
    "lo": 49.5,
    "loLo": 49.2,
    "hi": 50.5,
    "hiHi": 50.8
   }
  },
  {
   "id": "kwh",
   "label": "Điện năng",
   "unit": "kWh",
   "keys": [
    "kwh",
    "e_total"
   ],
   "agg": "sum",
   "dec": 0
  }
 ],
 "overview": [
  {
   "type": "kpis",
   "items": [
    "kw",
    "kvar",
    "kva",
    "pf"
   ]
  },
  {
   "type": "bars",
   "title": "Điện áp pha",
   "items": [
    "v1",
    "v2",
    "v3"
   ]
  },
  {
   "type": "bars",
   "title": "Dòng điện pha",
   "items": [
    "i1",
    "i2",
    "i3"
   ]
  },
  {
   "type": "gauges",
   "items": [
    "pf",
    "hz"
   ]
  },
  {
   "type": "trend",
   "metric": "kw",
   "title": "Công suất P"
  }
 ],
 "tabs": [
  {
   "id": "quality",
   "label": "Chất lượng",
   "title": "Chất lượng điện",
   "icon": "chart",
   "blocks": [
    {
     "type": "gauges",
     "items": [
      "hz",
      "pf"
     ]
    },
    {
     "type": "trend",
     "metric": "pf",
     "title": "Hệ số công suất"
    },
    {
     "type": "trend",
     "metric": "v1",
     "title": "Điện áp L1"
    },
    {
     "type": "alarms"
    }
   ]
  },
  {
   "id": "meters",
   "label": "Công tơ",
   "title": "Các công tơ",
   "icon": "gear",
   "blocks": [
    {
     "type": "tiles",
     "main": "kw",
     "subs": [
      "pf",
      "i1",
      "kwh"
     ]
    }
   ]
  }
 ],
 "demo": {
  "devices": {
   "m1": {
    "title": "Tủ điện tổng",
    "dec": {
     "v_l1": 1,
     "v_l2": 1,
     "v_l3": 1,
     "i_l1": 1,
     "i_l2": 1,
     "i_l3": 1,
     "kw": 1,
     "kvar": 1,
     "pf": 2,
     "hz": 2,
     "kwh": 0
    },
    "f": {
     "v_l1": [
      230,
      3,
      70,
      0
     ],
     "v_l2": [
      228,
      3,
      80,
      10
     ],
     "v_l3": [
      231,
      4,
      90,
      20
     ],
     "i_l1": [
      52,
      8,
      60,
      0
     ],
     "i_l2": [
      48,
      9,
      70,
      5
     ],
     "i_l3": [
      55,
      10,
      65,
      9
     ],
     "kw": [
      33,
      5,
      60,
      0
     ],
     "kvar": [
      11,
      2,
      70,
      0
     ],
     "pf": [
      0.94,
      0.02,
      100,
      0
     ],
     "hz": [
      50,
      0.08,
      40,
      0
     ],
     "kwh": {
      "cnt": 0.009,
      "start": 128400
     }
    }
   },
   "m2": {
    "title": "Tủ máy sản xuất",
    "dec": {
     "v_l1": 1,
     "v_l2": 1,
     "v_l3": 1,
     "i_l1": 1,
     "i_l2": 1,
     "i_l3": 1,
     "kw": 1,
     "kvar": 1,
     "pf": 2,
     "hz": 2,
     "kwh": 0
    },
    "f": {
     "v_l1": [
      229,
      3,
      75,
      0
     ],
     "v_l2": [
      227,
      3,
      85,
      0
     ],
     "v_l3": [
      230,
      3,
      95,
      0
     ],
     "i_l1": [
      30,
      6,
      55,
      0
     ],
     "i_l2": [
      28,
      6,
      65,
      0
     ],
     "i_l3": [
      33,
      7,
      60,
      0
     ],
     "kw": [
      19,
      4,
      60,
      0
     ],
     "kvar": [
      9,
      2,
      70,
      0
     ],
     "pf": [
      0.9,
      0.03,
      90,
      0
     ],
     "hz": [
      50,
      0.07,
      45,
      0
     ],
     "kwh": {
      "cnt": 0.005,
      "start": 70100
     }
    }
   }
  }
 },
 "id": "energy",
 "required": [
  "kw",
  "pf",
  "v1",
  "i1"
 ],
 "why": "Công suất, hệ số công suất, điện áp và dòng pha là tối thiểu để đánh giá chất lượng điện."
};
