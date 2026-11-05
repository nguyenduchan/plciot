namespace Plciot.Scada.Services.Ui;

/// <summary>UI contract — cùng schema với GET /api/v1/ui/dashboard (webapp).</summary>
public sealed class UiDashboardDocument
{
    public int Schema { get; set; } = 1;
    public string Version { get; set; } = "";
    public string Mode { get; set; } = "simple";
    public string? Site { get; set; }
    public string? Gateway { get; set; }
    public UiTelemetryHint? Telemetry { get; set; }
    public List<UiDevice> Devices { get; set; } = new();
    public UiLayout? Layout { get; set; }
}

public sealed class UiTelemetryHint
{
    public string? TopicBase { get; set; }
    public bool LegacyRegs { get; set; }
    public string DevicesPath { get; set; } = "d";
}

public sealed class UiDevice
{
    public string Id { get; set; } = "";
    public string ChildId { get; set; } = "";
    public string Type { get; set; } = "generic";
    public string Title { get; set; } = "";
    public UiSource? Source { get; set; }
    public List<UiWidget> Widgets { get; set; } = new();
}

public sealed class UiSource
{
    public string Path { get; set; } = "";
    public string? Map { get; set; }
}

public sealed class UiWidget
{
    public string Id { get; set; } = "";
    /// <summary>kpi|gauge|ring|sparkline|line|bar|table|chip|toggle|button|status|text</summary>
    public string Kind { get; set; } = "kpi";
    public string? Bind { get; set; }
    public string? Label { get; set; }
    public string? Unit { get; set; }
    public double? Min { get; set; }
    public double? Max { get; set; }
    public UiWidgetCmd? Cmd { get; set; }
}

public sealed class UiWidgetCmd
{
    public int? A { get; set; }
    public string? Key { get; set; }
    public int? On { get; set; }
    public int? Off { get; set; }
}

public sealed class UiLayout
{
    public UiSimpleLayout? Simple { get; set; }
    public UiProLayout? Pro { get; set; }
}

public sealed class UiSimpleLayout
{
    public int Columns { get; set; } = 2;
    public List<string> Order { get; set; } = new();
}

public sealed class UiProLayout
{
    public List<UiGridItem> Grid { get; set; } = new();
}

public sealed class UiGridItem
{
    public string DeviceId { get; set; } = "";
    public int X { get; set; }
    public int Y { get; set; }
    public int W { get; set; } = 4;
    public int H { get; set; } = 2;
}
