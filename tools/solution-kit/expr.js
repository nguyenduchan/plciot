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
