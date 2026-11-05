using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Plciot.Scada.Services.Ui;

/**
 * E2E C#: thêm QR mọi type qua UI contract (cùng API webapp).
 *
 *   # Terminal 1:
 *   cd cloud/app && node scripts/e2e-add-devices-qr.js --serve
 *   # Terminal 2:
 *   dotnet run --project tools/CsUiQrE2e -- --session tools/sample-qrs/e2e-session.json
 *
 *   # Hoặc tự chạy add lại từ thư mục QR (server đã seed hardware):
 *   dotnet run --project tools/CsUiQrE2e -- --base http://127.0.0.1:3099 --token <jwt> --qr-dir tools/sample-qrs --fresh
 */
var cli = Args.Parse(Environment.GetCommandLineArgs().Skip(1).ToArray());

string baseUrl = cli.Base ?? "http://127.0.0.1:3099";
string? token = cli.Token;
string qrDir = Path.GetFullPath(cli.QrDir ?? Path.Combine("tools", "sample-qrs"));

if (!string.IsNullOrEmpty(cli.Session))
{
    var ses = JsonSerializer.Deserialize<SessionFile>(File.ReadAllText(cli.Session),
        new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
        ?? throw new Exception("bad session file");
    baseUrl = ses.Base ?? baseUrl;
    token = ses.Token;
}

if (string.IsNullOrEmpty(token))
{
    Console.Error.WriteLine("Cần --token hoặc --session e2e-session.json");
    return 1;
}

using var http = new HttpClient { BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/") };
http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
var client = new UiDashboardClient(http);
client.SetBearer(token);

Console.WriteLine($"C# UI QR E2E → {baseUrl}");
var schema = await client.GetSchemaAsync();
Console.WriteLine($"schema kinds ok={schema.ValueKind == JsonValueKind.Object}");

if (cli.Fresh)
{
    var before = await client.GetDashboardAsync("simple");
    Console.WriteLine($"dashboard trước: {before?.Devices.Count ?? 0} devices");
}

var indexPath = Path.Combine(qrDir, "index.json");
List<string> files;
if (File.Exists(indexPath))
{
    using var doc = JsonDocument.Parse(File.ReadAllText(indexPath));
    var items = doc.RootElement.TryGetProperty("items", out var arr) ? arr.EnumerateArray()
        : doc.RootElement.EnumerateArray();
    files = items
        .Select(i => Path.Combine(qrDir, i.GetProperty("file").GetString()!))
        .Where(File.Exists)
        .Where(f => cli.IncludeHub || !Path.GetFileName(f).Contains("gw01", StringComparison.OrdinalIgnoreCase))
        .Distinct()
        .OrderBy(f => f)
        .ToList();
}
else
{
    files = Directory.GetFiles(qrDir, "demo_home_*.txt")
        .Where(f => cli.IncludeHub || !Path.GetFileName(f).Contains("gw01", StringComparison.OrdinalIgnoreCase))
        .OrderBy(f => f)
        .ToList();
}

var fail = 0;
foreach (var file in files)
{
    var qr = File.ReadAllText(file).Trim();
    var name = Path.GetFileName(file);
    using var resp = await client.AddDeviceFromQrAsync(qr);
    var body = await resp.Content.ReadAsStringAsync();
    if (!resp.IsSuccessStatusCode)
    {
        Console.WriteLine($"FAIL add {name}: {(int)resp.StatusCode} {body}");
        fail++;
        continue;
    }
    Console.WriteLine($"ok add {name}");
}

var dash = await client.GetDashboardAsync("simple")
    ?? throw new Exception("dashboard null");
Console.WriteLine($"dashboard: {dash.Devices.Count} devices, mode={dash.Mode}, site={dash.Site}");

foreach (var d in dash.Devices)
{
    if (d.Widgets.Count == 0)
    {
        Console.WriteLine($"FAIL {d.ChildId} no widgets");
        fail++;
    }
    else
    {
        Console.WriteLine($"  {d.Type}/{d.ChildId}: {d.Widgets.Count} widgets (kinds: {string.Join(',', d.Widgets.Select(w => w.Kind))})");
    }
}

var types = dash.Devices.Select(d => d.Type).ToHashSet();
foreach (var need in new[] { "env", "pump", "switch", "relay", "di", "do", "motor", "energy", "tank", "conveyor", "generic" })
{
    if (!types.Contains(need))
    {
        // Có thể thiếu nếu chưa gen file — chỉ cảnh báo
        Console.WriteLine($"WARN missing type on dashboard: {need}");
    }
}

if (fail > 0)
{
    Console.WriteLine($"C# E2E FAILED ({fail})");
    return 1;
}
Console.WriteLine("=== C# UI QR E2E: PASS ===");
return 0;

sealed class SessionFile
{
    public string? Base { get; set; }
    public string? Token { get; set; }
}

sealed class Args
{
    public string? Base { get; init; }
    public string? Token { get; init; }
    public string? Session { get; init; }
    public string? QrDir { get; init; }
    public bool Fresh { get; init; }
    public bool IncludeHub { get; init; }

    public static Args Parse(string[] a)
    {
        string? Get(string name)
        {
            var i = Array.IndexOf(a, name);
            return i >= 0 && i + 1 < a.Length ? a[i + 1] : null;
        }
        return new Args
        {
            Base = Get("--base"),
            Token = Get("--token"),
            Session = Get("--session"),
            QrDir = Get("--qr-dir"),
            Fresh = a.Contains("--fresh"),
            IncludeHub = a.Contains("--hub"),
        };
    }
}
