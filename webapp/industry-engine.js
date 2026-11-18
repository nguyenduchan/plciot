/* Bộ tính công thức cho chỉ số suy diễn (derived metric): tính NGAY trên webapp / gateway từ số cảm biến đã nhận, không gửi qua server.
 * Không dùng eval. Cú pháp (giống hệt bản C# tools/GatewayApp/Ui/Expr.cs; vector test chung: expr-vectors.json):
 *   số, tên (chỉ số hoặc field), "thiết_bị.field", + - * / %, so sánh < <= > >= == !=, && || !, ngoặc, hàm:
 *   min max abs round(x[,n]) floor ceil sqrt pow avg sum clamp(x,lo,hi) if(đk,a,b) coalesce(a,b,..) isnull(x) null
 * Có tham chiếu chưa có số (null) → kết quả null (trừ coalesce/isnull/if chọn nhánh không dùng nó). Chia cho 0 → null. */
const IndExpr = (() => {
  const FN = {
    min: (a) => Math.min(...a), max: (a) => Math.max(...a), abs: (a) => Math.abs(a[0]), floor: (a) => Math.floor(a[0]), ceil: (a) => Math.ceil(a[0]), sqrt: (a) => (a[0] < 0 ? null : Math.sqrt(a[0])),
    round: (a) => { const k = 10 ** (a[1] ?? 0); return Math.round(a[0] * k) / k; }, pow: (a) => Math.pow(a[0], a[1]),
    avg: (a) => a.reduce((x, y) => x + y, 0) / a.length, sum: (a) => a.reduce((x, y) => x + y, 0),
    clamp: (a) => Math.min(Math.max(a[0], a[1]), a[2]),
  };
  function tokenize(src) {
    const t = []; let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      if (num) { t.push({ k: 'n', v: parseFloat(num[0]) }); i += num[0].length; continue; }
      const id = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?/.exec(src.slice(i));
      if (id) { t.push({ k: 'i', v: id[0] }); i += id[0].length; continue; }
      const op = /^(<=|>=|==|!=|&&|\|\||[-+*\/%<>!(),])/.exec(src.slice(i));
      if (op) { t.push({ k: 'o', v: op[0] }); i += op[0].length; continue; }
      throw new Error('ký tự lạ: ' + c);
    }
    return t;
  }
  // AST: {t:'n',v} {t:'v',name} {t:'u',op,a} {t:'b',op,a,b} {t:'f',name,args}
  function parse(src) {
    const tk = tokenize(src); let p = 0;
    const peek = () => tk[p], isOp = (v) => tk[p] && tk[p].k === 'o' && tk[p].v === v;
    const eat = (v) => { if (!isOp(v)) throw new Error('thiếu ' + v); p++; };
    const bin = (next, ops) => () => { let a = next(); while (tk[p] && tk[p].k === 'o' && ops.includes(tk[p].v)) { const op = tk[p++].v; a = { t: 'b', op, a, b: next() }; } return a; };
    function primary() {
      const x = tk[p++];
      if (!x) throw new Error('thiếu toán hạng');
      if (x.k === 'n') return { t: 'n', v: x.v };
      if (x.k === 'o' && x.v === '(') { const e = or(); eat(')'); return e; }
      if (x.k === 'i') {
        if (isOp('(')) { p++; const args = []; if (!isOp(')')) { do { args.push(or()); } while (isOp(',') && ++p); } eat(')'); return { t: 'f', name: x.v.toLowerCase(), args }; }
        return x.v.toLowerCase() === 'null' ? { t: 'z' } : { t: 'v', name: x.v };
      }
      throw new Error('không hiểu: ' + x.v);
    }
    function unary() { if (isOp('-') || isOp('!')) { const op = tk[p++].v; return { t: 'u', op, a: unary() }; } return primary(); }
    const mul = bin(unary, ['*', '/', '%']), add = bin(mul, ['+', '-']), cmp = bin(add, ['<', '<=', '>', '>=']), eq = bin(cmp, ['==', '!=']), and = bin(eq, ['&&']);
    const or = bin(and, ['||']);
    const ast = or();
    if (p < tk.length) throw new Error('thừa: ' + tk[p].v);
    return ast;
  }
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  function run(n, get) {
    switch (n.t) {
      case 'n': return n.v;
      case 'z': return null;
      case 'v': { const v = get(n.name); return v === undefined ? null : v; }
      case 'u': { const a = run(n.a, get); if (a === null) return null; return n.op === '-' ? -a : (a ? 0 : 1); }
      case 'b': {
        if (n.op === '&&' || n.op === '||') {   // lỏng với null: null coi như sai
          const a = run(n.a, get), b = run(n.b, get);
          return n.op === '&&' ? (a && b ? 1 : 0) : (a || b ? 1 : 0);
        }
        const a = run(n.a, get), b = run(n.b, get);
        if (n.op === '==' || n.op === '!=') { const eq = a === b; return n.op === '==' ? (eq ? 1 : 0) : (eq ? 0 : 1); }
        if (a === null || b === null) return null;
        switch (n.op) {
          case '+': return a + b; case '-': return a - b; case '*': return a * b;
          case '/': return b === 0 ? null : a / b; case '%': return b === 0 ? null : a % b;
          case '<': return a < b ? 1 : 0; case '<=': return a <= b ? 1 : 0; case '>': return a > b ? 1 : 0; case '>=': return a >= b ? 1 : 0;
        }
        return null;
      }
      case 'f': {
        if (n.name === 'if') { const c = run(n.args[0], get); return c ? run(n.args[1], get) : (n.args[2] ? run(n.args[2], get) : null); }
        if (n.name === 'coalesce') { for (const a of n.args) { const v = run(a, get); if (v !== null) return v; } return null; }
        if (n.name === 'isnull') return run(n.args[0], get) === null ? 1 : 0;
        const f = FN[n.name]; if (!f) throw new Error('hàm lạ: ' + n.name);
        const a = n.args.map((x) => run(x, get));
        if (!a.length || a.some((x) => x === null)) return null;
        return num(f(a));
      }
    }
    return null;
  }
  const cache = new Map();
  return {
    /** Tính công thức; get(tên) trả số hoặc null/undefined. Công thức lỗi → null (không làm hỏng giao diện). */
    eval(src, get) {
      try { let ast = cache.get(src); if (!ast) { ast = parse(src); cache.set(src, ast); } return num(run(ast, get)); } catch { return null; }
    },
    /** Kiểm cú pháp: trả null nếu đúng, ngược lại thông báo lỗi. */
    check(src) { try { parse(src); return null; } catch (e) { return e.message; } },
    names(src) { const out = new Set(); (function w(n) { if (!n) return; if (n.t === 'v') out.add(n.name); ['a', 'b'].forEach((k) => w(n[k])); (n.args || []).forEach(w); })(parse(src)); return [...out]; },
  };
})();
if (typeof module !== 'undefined') module.exports = IndExpr;

/* Bộ icon ĐẠI LƯỢNG ĐO dùng chung webapp + gateway C# (sinh bởi tools/solution-kit/gen.py từ icons.json — đừng sửa tay).
 * PlcQIcons.svg(id) → <svg> nét 24×24, màu theo currentColor; PlcQIcons.forMetric({id,label,unit,keys,map}) → mã icon;
 * PlcQIcons.forField(key, unit, label, kind) cho widget thường. Luật giống hệt bản C# (tools/GatewayApp/Ui/IconData.g.cs). */
(function () {
  if (window.PlcQIcons) return;
  const Q = {"temp":"<path d=\"M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z\"/><path d=\"M12 9.5v7\"/><circle cx=\"12\" cy=\"17.6\" r=\"1.7\" fill=\"currentColor\" stroke=\"none\"/><path d=\"M17 5.5h2.5M17 9h1.5M17 12.5h2.5\"/>","humidity":"<path d=\"M12 3s6 6.4 6 11a6 6 0 0 1-12 0c0-4.6 6-11 6-11z\"/><path d=\"M9.6 16.6l4.8-4.8\"/><circle cx=\"10\" cy=\"12.4\" r=\"1\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"14\" cy=\"16.2\" r=\"1\" fill=\"currentColor\" stroke=\"none\"/>","level":"<rect x=\"4\" y=\"4\" width=\"12\" height=\"16\" rx=\"2\"/><path d=\"M4 12.5c2-1.3 4-1.3 6 0s4 1.3 6 0V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z\" fill=\"currentColor\" fill-opacity=\".3\" stroke=\"none\"/><path d=\"M4 12.5c2-1.3 4-1.3 6 0s4 1.3 6 0\"/><path d=\"M20 6.5v11M18.4 8.1L20 6.5l1.6 1.6M18.4 15.9L20 17.5l1.6-1.6\"/>","flow":"<path d=\"M2.5 7.5h19M2.5 16.5h19\"/><path d=\"M6 12h10.5M13.5 9l3 3-3 3\"/>","pressure":"<circle cx=\"12\" cy=\"13.5\" r=\"7.5\"/><path d=\"M12 13.5l3.6-3.6\"/><circle cx=\"12\" cy=\"13.5\" r=\"1.5\" fill=\"currentColor\" stroke=\"none\"/><path d=\"M9.5 3h5M12 3v3\"/><path d=\"M7.4 17h1.4M15.2 17h1.4\"/>","voltage":"<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M8.3 8l3.7 8.5L15.7 8\"/>","current":"<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M8.4 16.5L12 7.5l3.6 9M9.7 13.3h4.6\"/>","power":"<path d=\"M13 2.5L4.5 13.5H11L10 21.5l8.5-11H12z\" fill=\"currentColor\" fill-opacity=\".18\"/>","energy":"<rect x=\"4\" y=\"3\" width=\"16\" height=\"18\" rx=\"2.5\"/><rect x=\"7.5\" y=\"6.5\" width=\"9\" height=\"4\" rx=\"1\"/><path d=\"M12.8 12.8l-2.4 3.4h3.2l-2.4 3.3\"/>","freq":"<path d=\"M2 12c1.8-6 4.2-6 6 0s4.2 6 6 0 4.2-6 6 0\"/><path d=\"M2 20.5h20\" stroke-opacity=\".4\"/>","speed":"<path d=\"M4.2 17.5a9 9 0 1 1 15.6 0\"/><path d=\"M12 14.5l4.6-5\"/><circle cx=\"12\" cy=\"14.5\" r=\"1.6\" fill=\"currentColor\" stroke=\"none\"/><path d=\"M6.3 13.5h1.5M16.2 13.5h1.5M12 6.5V8\"/>","clock":"<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 7v5l3.5 2.2\"/>","count":"<path d=\"M9.5 4L7.5 20M16.5 4l-2 16M4.5 9h16M3.5 15h16\"/>","box":"<path d=\"M12 2.8l8.2 4.6v9.2L12 21.2l-8.2-4.6V7.4z\"/><path d=\"M3.8 7.4L12 12l8.2-4.6M12 12v9.2\"/><path d=\"M7.9 5.1l8.2 4.6\" stroke-opacity=\".5\"/>","weight":"<path d=\"M6.3 8.5h11.4l2.6 11.5H3.7z\"/><circle cx=\"12\" cy=\"5.5\" r=\"2.5\"/>","ph":"<path d=\"M9 3h6M10 3v6.2L4.7 18.4A1.8 1.8 0 0 0 6.3 21h11.4a1.8 1.8 0 0 0 1.6-2.6L14 9.2V3\"/><path d=\"M6.6 15h10.8\"/><path d=\"M6.6 15L4.7 18.4A1.8 1.8 0 0 0 6.3 21h11.4a1.8 1.8 0 0 0 1.6-2.6L17.4 15z\" fill=\"currentColor\" fill-opacity=\".25\" stroke=\"none\"/>","chem":"<path d=\"M9 3h6M10 3v6.2L4.7 18.4A1.8 1.8 0 0 0 6.3 21h11.4a1.8 1.8 0 0 0 1.6-2.6L14 9.2V3\"/><circle cx=\"10\" cy=\"16.5\" r=\"1.3\"/><circle cx=\"14\" cy=\"14\" r=\"1\"/><circle cx=\"14.3\" cy=\"18\" r=\".8\"/>","turbidity":"<path d=\"M12 3s6 6.4 6 11a6 6 0 0 1-12 0c0-4.6 6-11 6-11z\"/><circle cx=\"10\" cy=\"13.6\" r=\"1\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"13.8\" cy=\"15.8\" r=\"1\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"13\" cy=\"11.4\" r=\".9\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"10.6\" cy=\"17.6\" r=\".8\" fill=\"currentColor\" stroke=\"none\"/>","oxygen":"<circle cx=\"9\" cy=\"15\" r=\"4.8\"/><circle cx=\"16.8\" cy=\"8.4\" r=\"3.1\"/><circle cx=\"17.8\" cy=\"16.8\" r=\"1.7\"/><circle cx=\"9.6\" cy=\"5.4\" r=\"1.5\"/><path d=\"M7 13.5a2.4 2.4 0 0 1 2-1.5\" stroke-opacity=\".6\"/>","drop":"<path d=\"M12 3s6 6.4 6 11a6 6 0 0 1-12 0c0-4.6 6-11 6-11z\"/><path d=\"M9 14.5a3 3 0 0 0 3 3\"/>","gas":"<path d=\"M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 9.5a4.2 4.2 0 0 1-.4 8.5z\"/><circle cx=\"9.6\" cy=\"13.6\" r=\"1.4\"/><circle cx=\"14.6\" cy=\"13.6\" r=\"1.4\"/><path d=\"M11 13.6h2.2\"/>","dust":"<circle cx=\"6\" cy=\"7\" r=\"1.6\"/><circle cx=\"13\" cy=\"4.8\" r=\"1.1\"/><circle cx=\"18.2\" cy=\"9\" r=\"1.9\"/><circle cx=\"9.4\" cy=\"13\" r=\"2.1\"/><circle cx=\"16\" cy=\"16.2\" r=\"1.4\"/><circle cx=\"6.6\" cy=\"19\" r=\"1.2\"/><circle cx=\"12.2\" cy=\"19.8\" r=\".9\"/>","noise":"<path d=\"M3.5 9.5H7L11.5 5.5v13L7 14.5H3.5z\"/><path d=\"M15 9a4.2 4.2 0 0 1 0 6M17.8 6.3a8 8 0 0 1 0 11.4\"/>","light":"<circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4\"/>","bulb":"<path d=\"M9 18h6M10 21h4\"/><path d=\"M8.4 15c-1.5-1.2-2.4-3-2.4-5a6 6 0 0 1 12 0c0 2-.9 3.8-2.4 5z\" fill=\"currentColor\" fill-opacity=\".15\"/><path d=\"M12 15v-3.5l-1.5-1.5M12 11.5l1.5-1.5\"/>","wind":"<path d=\"M3 8.5h10.5a2.5 2.5 0 1 0-2.5-2.5M3 12.5h15.5a2.5 2.5 0 1 1-2.5 2.5M3 16.5h7\"/>","compass":"<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 5l2.6 7L12 19l-2.6-7z\"/><path d=\"M12 5l2.6 7H9.4z\" fill=\"currentColor\" stroke=\"none\"/><path d=\"M12 1.8v1.4M22.2 12h-1.4M12 22.2v-1.4M1.8 12h1.4\" stroke-opacity=\".6\"/>","rain":"<path d=\"M7 14.5a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 6a4.2 4.2 0 0 1-.4 8.5z\"/><path d=\"M8.5 17.5l-1.2 3M12.5 17.5l-1.2 3M16.5 17.5l-1.2 3\"/>","battery":"<rect x=\"2.5\" y=\"7\" width=\"17\" height=\"10\" rx=\"2\"/><path d=\"M21.5 10.3v3.4\"/><path d=\"M5.6 10v4M9 10v4M12.4 10v4\"/>","fuel":"<path d=\"M4.5 21V5a2 2 0 0 1 2-2h5.5a2 2 0 0 1 2 2v16M3 21h12.5M7 7.5h4.5\"/><path d=\"M14 10h2a2 2 0 0 1 2 2v4.5a1.5 1.5 0 0 0 3 0V8.5L18.2 5.7\"/>","flame":"<path d=\"M12 22c4 0 7-2.8 7-6.8 0-3.6-2.5-5.6-3.8-8.3-.6 2-1.5 3-2.8 3.4C12.5 7 11.3 4.3 9 2c.3 3.2-1.4 5.1-2.9 7.2C4.8 11 5 12.6 5 15.2 5 19.2 8 22 12 22z\" fill=\"currentColor\" fill-opacity=\".15\"/><path d=\"M12 22a3 3 0 0 1-3-3c0-2 2-3 2.5-5 1.6 1.5 3.5 3 3.5 5a3 3 0 0 1-3 3z\"/>","snow":"<path d=\"M12 2.5v19M3.8 7.3l16.4 9.4M3.8 16.7l16.4-9.4\"/><path d=\"M9.6 4L12 6.3 14.4 4M9.6 20L12 17.7l2.4 2.3M3.7 10.4l3.2-.9-.9-3.2M20.3 13.6l-3.2.9.9 3.2M3.7 13.6l3.2.9-.9 3.2M20.3 10.4l-3.2-.9.9-3.2\"/>","eff":"<path d=\"M4.2 17.5a9 9 0 1 1 15.6 0\"/><path d=\"M9 15l6-6.5\"/><circle cx=\"9.3\" cy=\"9.4\" r=\"1.4\"/><circle cx=\"14.7\" cy=\"14.1\" r=\"1.4\"/>","target":"<circle cx=\"12\" cy=\"12\" r=\"9\"/><circle cx=\"12\" cy=\"12\" r=\"5\"/><circle cx=\"12\" cy=\"12\" r=\"1.6\" fill=\"currentColor\" stroke=\"none\"/>","money":"<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M15 9.3c-.6-1-1.7-1.6-3-1.6-1.8 0-3 .9-3 2.2 0 3 6.2 1.6 6.2 4.4 0 1.4-1.3 2.3-3.2 2.3-1.4 0-2.6-.6-3.2-1.7M12 6v1.7M12 16.6v1.7\"/>","vib":"<path d=\"M2 12h3l2.2-5 3.2 10 3.2-12 3.2 12 2-5H22\"/>","door":"<path d=\"M3 21h18\"/><path d=\"M6 21V3.5h9V21\"/><path d=\"M15 3.5l4 1.6V21\" stroke-opacity=\".6\"/><circle cx=\"12.6\" cy=\"12.5\" r=\"1.1\" fill=\"currentColor\" stroke=\"none\"/>","run":"<path d=\"M12 3v8\"/><path d=\"M6.6 6.6a8 8 0 1 0 10.8 0\"/>","valve":"<path d=\"M2 13h3M19 13h3\"/><path d=\"M5 8.5l14 9v-9l-14 9z\" fill=\"currentColor\" fill-opacity=\".15\"/><path d=\"M12 13V5.5M9 5.5h6\"/>","pump":"<circle cx=\"12\" cy=\"13\" r=\"6.5\"/><path d=\"M2.5 13h3M12 6.5V3.5h8.5\"/><path d=\"M9.4 16.2L12 9.6l2.6 6.6z\" fill=\"currentColor\" fill-opacity=\".3\"/><path d=\"M7 21h10\"/>","fan":"<circle cx=\"12\" cy=\"12\" r=\"1.8\"/><path d=\"M12 10.2c-.4-3.4.8-6.2 3.4-6.2 2 0 2.6 2.6.5 4.2zM13.8 12c3.4-.4 6.2.8 6.2 3.4 0 2-2.6 2.6-4.2.5zM12 13.8c.4 3.4-.8 6.2-3.4 6.2-2 0-2.6-2.6-.5-4.2zM10.2 12c-3.4.4-6.2-.8-6.2-3.4 0-2 2.6-2.6 4.2-.5z\"/>","motor":"<rect x=\"3\" y=\"7\" width=\"13\" height=\"10\" rx=\"2\"/><path d=\"M7 7v10M10.5 7v10M16 12h5M19.5 9.5v5\"/><path d=\"M5 17v3M14 17v3M3 20h13\"/>","generator":"<rect x=\"3\" y=\"6\" width=\"18\" height=\"12\" rx=\"2.5\"/><path d=\"M13 8.3l-3 4.2h4l-3 4.2\"/><path d=\"M6.5 18v2.5M17.5 18v2.5\"/>","compressor":"<rect x=\"2.5\" y=\"10.5\" width=\"14\" height=\"8\" rx=\"4\"/><circle cx=\"18.5\" cy=\"7\" r=\"3\"/><path d=\"M5.5 18.5V21M13.5 18.5V21M18.5 10v3h-2\"/>","plug":"<path d=\"M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3.5 21h13\"/><path d=\"M10.6 6.8L8.2 11h3.6l-2.4 4.2\"/><path d=\"M15 10h2a2 2 0 0 1 2 2v3a1.5 1.5 0 0 0 3 0V8l-2.5-2.5\"/>","pin":"<path d=\"M12 21.5s7-6.2 7-11.8a7 7 0 0 0-14 0c0 5.6 7 11.8 7 11.8z\"/><circle cx=\"12\" cy=\"9.6\" r=\"2.6\"/>","route":"<circle cx=\"6\" cy=\"18\" r=\"2.2\"/><circle cx=\"18\" cy=\"6\" r=\"2.2\"/><path d=\"M8.2 18h7.3a3.5 3.5 0 0 0 0-7h-7a3.5 3.5 0 0 1 0-7h7.3\"/>","elevator":"<rect x=\"4\" y=\"3\" width=\"16\" height=\"18\" rx=\"2\"/><path d=\"M12 3v18\" stroke-opacity=\".5\"/><path d=\"M6.4 10.5L8 8.2l1.6 2.3M14.4 13.5l1.6 2.3 1.6-2.3\"/>","signal":"<path d=\"M12 10.5V21M8.5 21h7\"/><circle cx=\"12\" cy=\"8.6\" r=\"1.6\" fill=\"currentColor\" stroke=\"none\"/><path d=\"M8.6 5.2a4.8 4.8 0 0 0 0 6.8M15.4 5.2a4.8 4.8 0 0 1 0 6.8M5.8 2.5a8.6 8.6 0 0 0 0 12.2M18.2 2.5a8.6 8.6 0 0 1 0 12.2\"/>","alarm":"<path d=\"M6 16.5v-5.5a6 6 0 0 1 12 0v5.5l1.6 2H4.4z\"/><path d=\"M10 21a2 2 0 0 0 4 0\"/>","warn":"<path d=\"M10.3 4.2L2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z\"/><path d=\"M12 9.5v4.5\"/><circle cx=\"12\" cy=\"17.2\" r=\"1.1\" fill=\"currentColor\" stroke=\"none\"/>","people":"<circle cx=\"9\" cy=\"8\" r=\"3.5\"/><path d=\"M2.5 20.5a6.5 6.5 0 0 1 13 0\"/><path d=\"M16 4.6a3.5 3.5 0 0 1 0 6.8M18.2 14.3a6.5 6.5 0 0 1 3.3 6.2\"/>","chart":"<path d=\"M3.5 3.5v17h17\"/><path d=\"M7.5 15l4-4.5 3 3 5-6\"/>","grid":"<rect x=\"3\" y=\"3\" width=\"7.5\" height=\"7.5\" rx=\"1.8\"/><rect x=\"13.5\" y=\"3\" width=\"7.5\" height=\"7.5\" rx=\"1.8\"/><rect x=\"3\" y=\"13.5\" width=\"7.5\" height=\"7.5\" rx=\"1.8\"/><rect x=\"13.5\" y=\"13.5\" width=\"7.5\" height=\"7.5\" rx=\"1.8\"/>","list":"<path d=\"M8.5 6h12M8.5 12h12M8.5 18h12\"/><circle cx=\"4.3\" cy=\"6\" r=\"1.3\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"4.3\" cy=\"12\" r=\"1.3\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"4.3\" cy=\"18\" r=\"1.3\" fill=\"currentColor\" stroke=\"none\"/>","cloud":"<path d=\"M7 19a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 10.5a4.3 4.3 0 0 1-.4 8.5z\"/>","device":"<rect x=\"6\" y=\"6\" width=\"12\" height=\"12\" rx=\"2\"/><rect x=\"9.5\" y=\"9.5\" width=\"5\" height=\"5\" rx=\"1\"/><path d=\"M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5\"/>","gear":"<circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M10.3 2.8h3.4l.5 2.6 1.9.8 2.2-1.5 2.4 2.4-1.5 2.2.8 1.9 2.6.5v3.4l-2.6.5-.8 1.9 1.5 2.2-2.4 2.4-2.2-1.5-1.9.8-.5 2.6h-3.4l-.5-2.6-1.9-.8-2.2 1.5-2.4-2.4 1.5-2.2-.8-1.9-2.6-.5v-3.4l2.6-.5.8-1.9-1.5-2.2 2.4-2.4 2.2 1.5 1.9-.8z\"/>","bell":"<path d=\"M6 16.5v-5.5a6 6 0 0 1 12 0v5.5l1.6 2H4.4z\"/><path d=\"M10 21a2 2 0 0 0 4 0\"/>","home":"<path d=\"M3 11l9-7.5 9 7.5\"/><path d=\"M5.5 9.3V20.5h13V9.3\"/><path d=\"M10 20.5v-5.5h4v5.5\"/>","building":"<rect x=\"5\" y=\"3\" width=\"14\" height=\"18\" rx=\"1.5\"/><path d=\"M9 7h1.5M13.5 7H15M9 10.5h1.5M13.5 10.5H15M9 14h1.5M13.5 14H15M10.5 21v-3.5h3V21\"/>","factory":"<path d=\"M2.5 21V11l5.5 3.5V11l5.5 3.5V5h3V3h2.5v2H21v16z\"/><path d=\"M6 17.5h2M11 17.5h2M16 17.5h2\"/>","leaf":"<path d=\"M12 21.5v-8.5\"/><path d=\"M12 13c0-4.3 2.6-7.3 8.5-7.3 0 4.7-3.2 7.3-8.5 7.3z\" fill=\"currentColor\" fill-opacity=\".15\"/><path d=\"M12 16c0-3.2-2.1-5.8-6.8-5.8 0 3.7 2.6 5.8 6.8 5.8z\" fill=\"currentColor\" fill-opacity=\".15\"/>","fish":"<path d=\"M17 12c-2.5-3.6-5.6-5.2-8.6-5.2C5.9 6.8 3.9 8.4 2.8 12c1.1 3.6 3.1 5.2 5.6 5.2 3 0 6.1-1.6 8.6-5.2zM17 12l4.3-3.7v7.4z\"/><circle cx=\"6.9\" cy=\"11\" r=\"1\" fill=\"currentColor\" stroke=\"none\"/><path d=\"M10.5 9c.8.8 1.2 1.8 1.2 3s-.4 2.2-1.2 3\" stroke-opacity=\".55\"/>","car":"<path d=\"M4 17V12.5L6.3 7h11.4L20 12.5V17z\"/><path d=\"M4 12.5h16\"/><circle cx=\"7.6\" cy=\"15\" r=\"1.1\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"16.4\" cy=\"15\" r=\"1.1\" fill=\"currentColor\" stroke=\"none\"/><path d=\"M5.5 17v2.5M18.5 17v2.5\"/>","truck":"<path d=\"M2 6h11v10.5H2zM13 9.5h4.6L21 13v3.5h-8z\"/><circle cx=\"6\" cy=\"17.8\" r=\"1.9\"/><circle cx=\"17\" cy=\"17.8\" r=\"1.9\"/>","map":"<path d=\"M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z\"/><path d=\"M9 4v14M15 6v14\"/>","calendar":"<rect x=\"3\" y=\"5\" width=\"18\" height=\"16\" rx=\"2.5\"/><path d=\"M3 10h18M8 3v4M16 3v4\"/><path d=\"M7.5 14h2M11 14h2M14.5 14h2M7.5 17.5h2M11 17.5h2\"/>","process":"<rect x=\"2.5\" y=\"5\" width=\"5.5\" height=\"14\" rx=\"1.5\"/><rect x=\"16\" y=\"9\" width=\"5.5\" height=\"10\" rx=\"1.5\"/><path d=\"M8 15h8\"/><path d=\"M10 12l4 6v-6l-4 6z\" fill=\"currentColor\" fill-opacity=\".2\"/>","andon":"<rect x=\"8.5\" y=\"2.5\" width=\"7\" height=\"15\" rx=\"2\"/><path d=\"M8.5 7.5h7M8.5 12.5h7\"/><path d=\"M12 17.5V21M7.5 21h9\"/><path d=\"M8.5 2.5h7v5h-7z\" fill=\"currentColor\" fill-opacity=\".3\" stroke=\"none\"/>","dryer":"<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"2.5\"/><path d=\"M3 8h18\"/><path d=\"M8.5 17.5c-1-1.3-1-2.5 0-3.8s1-2.5 0-3.2M12 17.5c-1-1.3-1-2.5 0-3.8s1-2.5 0-3.2M15.5 17.5c-1-1.3-1-2.5 0-3.8s1-2.5 0-3.2\"/>","tower":"<path d=\"M12 6.5L7 21.5M12 6.5l5 15M8.6 16.5h6.8M10 12h4\"/><circle cx=\"12\" cy=\"5\" r=\"1.6\" fill=\"currentColor\" stroke=\"none\"/><path d=\"M8.6 2.4a4.5 4.5 0 0 0 0 5.2M15.4 2.4a4.5 4.5 0 0 1 0 5.2\"/>","wave":"<path d=\"M2 9c1.7-1.6 3.3-1.6 5 0s3.3 1.6 5 0 3.3-1.6 5 0 3.3 1.6 5 0M2 15c1.7-1.6 3.3-1.6 5 0s3.3 1.6 5 0 3.3-1.6 5 0 3.3 1.6 5 0\"/>","pipe":"<path d=\"M2 8h7v8h6V8h7M2 8v8M22 8v8\"/>","conveyor":"<rect x=\"2.5\" y=\"14\" width=\"19\" height=\"6\" rx=\"3\"/><circle cx=\"6\" cy=\"17\" r=\"1.1\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"18\" cy=\"17\" r=\"1.1\" fill=\"currentColor\" stroke=\"none\"/><rect x=\"5\" y=\"7\" width=\"5.5\" height=\"5\" rx=\"1\"/><rect x=\"13.5\" y=\"7\" width=\"5.5\" height=\"5\" rx=\"1\"/>","bolt":"<path d=\"M13 2.5L4.5 13.5H11L10 21.5l8.5-11H12z\" fill=\"currentColor\" fill-opacity=\".18\"/>","thermo":"<path d=\"M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z\"/><path d=\"M12 9.5v7\"/><circle cx=\"12\" cy=\"17.6\" r=\"1.7\" fill=\"currentColor\" stroke=\"none\"/>","dot":"<circle cx=\"12\" cy=\"12\" r=\"8\"/><circle cx=\"12\" cy=\"12\" r=\"3\" fill=\"currentColor\" stroke=\"none\"/>","check":"<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M8 12.4l2.8 2.8L16.3 9.6\"/>"};
  const RULES = [["any","(chay kho|dry ?run)","warn"],["any","(ngon lua|flame|burner|dau dot|\\bdot lo\\b)","flame"],["any","(nhien lieu|fuel|xang|diesel)","fuel"],["any","(phe pham|scrap|reject|hang loi)","warn"],["any","(su co|fault|alarm|\\bloi\\b|canh bao|\\btrip\\b|\\berr|den hong|ro ri|leak)","warn"],["any","(do sang|\\bdim\\b)","bulb"],["any","(pin mat troi|solar|\\bpv\\b|buc xa)","light"],["any","(\\bpin\\b|battery|\\bsoc\\b|ac quy|\\bups\\b|\\bbatt)","battery"],["any","(huong gio|wind ?dir|\\bdir\\b|\\bhuong\\b)","compass"],["any","(toc do gio|gio giat|\\bwind|\\bgust)","wind"],["any","(\\bmua\\b|rain)","rain"],["any","(tin hieu|signal|rssi|\\bdbm\\b|song di dong)","signal"],["any","(muc nuoc song|\\bsong\\b|river|\\blu\\b|flood)","level"],["any","(\\bkhoi\\b|smoke|\\bgas\\b|khi gas|co2|h2s|\\bvoc\\b|\\blpg\\b)","gas"],["any","(\\baqi\\b|chat luong khong khi)","dust"],["any","(\\bbui\\b|pm2|pm10|pm1\\b|dust)","dust"],["any","(tieng on|do on|noise|\\bdb\\b)","noise"],["key","(^| )(do|o2|do mg l)( |$)","oxygen"],["any","(oxy|dissolved|\\bo2\\b)","oxygen"],["any","(do duc|turbid|\\bntu\\b)","turbidity"],["any","(\\bclo|chlor|\\borp\\b|amoni|nh3|nitrit|\\bnh4|\\bcod\\b|\\bbod\\b|\\btss\\b)","chem"],["any","(\\bph\\b)","ph"],["any","(do man|salin|\\bppt\\b)","drop"],["any","(anh sang|\\blux\\b|do roi|\\bpar\\b|buc xa|irradian|\\buv\\b)","light"],["any","(\\brung\\b|vib)","vib"],["any","(\\bcua\\b|door|\\bgate\\b|cong vao)","door"],["any","(^tang\\b|floor)","elevator"],["any","(vi tri|\\blat\\b|\\blon\\b|gps)","pin"],["any","(quang duong|\\bodo|distance|hanh trinh)","route"],["any","(nguoi|occup|people|khach)","people"],["any","(chi phi|cost|tien dien|tien nuoc|don gia|\\bvnd\\b)","money"],["any","(dien luoi|luoi dien|mains|nguon dang cap|\\bsource\\b)","power"],["any","(he so cong suat|cosphi|\\bpf\\b)","eff"],["any","(\\boee\\b|hieu suat|efficien|\\bcop\\b|\\beer\\b|ty le|ti le|san sang|chat luong|availab|perform)","eff"],["any","(muc tieu|target|ke hoach)","target"],["any","(\\bsac\\b|charg|\\bev\\b)","plug"],["state","(luoi che|shade|\\brem\\b)","light"],["state","(\\btuoi\\b|irrig|phun suong|\\bmist\\b)","drop"],["state","(\\bbom\\b|pump)","pump"],["state","(\\bquat\\b|\\bfan\\b|blower|thoi khi|suc khi|aerat|may thoi)","fan"],["state","(\\bvan\\b|valve)","valve"],["state","(may nen|compressor)","compressor"],["state","(may phat|generator|genset|\\bats\\b)","generator"],["state","(dong co|motor|bang tai|conveyor)","motor"],["state","(\\bden\\b|lamp|chieu sang)","bulb"],["state","(suoi|heater|gia nhiet|dot nong|\\bsay\\b)","flame"],["state","(dieu hoa|hvac|lam lanh|chiller|\\blanh\\b|cool|xa da)","snow"],["state","(\\bcoi\\b|siren|horn)","alarm"],["map","(chay|dung|bat|tat|run|\\bon\\b|\\boff\\b)","run"],["map","(\\bmo\\b|dong|open|close)","valve"],["unit","^(°c|°f|℃)$","temp"],["unit","^(%rh|rh)$","humidity"],["unit","^(bar|kpa|mpa|psi|pa|hpa|mbar|atm|kgf/cm2|kg/cm2)$","pressure"],["unit","^(m³/h|m3/h|l/ph|l/phut|l/min|l/h|l/s|m³/s|m3/s|lpm|gpm|t/h|kg/h|m³/ngay|m3/ngay)$","flow"],["unit","^(kwh|mwh|wh|kvarh)$","energy"],["unit","^(kw|mw|w|kva|kvar|hp)$","power"],["unit","^(v|kv)$","voltage"],["unit","^(a|ma|ka)$","current"],["unit","^(hz)$","freq"],["unit","^(rpm|vong/phut|v/p)$","speed"],["unit","^(m/s|km/h)$","speed"],["unit","^(h|gio|phut|min|s|giay|ngay)$","clock"],["unit","^(kg|t|tan|tonne)$","weight"],["unit","^(ppm|ppb)$","gas"],["unit","^(µg/m³|ug/m3|µg/m3|mg/m³)$","dust"],["unit","^(db|dba)$","noise"],["unit","^(lux|lx|w/m²|w/m2)$","light"],["unit","^(ntu)$","turbidity"],["unit","^(mg/l|µs/cm|us/cm|ms/cm|mv)$","chem"],["unit","^(mm)$","rain"],["unit","^(cm|m)$","level"],["unit","^(km)$","route"],["unit","^(den|bong)$","bulb"],["unit","^(xe)$","truck"],["unit","^(sp|cai|pcs|chiec|thung|bao)$","box"],["unit","^(m³|m3|l|lit)$","drop"],["unit","^(vnd|₫|k₫)$","money"],["any","(\\bmuc\\b|level|\\blvl\\b|\\bbon\\b|\\bbe\\b|tank|ton kho|the tich|volume)","level"],["any","(san luong|so luong|product|output|thanh pham)","box"],["any","(chuyen|\\bme\\b|batch|phien|count|\\bdem\\b|\\bcnt\\b|so lan)","count"],["any","(nhiet|temp)","temp"],["any","(do am|humid|\\bhum\\b|\\brh\\b)","humidity"],["any","(luu luong|flow)","flow"],["any","(ap suat|ap luc|press)","pressure"],["any","(dien ap|volt)","voltage"],["any","(dong dien|current|\\bamp)","current"],["any","(cong suat|power|\\bkw\\b)","power"],["any","(dien nang|energy|kwh)","energy"],["any","(tan so|freq)","freq"],["any","(toc do|speed|rpm|vong quay)","speed"],["any","(gio chay|thoi gian|runtime|hours|\\btime\\b|dung may|downtime)","clock"],["any","(khoi luong|weight|\\btai\\b|load)","weight"],["any","(\\bden\\b|lamp)","bulb"],["any","(\\bbom\\b|pump)","pump"],["any","(\\bquat\\b|\\bfan\\b|blower)","fan"],["any","(\\bvan\\b|valve)","valve"],["any","(trang thai|state|status|\\brun\\b|\\bchay\\b)","run"],["unit","^%$","eff"]].map(([f, r, i]) => [f, new RegExp(r), i]);
  const strip = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
  const norm = (s) => strip(s).replace(/[^a-z0-9]+/g, ' ').trim();
  const unorm = (s) => strip(s).replace(/\s+/g, '');
  function forMetric(m) {
    m = m || {};
    const keys = (m.keys || []).map((k) => (Array.isArray(k) ? k[0] : k)).join(' ');
    const f = { label: norm(m.label), key: norm(keys), unit: unorm(m.unit), map: norm(Object.values(m.map || {}).join(' ')) };
    f.any = [f.label, f.key, norm(m.id)].filter(Boolean).join(' ');
    f.state = m.map ? f.any : '';
    for (const [fld, re, ic] of RULES) if (f[fld] && re.test(f[fld])) return ic;
    return 'chart';
  }
  const forField = (key, unit, label, kind) => forMetric({ id: key, label, unit, keys: [key], map: kind === 'toggle' ? { 0: 'tắt', 1: 'bật' } : null });
  const svg = (id, cls) => `<svg class="qi${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${Q[id] || Q.chart}</svg>`;
  window.PlcQIcons = { svg, forMetric, forField, has: (id) => !!Q[id], names: Object.keys(Q) };
}());
'use strict';
/* Engine giao diện "giải pháp ngành" (lớp phủ lên webapp cơ bản). Đọc cấu hình window.INDUSTRY (file spec.js của giải pháp):
 *   - Tổng quan: khối giao diện theo ngành chèn lên đầu tab Thiết bị (thẻ thiết bị + điều khiển của bản cơ bản vẫn nằm bên dưới)
 *   - Thêm tab theo ngành, tab Thiết bị, tab Cảnh báo (ngưỡng theo từng chỉ số)
 * Dùng đúng luồng số liệu của bản cơ bản (DevicesUi.onTelemetry, d.<thiết bị>.<field>, schema 2). Đăng nhập, quét QR, cài đặt, chat, gói… là mã bản cơ bản.
 * Mã này giống hệt ở mọi giải pháp (tools/solution-kit/industry.js → solutions/<id>/webapp/industry.js bằng tools/solution-kit/gen.mjs). */
window.IndustryEngine = (function () {
const STORE = {};   // trạng thái cảnh báo theo gateway: giữ nguyên khi chuyển tab gateway (gắn/gỡ giao diện)
function mount(S, opts) {   // mount(spec, { base }): base = topic gateway (gw/<id>) — chỉ nhận số liệu + thiết bị của gateway đó; unmount() dọn sạch để gắn giải pháp khác
  const GW = (opts && opts.base) || '';
  const HL = !!(opts && opts.headless);   // chạy ngầm (không hiện): chỉ để theo dõi cảnh báo của gateway không đang mở
  const ROOT = HL ? document.createElement('div') : document;
  let dead = false;
  const dash = HL ? document.createElement('div') : document.getElementById('tab-dash');
  const nav = HL ? document.createElement('div') : document.getElementById('nav');
  const main = HL ? document.createElement('div') : document.querySelector('main');
  if (HL) ROOT.append(dash, nav, main);
  if (!S || !dash || !nav || !main) return null;
  if (!HL) document.documentElement.dataset.ind = S.style || 'soft';

  const $ = (s, r = ROOT) => r.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const num = (x) => { const n = Number(x); return x != null && x !== '' && typeof x !== 'boolean' && Number.isFinite(n) ? n : null; };
  const fmt = (v, d) => (v == null ? '—' : (d == null ? (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)) : v.toFixed(d)).replace(/\.0+$/, ''));
  const STALE_MS = 30000;

  /* ------------------------------------------------------------------ chỉ số (metric) */
  const M = {};
  for (const m of S.metrics || []) M[m.id] = { agg: 'last', ...m };
  const keyList = (m) => (m.keys || [m.id]).map((k) => (Array.isArray(k) ? [k[0].toLowerCase(), k[1]] : [String(k).toLowerCase(), 1]));
  const devs = new Map();            // childId → { v: {field: giá trị}, ts }
  let lastTs = 0;

  let depth = 0;   // chống công thức tham chiếu vòng
  // Chỉ số suy diễn (expr): tính ngay tại webapp từ số cảm biến, KHÔNG gửi qua server. Tên trong công thức: chỉ số khác, field thô, hoặc "thiết_bị.field".
  const calc = (m, getMetric, getRaw) => {
    if (depth > 6) return null;
    depth++;
    try {
      return IndExpr.eval(m.expr, (name) => {
        const k = name.toLowerCase(), id = M[name] ? name : (M[k] ? k : null);
        if (id && id !== m.id) return getMetric(M[id]);
        if (k.includes('.')) { const [d, f] = k.split('.'); const r = [...devs].find(([i]) => i.toLowerCase() === d)?.[1]; return r ? num(r.v[f]) : null; }
        return getRaw(k);
      });
    } finally { depth--; }
  };
  const own = (rec, m) => {
    if (m.expr) return calc(m, (x) => own(rec, x), (k) => num(rec.v[k]));
    for (const [k, mul] of keyList(m)) { const n = num(rec.v[k]); if (n != null) return n * mul; } return null;
  };
  // Khối liệt kê THEO THIẾT BỊ chỉ gồm thiết bị có field GẮN vào khối đó (tên field trùng khoá chỉ số) — thiết bị khác của gateway
  // (vd. động cơ phụ trong giải pháp thủy sản) không chen vào danh sách ao, nó hiện thành widget riêng ở khung thiết bị
  const hasAny = (id, ms) => { const r = devs.get(id); return !!r && ms.some((m) => m && (m.expr ? own(r, m) != null : keyList(m).some(([k]) => k in r.v))); };
  const idsFor = (b, ms) => [...devs.keys()].filter((id) => (!b.only || b.only.includes(id)) && (!ms.filter(Boolean).length || hasAny(id, ms)));
  function value(m, recs) {
    if (m.expr) return calc(m, (x) => value(x, recs), (k) => { let v = null; for (const r of recs) { const n = num(r.v[k]); if (n != null) v = n; } return v; });
    const xs = [];
    for (const r of recs) { const n = own(r, m); if (n != null) xs.push(n); }
    if (!xs.length) return null;
    switch (m.agg) {
      case 'sum': return xs.reduce((a, b) => a + b, 0);
      case 'avg': return xs.reduce((a, b) => a + b, 0) / xs.length;
      case 'max': return Math.max(...xs);
      case 'min': return Math.min(...xs);
      case 'count': return xs.filter((x) => x > 0).length;
      default: return xs[xs.length - 1];
    }
  }
  const live = () => [...devs.values()].filter((r) => Date.now() - r.ts < STALE_MS * 4);
  const val = (id) => (M[id] ? value(M[id], live()) : null);

  // trạng thái theo ngưỡng: ok | warn | bad
  function level(m, v) {
    if (v == null || !m.th) return '';
    const t = m.th;
    if ((t.hiHi != null && v >= t.hiHi) || (t.loLo != null && v <= t.loLo)) return 'bad';
    if ((t.hi != null && v >= t.hi) || (t.lo != null && v <= t.lo)) return 'warn';
    return 'ok';
  }
  const stateText = (m, v) => {
    if (v == null) return '—';
    if (m.map) return m.map[String(Math.round(v))] ?? String(v);
    return fmt(v, m.dec);
  };
  const stateLevel = (m, v) => (m.lv ? m.lv[String(Math.round(v))] || '' : level(m, v));

  /* ------------------------------------------------------------------ lịch sử ngắn (xu hướng) */
  const HIST = {}, HMAX = 90;
  const pushHist = (id, v) => { if (v == null) return; const a = HIST[id] || (HIST[id] = []); a.push(v); if (a.length > HMAX) a.shift(); };
  let lastHist = 0;
  function sample(now) {
    if (now - lastHist < 2000) return;
    lastHist = now;
    for (const id of Object.keys(M)) pushHist(id, val(id));
  }

  /* ------------------------------------------------------------------ cảnh báo (nhật ký trong bộ nhớ) */
  const ST = STORE[GW] || (STORE[GW] = { ALM: [], prevLv: {}, unseen: 0 });
  const ALM = ST.ALM, prevLv = ST.prevLv;   // ALM: { ts, id, level, text }
  const announce = () => document.dispatchEvent(new CustomEvent('plc-ind-unseen', { detail: { base: GW, n: ST.unseen } }));
  function drawBadge() {
    const b = btns.alm; if (!b) return;
    let t = b.querySelector('.ind-badge');
    if (!ST.unseen) { t?.remove(); return; }
    if (!t) { t = document.createElement('i'); t.className = 'ind-badge'; b.appendChild(t); }
    t.textContent = ST.unseen > 99 ? '99+' : String(ST.unseen);
  }
  function alarmScan(now) {
    for (const m of Object.values(M)) {
      if (!m.th && !m.lv) continue;
      const v = val(m.id), lv = m.lv ? stateLevel(m, v) : level(m, v);
      const was = prevLv[m.id] || 'ok';
      if (v != null && lv !== (was || 'ok') && (lv === 'warn' || lv === 'bad' || was === 'warn' || was === 'bad')) {
        ALM.unshift({ ts: now, id: m.id, level: lv === 'ok' || lv === '' ? 'ok' : lv, text: `${m.label}: ${stateText(m, v)}${m.unit ? ' ' + m.unit : ''}` });
        if (ALM.length > 60) ALM.pop();
        if ((lv === 'warn' || lv === 'bad') && !(MINE.alm && !MINE.alm.hidden)) { ST.unseen++; drawBadge(); announce(); }   // cảnh báo mới chưa xem
      }
      if (v != null) prevLv[m.id] = lv || 'ok';
    }
  }
  const active = () => Object.values(M).map((m) => ({ m, v: val(m.id) })).map((x) => ({ ...x, lv: x.m.lv ? stateLevel(x.m, x.v) : level(x.m, x.v) })).filter((x) => x.lv === 'warn' || x.lv === 'bad');

  /* ------------------------------------------------------------------ khối giao diện */
  const unitOf = (m) => (m.unit ? `<small>${esc(m.unit)}</small>` : '');
  const mget = (id) => M[id] || { id, label: id };
  // icon ĐẠI LƯỢNG ĐO (cùng luật với gateway C#, xem metric-icons.js): nhiệt kế cho °C, đồng hồ áp cho bar, giọt nước cho độ ẩm…
  const QI = window.PlcQIcons;
  const icOf = (m) => (m._ic ||= (m.icon && QI?.has(m.icon) ? m.icon : QI ? QI.forMetric(m) : 'chart'));
  const qi = (m, cls) => (QI ? QI.svg(icOf(m), cls) : '');
  const svgI = (n) => (QI ? QI.svg(QI.has(n) ? n : 'chart') : '');
  // icon THIẾT BỊ (bộ icon nét của webapp, giống GatewayApp) cho danh sách thiết bị; không có bộ icon thì dùng icon giải pháp
  const devIcon = (meta, id) => (window.PlcIcons?.device ? window.PlcIcons.device(window.PlcIcons.pick(meta?.icon, meta?.type, meta?.title, titleOf(id), id), { style: 'line' }) : svgI(S.icon));

  function bKpis(b) {
    return `<div class="ik-grid c${b.cols || 0}">` + b.items.map((id) => {
      const m = mget(id), v = val(id), lv = level(m, v);
      return `<div class="ik ${lv}"><i class="ik-ic">${qi(m)}</i><span>${esc(m.label)}</span><b>${esc(stateText(m, v))}</b> ${unitOf(m)}</div>`;
    }).join('') + '</div>';
  }

  function arc(cx, cy, r, a0, a1) {
    const p = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    return `M${x0.toFixed(1)} ${y0.toFixed(1)}A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }
  function gaugeSvg(m, v, mini) {
    const min = m.min ?? 0, max = m.max ?? 100, f = v == null ? 0 : Math.max(0, Math.min(1, (v - min) / (max - min || 1)));
    const lv = level(m, v), A0 = Math.PI * 0.8, A1 = Math.PI * 2.2, a = A0 + (A1 - A0) * f;
    return `<svg viewBox="0 0 120 100" class="ig ${lv}"><path class="trk" d="${arc(60, 58, 44, A0, A1)}"/>`
      + (v == null ? '' : `<path class="val" d="${arc(60, 58, 44, A0, Math.max(A0 + 0.01, a))}"/>`)
      + `<text class="n" x="60" y="${mini ? 62 : 60}" text-anchor="middle">${esc(stateText(m, v))}</text><text class="u" x="60" y="76" text-anchor="middle">${esc(m.unit || '')}</text></svg>`;
  }
  function bGauges(b) {
    return `<div class="ig-grid c${Math.min(4, b.items.length)}">` + b.items.map((id) => {
      const m = mget(id);
      return `<div class="igw">${gaugeSvg(m, val(id))}<span>${qi(m, 'qi-in')}${esc(m.label)}</span></div>`;
    }).join('') + '</div>';
  }

  function tankSvg(m, v, label) {
    const min = m.min ?? 0, max = m.max ?? 100, f = v == null ? 0 : Math.max(0, Math.min(1, (v - min) / (max - min || 1)));
    const lv = level(m, v), H = 92, y = 8 + H * (1 - f);
    return `<div class="itk ${lv}"><svg viewBox="0 0 80 110"><rect class="body" x="10" y="8" width="60" height="${H}" rx="8"/>`
      + `<clipPath id="c${esc(m.id)}${esc(label || '')}"><rect x="10" y="8" width="60" height="${H}" rx="8"/></clipPath>`
      + `<g clip-path="url(#c${esc(m.id)}${esc(label || '')})"><rect class="fill" x="10" y="${y.toFixed(1)}" width="60" height="${(H * f + 2).toFixed(1)}"/>`
      + `<path class="wave" d="M10 ${y.toFixed(1)} q10 -5 20 0 t20 0 t20 0 t20 0 v4 h-80z"/></g>`
      + `<text class="n" x="40" y="62" text-anchor="middle">${esc(stateText(m, v))}</text><text class="u" x="40" y="76" text-anchor="middle">${esc(m.unit || '')}</text></svg>`
      + `<span>${esc(label || m.label)}</span></div>`;
  }
  function bTank(b) {
    return `<div class="itk-grid">` + b.items.map((id) => tankSvg(mget(id), val(id))).join('') + '</div>';
  }

  // mỗi thiết bị một bồn (bồn xăng dầu, bể nước…)
  function bTanks(b) {
    const m = mget(b.main);
    const ids = idsFor(b, [m]);
    return `<div class="itk-grid">` + ids.map((id) => tankSvg(m, own(devs.get(id), m), titleOf(id))).join('') + '</div>';
  }

  function bState(b) {
    return `<div class="ist">` + b.items.map((id) => {
      const m = mget(id), v = val(id), lv = v == null ? '' : (m.lv ? stateLevel(m, v) : (num(v) > 0 ? 'ok' : 'off'));
      return `<span class="ichip ${lv}">${qi(m, 'qi-st')}${esc(m.label)}: <b>${esc(stateText(m, v))}</b></span>`;
    }).join('') + '</div>';
  }

  function bBars(b) {
    return `<div class="ib">` + b.items.map((id) => {
      const m = mget(id), v = val(id), min = m.min ?? 0, max = m.max ?? 100, f = v == null ? 0 : Math.max(0, Math.min(1, (v - min) / (max - min || 1)));
      return `<div class="ib-r ${level(m, v)}"><span>${qi(m, 'qi-in')}${esc(m.label)}</span><div class="ib-t"><div style="width:${(f * 100).toFixed(1)}%"></div></div><div class="ib-v"><b>${esc(stateText(m, v))}</b> ${unitOf(m)}</div></div>`;
    }).join('') + '</div>';
  }

  function bTrend(b) {
    const m = mget(b.metric), a = HIST[b.metric] || [];
    const W = 300, H = 70;
    let path = '', area = '', lo = null, hi = null;
    if (a.length > 1) {
      lo = Math.min(...a); hi = Math.max(...a);
      const span = hi - lo || 1;
      const pts = a.map((v, i) => [(i / (HMAX - 1)) * W + (W - ((a.length - 1) / (HMAX - 1)) * W), H - 6 - ((v - lo) / span) * (H - 14)]);
      path = 'M' + pts.map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L');
      area = path + `L${pts[pts.length - 1][0].toFixed(1)} ${H}L${pts[0][0].toFixed(1)} ${H}z`;
    }
    return `<div class="itr"><div class="itr-h"><b>${qi(m, 'qi-in')}${esc(b.title || m.label)}</b><span>${esc(stateText(m, val(b.metric)))} ${esc(m.unit || '')}</span></div>`
      + `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path class="ar" d="${area}"/><path class="ln" d="${path}"/></svg>`
      + `<div class="itr-f"><span>${lo == null ? '' : 'min ' + fmt(lo, m.dec)}</span><span>${hi == null ? 'Chờ dữ liệu…' : 'max ' + fmt(hi, m.dec)}</span></div></div>`;
  }

  // thẻ theo từng thiết bị (vùng, phòng lạnh, trụ sạc, bồn…): chỉ số chính to + chỉ số phụ, màu theo ngưỡng của chỉ số chính
  function titleOf(id) {
    try { const d = (window.DevicesUi?.getDashboard?.()?.devices || []).find((x) => x.childId === id); if (d?.title) return d.title; } catch { /* */ }
    return (S.demo?.devices?.[id]?.title) || id;
  }
  function bTiles(b) {
    const main = mget(b.main), subs = (b.subs || []).map(mget);
    const ids = idsFor(b, [main, ...subs]);
    if (!ids.length) return '<p class="muted">Chưa có thiết bị. Thêm thiết bị bằng mã QR ở tab Thiết bị.</p>';
    return `<div class="it-grid">` + ids.map((id) => {
      const r = devs.get(id), v = own(r, main), lv = main.lv ? stateLevel(main, v) : level(main, v);
      const off = Date.now() - r.ts > STALE_MS;
      return `<div class="it ${off ? 'offl' : lv}"><div class="it-h"><b>${esc(titleOf(id))}</b><i></i></div>`
        + `<div class="it-v">${qi(main, 'it-ic')}${esc(stateText(main, v))} ${unitOf(main)}</div><div class="it-l">${esc(main.label)}</div>`
        // chỉ số phụ: icon nói lên đại lượng (nhãn đầy đủ khi rê chuột) + số — gọn trên điện thoại, giống GatewayApp
        + (subs.length ? '<div class="it-s">' + subs.map((s) => { const sv = own(r, s); return `<span class="${level(s, sv)}" title="${esc(s.label)}">${qi(s, 'qi-in')}<b>${esc(stateText(s, sv))}</b>${s.unit ? ' ' + esc(s.unit) : ''}</span>`; }).join('') + '</div>' : '')
        + '</div>';
    }).join('') + '</div>';
  }

  // dây chuyền: các trạm nối tiếp bằng mũi tên chạy, màu theo trạng thái
  function bLine(b) {
    const st = mget(b.state), ids = idsFor(b, [st]);
    if (!ids.length) return '';
    return `<div class="il">` + ids.map((id, i) => {
      const r = devs.get(id), v = own(r, st), lv = stateLevel(st, v) || 'off';
      return (i ? `<div class="il-a ${lv === 'ok' ? 'run' : ''}"><i></i></div>` : '')
        + `<div class="il-s ${lv}"><b>${esc(titleOf(id))}</b><span>${esc(stateText(st, v))}</span>${b.sub ? `<em>${esc(fmt(own(r, mget(b.sub)), mget(b.sub).dec))} ${esc(mget(b.sub).unit || '')}</em>` : ''}</div>`;
    }).join('') + '</div>';
  }

  // vòng lớn (OEE…) + các vòng phụ
  function bRing(b) {
    const m = mget(b.main);
    return `<div class="irg"><div class="irg-m">${gaugeSvg(m, val(b.main))}<span>${qi(m, 'qi-in')}${esc(m.label)}</span></div>`
      + `<div class="irg-s">` + (b.subs || []).map((id) => `<div>${gaugeSvg(mget(id), val(id), true)}<span>${qi(mget(id), 'qi-in')}${esc(mget(id).label)}</span></div>`).join('') + '</div></div>';
  }

  function bAlarms() {
    const act = active();
    if (!act.length) return `<div class="ial ok">${svgI('check')}Mọi chỉ số trong giới hạn an toàn.</div>`;
    return '<div class="ial-l">' + act.map((x) => `<div class="ial ${x.lv}">${x.lv === 'bad' ? svgI('warn') : qi(x.m)}<b>${esc(x.m.label)}</b> ${esc(stateText(x.m, x.v))} ${esc(x.m.unit || '')}<small>${x.lv === 'bad' ? 'Nguy hiểm' : 'Cảnh báo'}</small></div>`).join('') + '</div>';
  }


  /* ---------------- mặt bằng: các phòng/khu vực + điểm cảm biến đặt đúng vị trí, màu theo ngưỡng */
  function bPlan(b) {
    const W = b.w || 100, H = b.h || 60, main = mget(b.main);
    const rooms = (b.rooms || []).map((r) => `<rect class="pl-room" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="1.2"/><text class="pl-lbl" x="${r.x + 1.6}" y="${r.y + 3.6}">${esc(r.label)}</text>`).join('');
    const marks = (b.markers || []).map((k) => {
      const rec = devs.get(k.dev), v = rec ? own(rec, main) : null, lv = main.lv ? stateLevel(main, v) : level(main, v);
      const off = !rec || (Date.now() - rec.ts > STALE_MS);
      return `<g class="pl-m ${off ? 'offl' : lv}"><circle cx="${k.x}" cy="${k.y}" r="3.4"/><text class="pl-v" x="${k.x}" y="${k.y + 1.1}" text-anchor="middle">${esc(stateText(main, v))}</text>`
        + `<text class="pl-t" x="${k.x}" y="${k.y + 7}" text-anchor="middle">${esc(k.label || titleOf(k.dev))}</text></g>`;
    }).join('');
    return `<svg class="plan" viewBox="0 0 ${W} ${H}" role="img" aria-label="Mặt bằng"><rect class="pl-bg" x="0" y="0" width="${W}" height="${H}" rx="2"/>${rooms}${marks}</svg>`;
  }

  /* ---------------- P&ID: bồn – bơm – van – bình phản ứng nối bằng đường ống; ống chảy khi chỉ số nguồn > 0 */
  function bPid(b) {
    const W = b.w || 120, H = b.h || 70, g = (id) => (id ? val(id) : null);
    /* Khách có thể không đủ cảm biến: 'na' = chưa gán chỉ số này (không giám sát), 'nd' = có gán nhưng chưa/mất dữ liệu. Không bao giờ vẽ thành "dừng"/"đóng". */
    const st = (id) => (!id ? '' : !M[id] ? 'na' : g(id) == null ? 'nd' : '');
    const stTip = { na: 'Không giám sát (chưa gán cảm biến)', nd: 'Mất tín hiệu / chưa có dữ liệu' };
    const pipes = (b.pipes || []).map((p) => {
      const on = p.on ? num(g(p.on)) > 0 : true, d = 'M' + p.pts.map((q) => q.join(' ')).join('L');
      return `<path class="pd-pipe${p.on && st(p.on) ? ' unk' : ''}" d="${d}"/>` + (on ? `<path class="pd-flow" d="${d}" style="stroke:${p.color || 'var(--acc)'}"/>` : '');
    }).join('');
    const nodes = (b.nodes || []).map((n) => {
      const m = n.metric ? mget(n.metric) : null, v = n.metric ? g(n.metric) : null, lv = m ? (m.lv ? stateLevel(m, v) : level(m, v)) : '', ns = st(n.metric);
      const tip = ns ? `<title>${esc((n.label || '') + ': ' + stTip[ns])}</title>` : '';
      const lbl = `<text class="pd-t" x="${n.x}" y="${(n.y || 0) + (n.kind === 'tank' || n.kind === 'vessel' ? (n.h || 20) + 4 : 9)}" text-anchor="middle">${esc(n.label || '')}</text>`;
      if (n.kind === 'tank' || n.kind === 'vessel') {
        const w = n.w || 16, h = n.h || 20, f = n.kind === 'tank' ? (v == null ? 0 : Math.max(0, Math.min(1, (v - (m.min ?? 0)) / ((m.max ?? 100) - (m.min ?? 0) || 1)))) : 0.55;
        const x0 = n.x - w / 2;
        return `<g class="pd-n ${ns || lv}">${tip}<rect class="pd-body" x="${x0}" y="${n.y}" width="${w}" height="${h}" rx="${n.kind === 'tank' ? 2 : 6}"/>`
          + `<rect class="pd-fill" x="${x0 + 0.6}" y="${(n.y + h * (1 - f)).toFixed(1)}" width="${w - 1.2}" height="${(h * f).toFixed(1)}" rx="1.5"/>`
          + (m ? `<text class="pd-v" x="${n.x}" y="${n.y + h / 2 + 1.5}" text-anchor="middle">${ns === 'na' ? '' : esc(stateText(m, v))}${m.unit && !ns ? ' ' + esc(m.unit) : ''}</text>` : '') + lbl + '</g>';
      }
      if (n.kind === 'pump') {
        const run = !ns && num(v) > 0;
        return `<g class="pd-n ${ns || (run ? 'ok' : 'off')}">${tip}<circle class="pd-body" cx="${n.x}" cy="${n.y}" r="5.4"/><g class="${run ? 'pd-spin' : ''}" style="transform-origin:${n.x}px ${n.y}px"><path class="pd-imp" d="M${n.x} ${n.y - 3.6}L${n.x + 3.2} ${n.y + 1.8}L${n.x - 3.2} ${n.y + 1.8}z"/></g>${lbl}</g>`;
      }
      if (n.kind === 'valve') {
        const open = !ns && num(v) > 0;
        return `<g class="pd-n ${ns || (open ? 'ok' : 'bad')}">${tip}<path class="pd-valve" d="M${n.x - 4} ${n.y - 3.4}L${n.x + 4} ${n.y + 3.4}V${n.y - 3.4}L${n.x - 4} ${n.y + 3.4}z"/>${lbl}</g>`;
      }
      return `<g class="pd-n ${ns || lv}">${tip}<rect class="pd-body" x="${n.x - 8}" y="${n.y - 4}" width="16" height="8" rx="2"/><text class="pd-v" x="${n.x}" y="${n.y + 1.4}" text-anchor="middle">${ns === 'na' ? '' : esc(stateText(m || {}, v))}${m && m.unit && !ns ? ' ' + esc(m.unit) : ''}</text>${lbl}</g>`;
    }).join('');
    return `<svg class="pid" viewBox="0 0 ${W} ${H}" role="img" aria-label="Sơ đồ quy trình">${pipes}${nodes}</svg>`;
  }

  /* ---------------- lịch vận hành theo tuần (bật/tắt theo giờ) + trạng thái hiện tại */
  const hm = (t) => { const [h, m2] = String(t).split(':').map(Number); return h * 60 + (m2 || 0); };
  function bSchedule(b) {
    const now = new Date(), dow = ((now.getDay() + 6) % 7) + 1, min = now.getHours() * 60 + now.getMinutes();
    const DN = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
    return `<div class="isc"><div class="isc-h"><span></span><div class="isc-d">${DN.map((d, i) => `<em class="${i + 1 === dow ? 'today' : ''}">${d}</em>`).join('')}</div><span></span></div>` + (b.rows || []).map((r) => {
      const days = r.days || [1, 2, 3, 4, 5, 6, 7], a = hm(r.on), z = hm(r.off);
      const inWin = days.includes(dow) && (a <= z ? min >= a && min < z : min >= a || min < z);
      const live = r.metric ? val(r.metric) : null, on = live != null ? num(live) > 0 : inWin;
      const cells = DN.map((_, i) => {
        const d = i + 1, act = days.includes(d);
        const bar = act ? `<i style="left:${(a / 14.4).toFixed(1)}%;width:${(Math.max(1, (z > a ? z - a : 1440 - a + z)) / 14.4).toFixed(1)}%"></i>` : '';
        return `<div class="isc-c ${d === dow ? 'today' : ''}">${bar}${d === dow ? `<u style="left:${(min / 14.4).toFixed(1)}%"></u>` : ''}</div>`;
      }).join('');
      return `<div class="isc-r"><span>${esc(r.label)}<small>${esc(r.on)}–${esc(r.off)}</small></span><div class="isc-d">${cells}</div><b class="ichip ${on ? 'ok' : ''}"><i></i>${on ? 'BẬT' : 'Tắt'}</b></div>`;
    }).join('') + '</div>';
  }

  /* ---------------- thang máy: giếng thang, cabin theo tầng, chiều đi, cửa, tải */
  function bElevator(b) {
    const N = b.floors || 10, fm = b.floor || 'floor', ids = idsFor(b, [{ id: fm }]);
    if (!ids.length) return '<p class="muted">Chưa có thang máy nào gửi dữ liệu.</p>';
    const ruler = Array.from({ length: N }, (_, i) => `<span style="bottom:calc((100% - 30px) * ${(i / (N - 1)).toFixed(3)} + 15px)">${i + 1}</span>`).join('');   // cùng công thức với tâm cabin
    return `<div class="iel"><div class="iel-r"><div class="iel-shaft">${ruler}</div></div>` + ids.map((id) => {
      const r = devs.get(id), f = num(r.v[fm]) ?? 1, prev = r.pf ?? f; r.pf = f;
      if (Math.abs(f - prev) > 0.01) { r.dir = f > prev ? 1 : -1; r.dirT = Date.now(); } else if (r.dirT == null || Date.now() - r.dirT > 4000) r.dir = 0;
      const door = num(r.v[b.door || 'door']) > 0, load = num(r.v[b.load || 'load']), fault = num(r.v[b.fault || 'fault']) > 0;
      const pos = ((Math.max(1, Math.min(N, f)) - 1) / (N - 1)) * 100;
      return `<div class="iel-c ${fault ? 'bad' : ''}"><div class="iel-shaft"><div class="iel-cab ${door ? 'open' : ''}" style="bottom:calc((100% - 30px) * ${(pos / 100).toFixed(3)})"></div></div>`
        + `<b>${esc(titleOf(id))}</b><div class="iel-s"><span class="iel-f">${Math.round(f)}</span><span>${fault ? '▲ Lỗi' : r.dir > 0 ? '▲ Lên' : r.dir < 0 ? '▼ Xuống' : '■ Đứng'}</span></div>`
        + `<small>Cửa: ${door ? 'Mở' : 'Đóng'}${load != null ? ' · Tải ' + Math.round(load) + '%' : ''}</small></div>`;
    }).join('') + '</div>';
  }

  /* ---------------- bản đồ phương tiện (không cần nền bản đồ trực tuyến): vị trí, vệt đường đi, màu theo trạng thái */
  const trail = (rec, la, lo) => {
    const a = num(rec.v[la]), o = num(rec.v[lo]); if (a == null || o == null) return;
    const t = rec.trail || (rec.trail = []), l = t[t.length - 1];
    if (!l || l[0] !== a || l[1] !== o) { t.push([a, o]); if (t.length > 60) t.shift(); }
  };
  function bMap(b) {
    const la = b.lat || 'lat', lo = b.lon || 'lon', st = b.state ? mget(b.state) : null, sp = b.speed ? mget(b.speed) : null;
    const ids = [...devs.keys()].filter((id) => num(devs.get(id).v[la]) != null && num(devs.get(id).v[lo]) != null);
    if (!ids.length) return '<p class="muted">Chưa có xe nào gửi vị trí (field lat, lon).</p>';
    for (const id of ids) trail(devs.get(id), la, lo);
    const pts = ids.flatMap((id) => devs.get(id).trail || []);
    let a0 = Math.min(...pts.map((p) => p[0])), a1 = Math.max(...pts.map((p) => p[0])), o0 = Math.min(...pts.map((p) => p[1])), o1 = Math.max(...pts.map((p) => p[1]));
    const pa = Math.max(0.002, (a1 - a0) * 0.18), po = Math.max(0.002, (o1 - o0) * 0.18); a0 -= pa; a1 += pa; o0 -= po; o1 += po;
    const W = 300, H = 190, k = Math.cos(((a0 + a1) / 2) * Math.PI / 180), sx = (o1 - o0) * k, sy = a1 - a0, sc = Math.min(W / sx, H / sy);
    const ox = (W - sx * sc) / 2, oy = (H - sy * sc) / 2;
    const X = (o) => (ox + (o - o0) * k * sc).toFixed(1), Y = (a) => (oy + (a1 - a) * sc).toFixed(1);
    let grid = ''; for (let i = 1; i < 6; i++) grid += `<path class="mp-g" d="M${(W / 6) * i} 0V${H}M0 ${(H / 6) * i}H${W}"/>`;
    const cars = ids.map((id) => {
      const r = devs.get(id), p = r.trail[r.trail.length - 1], sv = st ? own(r, st) : null, lv = st ? stateLevel(st, sv) : 'ok', spd = sp ? own(r, sp) : null;
      const line = r.trail.length > 1 ? `<path class="mp-tr ${lv}" d="M${r.trail.map((q) => X(q[1]) + ' ' + Y(q[0])).join('L')}"/>` : '';
      return line + `<g class="mp-c ${lv}"><circle cx="${X(p[1])}" cy="${Y(p[0])}" r="5"/><text class="mp-n" x="${X(p[1])}" y="${(+Y(p[0]) - 8).toFixed(1)}" text-anchor="middle">${esc(titleOf(id))}${spd != null ? ' · ' + Math.round(spd) + ' km/h' : ''}</text></g>`;
    }).join('');
    return `<svg class="map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bản đồ"><rect class="mp-bg" width="${W}" height="${H}" rx="6"/>${grid}${cars}<text class="mp-north" x="${W - 14}" y="16" text-anchor="middle">B ↑</text></svg>`;
  }



  /* ---------------- bảng Andon: ô lớn theo trạng thái từng máy/chuyền (nhìn từ xa), nhấp nháy khi lỗi */
  function bAndon(b) {
    const st = mget(b.state), vm = b.value ? mget(b.value) : null;
    const ids = idsFor(b, [st, vm]);
    if (!ids.length) return '<p class="muted">Chưa có máy nào gửi dữ liệu.</p>';
    return `<div class="iad">` + ids.map((id) => {
      const r = devs.get(id), v = own(r, st), lv = stateLevel(st, v) || 'off', off = Date.now() - r.ts > STALE_MS;
      return `<div class="iad-t ${off ? '' : lv}"><b>${esc(titleOf(id))}</b><span>${off ? 'Mất liên lạc' : esc(stateText(st, v))}</span>${vm ? `<em>${esc(stateText(vm, own(r, vm)))}<small> ${esc(vm.unit || '')}</small></em>` : ''}</div>`;
    }).join('') + '</div>';
  }

  /* ---------------- kế hoạch so với thực tế (thanh tiến độ có vạch mục tiêu) */
  function bProgress(b) {
    return `<div class="ipg">` + (b.items || []).map((it) => {
      const a = mget(it.actual), v = val(it.actual), t = it.target ? (M[it.target] ? val(it.target) : num(it.target)) : null;
      const f = v != null && t ? Math.min(1.5, v / t) : 0, cls = f >= 1 ? 'ok' : f >= 0.6 ? '' : 'warn';
      return `<div class="ipg-r ${cls}"><div class="ipg-h"><span>${esc(it.label || a.label)}</span><b>${esc(stateText(a, v))}${t ? ' / ' + esc(fmt(t, a.dec)) : ''} ${esc(a.unit || '')}</b></div>`
        + `<div class="ipg-t"><div style="width:${Math.min(100, f * 100).toFixed(1)}%"></div><u style="left:${Math.min(100, 100 / Math.max(1.0001, 1.0001)).toFixed(0)}%"></u></div><small>${t ? (f * 100).toFixed(0) + '% kế hoạch' : ''}</small></div>`;
    }).join('') + '</div>';
  }

  /* ---------------- la bàn hướng gió + tốc độ */
  function bWind(b) {
    const d = val(b.dir), s = b.speed ? val(b.speed) : null, sm = b.speed ? mget(b.speed) : null, ang = d == null ? 0 : d;
    const ticks = ['B', 'Đ', 'N', 'T'].map((t, i) => `<text x="${[50, 92, 50, 8][i]}" y="${[12, 54, 96, 54][i]}" text-anchor="middle">${t}</text>`).join('');
    return `<div class="iwd"><svg viewBox="0 0 100 100"><circle class="iwd-c" cx="50" cy="50" r="38"/>${ticks}<g style="transform:rotate(${ang}deg);transform-origin:50px 50px"><path class="iwd-a" d="M50 18L58 54L50 48L42 54z"/></g></svg>`
      + `<div><b>${s == null ? '—' : esc(fmt(s, sm.dec))}</b> <small>${esc(sm?.unit || '')}</small><span>Hướng ${d == null ? '—' : Math.round(d) + '°'}</span></div></div>`;
  }


  const BLOCK = { kpis: bKpis, gauges: bGauges, tank: bTank, tanks: bTanks, state: bState, bars: bBars, trend: bTrend, tiles: bTiles, line: bLine, ring: bRing, alarms: bAlarms, plan: bPlan, pid: bPid, schedule: bSchedule, elevator: bElevator, map: bMap, andon: bAndon, progress: bProgress, wind: bWind };
  const renderBlocks = (blocks) => (blocks || []).map((b) => {
    let h = ''; try { h = BLOCK[b.type] ? BLOCK[b.type](b) : ''; } catch (e) { console.warn('industry', b.type, e); }
    return `<section class="ib-blk b-${esc(b.type)}${b.span ? ' span' : ''}">${b.title ? `<h3>${esc(b.title)}</h3>` : ''}${h}</section>`;
  }).join('');


  /* ------------------------------------------------------------------ yêu cầu bắt buộc của gateway cho giải pháp này */
  function missingReq() {
    const out = [];
    for (const r of S.required || []) {
      if (r.startsWith('key:')) {
        const k = r.slice(4).toLowerCase();
        if (![...devs.values()].some((d) => num(d.v[k]) != null)) out.push({ id: r, label: k, key: k });
      } else if (M[r] && val(r) == null) out.push({ id: r, label: M[r].label, key: keyList(M[r]).map((x) => x[0]).join(' / ') });
    }
    return out;
  }
  function reqBox() {
    if (!(S.required || []).length || !devs.size) return '';
    const miss = missingReq();
    if (!miss.length) return '';
    return `<div class="ireq"><b>▲ Thiếu dữ liệu bắt buộc từ gateway</b><ul>${miss.map((x) => `<li>${esc(x.label)} <code>${esc(x.key)}</code></li>`).join('')}</ul>`
      + `<small>${esc(S.why || '')} Khai báo các field này ở gateway (file gateway/setup.json của giải pháp).</small></div>`;
  }
  function reqList() {
    const req = S.required || [];
    if (!req.length) return '';
    const miss = new Set(missingReq().map((x) => x.id));
    return `<h3 class="ib-sub">Field gateway bắt buộc cho giao diện này</h3><div class="ireq-l">${req.map((r) => {
      const label = r.startsWith('key:') ? r.slice(4) : (M[r]?.label || r), key = r.startsWith('key:') ? r.slice(4) : keyList(M[r] || { id: r }).map((x) => x[0]).join(' / ');
      const ok = devs.size && !miss.has(r);
      return `<span class="ichip ${ok ? 'ok' : devs.size ? 'bad' : ''}"><i></i>${esc(label)} <code>${esc(key)}</code></span>`;
    }).join('')}</div><p class="muted">${esc(S.why || '')}</p>`;
  }

  /* ------------------------------------------------------------------ tổng quan */

  const card = document.createElement('div');
  card.id = 'ind-card';
  card.innerHTML = `<h2><span class="ind-ic">${svgI(S.icon)}</span>${esc(S.heading || S.title)}<span class="st" id="ind-st">Chờ dữ liệu…</span></h2><div id="ind-body"></div>`;
  dash.insertBefore(card, (!HL && document.getElementById('gw-tabs')?.nextSibling) || dash.firstChild);   // dưới thanh tab gateway (nếu có)

  function drawOverview() {
    // MỘT gateway = MỘT giao diện, GỘP trong một mục (giống GatewayApp): mọi tab của giải pháp vẽ liền dưới phần tổng quan, không tách tab riêng
    // khối trùng khi gộp (cảnh báo ở cả tổng quan lẫn tab An toàn, hai trend cùng một chỉ số…) chỉ vẽ một lần — giống GatewayApp
    const seen = new Set();
    const uniq = (bl) => (bl || []).filter((b) => { const k = b.type === 'alarms' ? 'alarms' : b.type === 'trend' ? 'trend:' + b.metric : JSON.stringify(b); return !seen.has(k) && seen.add(k); });
    $('#ind-body').innerHTML = reqBox() + renderBlocks(uniq(S.overview))
      + (S.tabs || []).map((t) => { const bl = uniq(t.blocks); return bl.length ? `<h3 class="ib-sub" style="margin-top:18px">${svgI(t.icon)}${esc(t.title || t.label)}</h3>${renderBlocks(bl)}` : ''; }).join('');
    const st = $('#ind-st'), fresh = lastTs && Date.now() - lastTs < STALE_MS * 2, n = active().length;
    st.textContent = !lastTs ? 'Chờ dữ liệu…' : !fresh ? '▲ Mất liên lạc' : n ? `▲ ${n} cảnh báo` : '● Trực tuyến';
    st.className = 'st ' + (!lastTs ? '' : !fresh ? 'stale' : n ? 'warn' : 'live');
  }

  /* ------------------------------------------------------------------ tab theo ngành + Thiết bị + Cảnh báo */
  const MINE = {};
  const mkTab = (id, html) => { const s = document.createElement('section'); s.id = 'tab-' + id; s.className = 'tab ind-tab'; s.hidden = true; s.innerHTML = html; main.appendChild(s); MINE[id] = s; return s; };
  const setBtn = nav.querySelector('button[data-tab="set"]');
  const btns = {};
  const mkBtn = (id, label, icon) => {
    const b = document.createElement('button');
    b.dataset.tab = id; b.innerHTML = `${svgI(icon)}<span>${esc(label)}</span>`;
    nav.insertBefore(b, setBtn); btns[id] = b;
    b.onclick = () => showMine(id);
  };
  mkTab('devs', '<div class="panel"><div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">Thiết bị</h2><button id="dv-add" class="primary fit">＋ Thêm thiết bị</button></div><div id="dv-sum" class="ik-grid c3"></div><div id="dv-list" class="dv-list"></div><div id="dv-req"></div></div>');
  mkBtn('devs', 'Thiết bị', 'device');
  mkTab('alm', '<div class="panel"><h2>Cảnh báo</h2><div id="alm-act"></div><h3 class="ib-sub">Nhật ký (phiên này)</h3><div id="alm-log"></div></div>');
  mkBtn('alm', 'Cảnh báo', 'bell');
  drawBadge(); announce();
  $('#dv-add').onclick = () => { if (window.DevicesUi?.openModal) window.DevicesUi.openModal(); };

  const LABEL = {}; for (const m of Object.values(M)) for (const [k] of keyList(m)) LABEL[k] = m;
  function drawDevices() {
    const listed = new Map();
    for (const d of (window.DevicesUi?.getDashboard?.()?.devices || [])) if (!GW || d.gw?.base === GW) listed.set(d.childId, d);
    const ids = new Set([...listed.keys(), ...devs.keys()]), now = Date.now();
    let online = 0, bad = 0;
    const rows = [...ids].map((id) => {
      const rec = devs.get(id), meta = listed.get(id), v = rec?.v || {};
      const on = !!rec && (now - rec.ts < STALE_MS);
      const faults = Object.entries(v).some(([k, x]) => /^(fault|alarm|err|error)/i.test(k) && Number(x) > 0);
      const lvBad = Object.keys(v).some((k) => LABEL[k] && level(LABEL[k], own(rec, LABEL[k])) === 'bad');
      if (on) online++; if (faults || lvBad) bad++;
      const items = Object.entries(v).filter(([k, x]) => num(x) != null && !/^(fault|alarm|err|error)/i.test(k)).slice(0, 6).map(([k, x]) => {
        const m = LABEL[k]; const n = num(x) * (m ? keyList(m).find(([kk]) => kk === k)[1] : 1);
        return `<div class="ik ${m ? level(m, n) : ''}"><span>${esc(m?.label || k)}</span><b>${esc(m ? stateText(m, n) : fmt(n))}</b> ${m ? unitOf(m) : ''}</div>`;
      }).join('');
      return `<div class="dv${faults || lvBad ? ' bad' : ''}"><div class="dv-h"><span class="dv-i">${devIcon(meta, id)}</span><div><b>${esc(meta?.title || titleOf(id))}</b><small><code>${esc(id)}</code></small></div>`
        + `<span class="dv-s ${faults || lvBad ? 'bad' : on ? 'on' : 'off'}">${faults || lvBad ? '▲ Cảnh báo' : on ? '● Trực tuyến' : '■ Chưa có dữ liệu'}</span></div>${items ? `<div class="ik-grid">${items}</div>` : ''}</div>`;
    });
    $('#dv-sum').innerHTML = `<div class="ik"><span>Thiết bị</span><b>${ids.size}</b></div><div class="ik ok"><span>Trực tuyến</span><b>${online}</b></div><div class="ik ${bad ? 'bad' : ''}"><span>Cảnh báo</span><b>${bad}</b></div>`;
    $('#dv-req').innerHTML = reqList();
    $('#dv-list').innerHTML = rows.join('') || '<p class="muted">Chưa có thiết bị. Bấm “＋ Thêm thiết bị” rồi quét mã QR trên tem của gateway.</p>';
  }
  function drawAlarms() {
    $('#alm-act').innerHTML = bAlarms();
    const t = (ts) => new Date(ts).toLocaleTimeString('vi-VN');
    $('#alm-log').innerHTML = ALM.length ? ALM.map((a) => `<div class="ial ${a.level}"><i></i><b>${esc(a.text)}</b><small>${t(a.ts)}${a.level === 'ok' ? ' · hết cảnh báo' : ''}</small></div>`).join('') : '<p class="muted">Chưa có sự kiện nào trong phiên này.</p>';
  }
  const drawTab = (id) => {
    if (id === 'devs') return drawDevices();
    if (id === 'alm') return drawAlarms();
    const t = (S.tabs || []).find((x) => x.id === id);
    if (t) $('#ind-t-' + id).innerHTML = renderBlocks(t.blocks);
  };

  function showMine(t) {
    main.querySelectorAll(':scope > .tab').forEach((s) => { s.hidden = true; });
    MINE[t].hidden = false;
    if (t === 'alm' && ST.unseen) { ST.unseen = 0; drawBadge(); announce(); }   // mở tab Cảnh báo = đã xem
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    const title = $('#title'); if (title) title.textContent = $('span', btns[t]).textContent;
    drawTab(t);
  }
  const hideMine = () => Object.values(MINE).forEach((s) => { s.hidden = true; });
  if (!HL) window.__indHide = hideMine;
  if (!HL && typeof window.showTab === 'function' && !window.showTab.__ind) {
    const orig = window.showTab;
    window.showTab = function indShowTab(t) { try { window.__indHide?.(); } catch { /* */ } return orig.apply(this, arguments); };
    window.showTab.__ind = true;
  }
  // ẩn các tab của bản cơ bản không dùng trong giải pháp này (CSS đã ẩn nút; ở đây ẩn thêm theo spec)
  const hidden = [];
  for (const t of S.hide || []) { const b = nav.querySelector(`button[data-tab="${t}"]`); if (b) { b.style.display = 'none'; hidden.push(b); } }
  // MỘT gateway = MỘT giao diện trong MỘT mục (giống GatewayApp): mục trang chính mang tên giải pháp, không còn "Thiết bị"/"Tổng quan" trùng với tab Thiết bị
  const dashSpan = HL ? null : nav.querySelector('button[data-tab="dash"] span');
  const dashOrig = dashSpan?.textContent || '';
  const solLabel = S.short || S.heading || S.title || '';
  // Field đã có ô trong sơ đồ (tên trùng khoá của chỉ số đọc trực tiếp) → khung thiết bị không lặp lại thành widget (giống GatewayApp)
  if (!HL) {
    window.__indKeys = new Set((S.metrics || []).filter((m) => !m.expr).flatMap((m) => keyList(m).map(([k]) => k)));
    document.dispatchEvent(new Event('plc-ind-keys'));
  }
  if (dashSpan && solLabel) {
    window.__indDashLabel = solLabel; dashSpan.textContent = solLabel;
    const tt = document.getElementById('title'); if (tt && nav.querySelector('button[data-tab="dash"]')?.classList.contains('on')) tt.textContent = solLabel;
  }

  /* ------------------------------------------------------------------ nạp số liệu + chế độ chạy thử */
  function ingest(p) {
    const d = p && (p.d || p.data);
    if (!d || typeof d !== 'object') return;
    const now = Date.now();
    for (const [id, o] of Object.entries(d)) {
      if (!o || typeof o !== 'object') continue;
      const rec = devs.get(id) || { v: {}, ts: 0 };
      for (const [k, v] of Object.entries(o)) rec.v[k.toLowerCase()] = v;
      rec.ts = now; devs.set(id, rec);
    }
    lastTs = now;
  }
  function redraw() {
    drawOverview();
    for (const id of Object.keys(MINE)) if (!MINE[id].hidden) drawTab(id);
  }
  const handler = (p, b) => {
    if (GW && b && b !== GW) return;   // số liệu của gateway khác không thuộc giao diện này
    ingest(p); sample(Date.now()); alarmScan(Date.now()); redraw();
  };
  function hook() {
    const ui = window.DevicesUi;
    if (!ui || dead) return !!ui;
    if (!ui.__ind || !ui.__ind.set) {
      const orig = ui.onTelemetry, st = { set: new Set() };
      ui.onTelemetry = (p, b) => { for (const h of st.set) { try { h(p, b); } catch (e) { console.warn('industry', e); } } return orig(p, b); };
      ui.__ind = st;
    }
    ui.__ind.set.add(handler);
    return true;
  }
  if (!hook()) document.addEventListener('DOMContentLoaded', hook);

  const timer = setInterval(() => {
    sample(Date.now()); alarmScan(Date.now()); redraw();
  }, 1500);
  drawOverview();

  function unmount() {
    dead = true;
    clearInterval(timer);
    const ui = window.DevicesUi;
    ui?.__ind?.set?.delete(handler);
    if (!HL && window.__indHide === hideMine) window.__indHide = null;
    card.remove();
    Object.values(MINE).forEach((e) => e.remove());
    Object.values(btns).forEach((e) => e.remove());
    hidden.forEach((e) => { e.style.display = ''; });
    if (dashSpan) { window.__indDashLabel = null; dashSpan.textContent = dashOrig; }
    if (!HL) { window.__indKeys = null; document.dispatchEvent(new Event('plc-ind-keys')); }
    if (!HL) delete document.documentElement.dataset.ind;
    document.dispatchEvent(new CustomEvent('plc-ind-unseen', { detail: { base: GW, n: ST.unseen } }));
  }
  return { unmount };
}
return { mount };
})();
if (!window.PLCIOT_MULTI && window.INDUSTRY) window.IndustryEngine.mount(window.INDUSTRY);   // bản một giải pháp (cũ): tự chạy; bản nhiều gateway: sol-multi.js gắn theo tab

