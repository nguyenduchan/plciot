using System.Globalization;

namespace GatewayApp.Ui;

/// <summary>
/// Bộ tính công thức cho chỉ số suy diễn: tính NGAY trên gateway từ số cảm biến đã nhận, không gửi qua server.
/// Cú pháp và kết quả giống hệt bản JS của webapp (tools/solution-kit/expr.js); vector test chung: tools/solution-kit/expr-vectors.json.
/// Không dùng eval. Tham chiếu chưa có số (null) → kết quả null (trừ coalesce/isnull/if). Chia cho 0, sqrt số âm, công thức lỗi → null.
/// </summary>
public static class Expr
{
    abstract record Node;
    sealed record Num(double V) : Node;
    sealed record Null : Node;
    sealed record Var(string Name) : Node;
    sealed record Un(string Op, Node A) : Node;
    sealed record Bin(string Op, Node A, Node B) : Node;
    sealed record Fn(string Name, List<Node> Args) : Node;

    static readonly Dictionary<string, Node> Cache = new();
    static readonly string[] Ops2 = { "<=", ">=", "==", "!=", "&&", "||" };

    static List<(char K, string V)> Tokenize(string s)
    {
        var t = new List<(char, string)>(); var i = 0;
        while (i < s.Length)
        {
            var c = s[i];
            if (char.IsWhiteSpace(c)) { i++; continue; }
            if (char.IsDigit(c) || (c == '.' && i + 1 < s.Length && char.IsDigit(s[i + 1])))
            {
                var j = i; while (j < s.Length && char.IsDigit(s[j])) j++;
                if (j < s.Length && s[j] == '.') { j++; while (j < s.Length && char.IsDigit(s[j])) j++; }
                if (j < s.Length && (s[j] == 'e' || s[j] == 'E'))
                {
                    var k = j + 1; if (k < s.Length && (s[k] == '+' || s[k] == '-')) k++;
                    if (k < s.Length && char.IsDigit(s[k])) { while (k < s.Length && char.IsDigit(s[k])) k++; j = k; }
                }
                t.Add(('n', s[i..j])); i = j; continue;
            }
            if (char.IsAsciiLetter(c) || c == '_')
            {
                var j = i; while (j < s.Length && (char.IsAsciiLetterOrDigit(s[j]) || s[j] == '_')) j++;
                if (j + 1 < s.Length && s[j] == '.' && (char.IsAsciiLetter(s[j + 1]) || s[j + 1] == '_'))
                { j++; while (j < s.Length && (char.IsAsciiLetterOrDigit(s[j]) || s[j] == '_')) j++; }
                t.Add(('i', s[i..j])); i = j; continue;
            }
            if (i + 1 < s.Length && Ops2.Contains(s.Substring(i, 2))) { t.Add(('o', s.Substring(i, 2))); i += 2; continue; }
            if ("+-*/%<>!(),".Contains(c)) { t.Add(('o', c.ToString())); i++; continue; }
            throw new FormatException("ký tự lạ: " + c);
        }
        return t;
    }

    sealed class Parser
    {
        readonly List<(char K, string V)> _t; int _p;
        public Parser(List<(char, string)> t) { _t = t; }
        bool IsOp(string v) => _p < _t.Count && _t[_p].K == 'o' && _t[_p].V == v;
        void Eat(string v) { if (!IsOp(v)) throw new FormatException("thiếu " + v); _p++; }
        Node Bin(Func<Node> next, params string[] ops)
        {
            var a = next();
            while (_p < _t.Count && _t[_p].K == 'o' && ops.Contains(_t[_p].V)) { var op = _t[_p++].V; a = new Bin(op, a, next()); }
            return a;
        }
        public Node Parse() { var n = Or(); if (_p < _t.Count) throw new FormatException("thừa: " + _t[_p].V); return n; }
        Node Or() => Bin(And, "||");
        Node And() => Bin(Eq, "&&");
        Node Eq() => Bin(Cmp, "==", "!=");
        Node Cmp() => Bin(Add, "<", "<=", ">", ">=");
        Node Add() => Bin(Mul, "+", "-");
        Node Mul() => Bin(Unary, "*", "/", "%");
        Node Unary() { if (IsOp("-") || IsOp("!")) { var op = _t[_p++].V; return new Un(op, Unary()); } return Primary(); }
        Node Primary()
        {
            if (_p >= _t.Count) throw new FormatException("thiếu toán hạng");
            var (k, v) = _t[_p++];
            if (k == 'n') return new Num(double.Parse(v, CultureInfo.InvariantCulture));
            if (k == 'o' && v == "(") { var e = Or(); Eat(")"); return e; }
            if (k == 'i')
            {
                if (IsOp("("))
                {
                    _p++; var args = new List<Node>();
                    if (!IsOp(")")) { do { args.Add(Or()); } while (IsOp(",") && ++_p > 0); }
                    Eat(")"); return new Fn(v.ToLowerInvariant(), args);
                }
                return v.Equals("null", StringComparison.OrdinalIgnoreCase) ? new Null() : new Var(v);
            }
            throw new FormatException("không hiểu: " + v);
        }
    }

    static double? Fin(double x) => double.IsFinite(x) ? x : null;
    static double B(bool b) => b ? 1 : 0;

    static double? Run(Node n, Func<string, double?> get)
    {
        switch (n)
        {
            case Num x: return x.V;
            case Null: return null;
            case Var v: return get(v.Name);
            case Un u: { var a = Run(u.A, get); if (a == null) return null; return u.Op == "-" ? -a : B(a == 0); }
            case Bin b:
                {
                    var l = Run(b.A, get); var r = Run(b.B, get);
                    switch (b.Op)
                    {
                        case "&&": return B(l is not (null or 0) && r is not (null or 0));
                        case "||": return B(l is not (null or 0) || r is not (null or 0));
                        case "==": return B(l == r);
                        case "!=": return B(l != r);
                    }
                    if (l == null || r == null) return null;
                    return b.Op switch
                    {
                        "+" => l + r, "-" => l - r, "*" => l * r,
                        "/" => r == 0 ? null : l / r, "%" => r == 0 ? null : l % r,
                        "<" => B(l < r), "<=" => B(l <= r), ">" => B(l > r), ">=" => B(l >= r),
                        _ => null,
                    };
                }
            case Fn f:
                {
                    if (f.Name == "if") { var c = Run(f.Args[0], get); return c is not (null or 0) ? Run(f.Args[1], get) : f.Args.Count > 2 ? Run(f.Args[2], get) : null; }
                    if (f.Name == "coalesce") { foreach (var a in f.Args) { var v = Run(a, get); if (v != null) return v; } return null; }
                    if (f.Name == "isnull") return B(Run(f.Args[0], get) == null);
                    var xs = new List<double>();
                    foreach (var a in f.Args) { var v = Run(a, get); if (v == null) return null; xs.Add(v.Value); }
                    if (xs.Count == 0) return null;
                    return f.Name switch
                    {
                        "min" => xs.Min(), "max" => xs.Max(), "abs" => Math.Abs(xs[0]), "floor" => Math.Floor(xs[0]), "ceil" => Math.Ceiling(xs[0]),
                        "sqrt" => xs[0] < 0 ? null : Fin(Math.Sqrt(xs[0])),
                        "round" => Fin(Math.Floor(xs[0] * Math.Pow(10, xs.Count > 1 ? xs[1] : 0) + 0.5) / Math.Pow(10, xs.Count > 1 ? xs[1] : 0)),
                        "pow" => xs.Count > 1 ? Fin(Math.Pow(xs[0], xs[1])) : null,
                        "avg" => xs.Average(), "sum" => xs.Sum(),
                        "clamp" => xs.Count > 2 ? Math.Min(Math.Max(xs[0], xs[1]), xs[2]) : null,
                        _ => throw new FormatException("hàm lạ: " + f.Name),
                    };
                }
        }
        return null;
    }

    /// <summary>Tính công thức. get(tên) trả số hoặc null. Công thức lỗi → null.</summary>
    public static double? Eval(string src, Func<string, double?> get)
    {
        try
        {
            Node ast;
            lock (Cache) { if (!Cache.TryGetValue(src, out ast!)) { ast = new Parser(Tokenize(src)).Parse(); Cache[src] = ast; } }
            var r = Run(ast, get);
            return r is { } x && double.IsFinite(x) ? x : null;
        }
        catch (Exception e) when (e is FormatException or InvalidOperationException or IndexOutOfRangeException or ArgumentOutOfRangeException) { return null; }
    }

    /// <summary>Kiểm cú pháp: null nếu đúng, ngược lại thông báo lỗi.</summary>
    public static string? Check(string src)
    {
        try { new Parser(Tokenize(src)).Parse(); return null; } catch (FormatException e) { return e.Message; }
    }
}
