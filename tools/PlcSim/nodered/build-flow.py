"""Ghép modbus-test.js + opcua-test.js thành flows.json cho Node-RED (chạy: python build-flow.py)."""
import json, os
d = os.path.dirname(os.path.abspath(__file__))
rd = lambda n: open(os.path.join(d, n), encoding='utf-8').read()
T = 'plcsim-test'
def fn(id, name, js, wires, y):
    return {"id": id, "type": "function", "z": T, "name": name, "func": js, "outputs": 1, "timeout": 0, "noerr": 0,
            "initialize": "", "finalize": "", "libs": [], "x": 420, "y": y, "wires": [wires]}
flows = [
    {"id": T, "type": "tab", "label": "PlcSim test", "disabled": False, "info": "Kiểm tra PlcSim qua Modbus TCP và OPC UA. Kết quả ghi vào /data/result.ndjson."},
    {"id": "inj", "type": "inject", "z": T, "name": "▶ Chạy bộ test (tự chạy sau 6 giây khi khởi động)", "props": [{"p": "payload"}],
     "repeat": "", "crontab": "", "once": True, "onceDelay": "6", "topic": "", "payload": "", "payloadType": "date", "x": 190, "y": 100, "wires": [["modbus"]]},
    fn("modbus", "Test Modbus TCP", rd('modbus-test.js'), ["dbg1", "json1", "opcua"], 100),
    fn("opcua", "Test OPC UA + chéo Modbus", rd('opcua-test.js'), ["dbg2", "json2"], 200),
    {"id": "json1", "type": "json", "z": T, "name": "", "property": "payload", "action": "str", "pretty": False, "x": 650, "y": 60, "wires": [["file"]]},
    {"id": "json2", "type": "json", "z": T, "name": "", "property": "payload", "action": "str", "pretty": False, "x": 650, "y": 240, "wires": [["file"]]},
    {"id": "file", "type": "file", "z": T, "name": "result.ndjson", "filename": "/data/result.ndjson", "filenameType": "str", "appendNewline": True,
     "createDir": False, "overwriteFile": "false", "encoding": "none", "x": 840, "y": 150, "wires": [[]]},
    {"id": "dbg1", "type": "debug", "z": T, "name": "Modbus", "active": True, "tosidebar": True, "complete": "payload", "x": 650, "y": 120, "wires": []},
    {"id": "dbg2", "type": "debug", "z": T, "name": "OPC UA", "active": True, "tosidebar": True, "complete": "payload", "x": 650, "y": 200, "wires": []},
]
json.dump(flows, open(os.path.join(d, 'flows.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('flows.json:', len(flows), 'nodes')
