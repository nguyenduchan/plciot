using GatewayApp.Ui;

namespace GatewayApp;

/// <summary>Chọn vai trò của board Waveshare: hai lựa chọn dạng selector (radio) kèm mô tả, Lưu / Huỷ.</summary>
sealed class ModeDialog : Form
{
    readonly RadioButton _alone = new() { Text = "Gateway độc lập", AutoSize = true, Font = Theme.Semi, ForeColor = Theme.Text };
    readonly RadioButton _slave = new() { Text = "Slave của gateway C#", AutoSize = true, Font = Theme.Semi, ForeColor = Theme.Text };
    public bool Standalone => _alone.Checked;

    ModeDialog(bool standalone, string host)
    {
        Text = "Chế độ của board Waveshare"; StartPosition = FormStartPosition.CenterParent; FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = MinimizeBox = false; ShowInTaskbar = false;
        BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Normal; ClientSize = new Size(560, 330);
        Label Desc(string t, int y) => new() { Text = t, Location = new Point(48, y), Size = new Size(490, 62), ForeColor = Theme.Muted, UseMnemonic = false };
        var head = new Label { Text = $"Board {host} hoạt động như thế nào?", Location = new Point(20, 16), AutoSize = true, Font = Theme.Semi, UseMnemonic = false };
        _alone.Location = new Point(24, 58); _slave.Location = new Point(24, 156);
        _alone.Checked = standalone; _slave.Checked = !standalone;
        var d1 = Desc("Board tự đọc thiết bị và tự nối lên server (cần Wi-Fi/Ethernet có Internet). Gateway C# chỉ là chương trình nối vào board để cài đặt và xem, không nối lên server thay board.", 82);
        var d2 = Desc("Gateway C# trên PC này đọc board bằng Modbus TCP (cần thêm thiết bị trỏ tới IP board) và là đường báo lên server duy nhất. Board tạm dừng nối cloud.", 180);
        var ok = new FlatButton { Caption = "Lưu", Primary = true, Width = 110, Location = new Point(320, 272) };
        var cancel = new FlatButton { Caption = "Huỷ", Width = 90, Location = new Point(440, 272) };
        ok.Click += (_, _) => { DialogResult = DialogResult.OK; Close(); };
        cancel.Click += (_, _) => { DialogResult = DialogResult.Cancel; Close(); };
        Controls.AddRange(new Control[] { head, _alone, d1, _slave, d2, ok, cancel });
        AcceptButton = null;
    }

    /// <summary>null = huỷ; true = độc lập; false = slave.</summary>
    public static bool? Choose(IWin32Window owner, bool standalone, string host)
    {
        using var d = new ModeDialog(standalone, host);
        return d.ShowDialog(owner) == DialogResult.OK ? d.Standalone : null;
    }
}
