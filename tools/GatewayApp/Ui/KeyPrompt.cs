namespace GatewayApp.Ui;

/// <summary>Hộp thoại nhỏ: hiện một khoá (chỉ xem, có nút sao chép) hoặc nhập khoá.</summary>
static class KeyPrompt
{
    /// <summary>Hỏi khoá khôi phục. Trả null nếu huỷ.</summary>
    public static string? Ask(IWin32Window? owner, string title, string text)
    {
        using var f = Base(title, text, out var box, out var ok);
        box.ReadOnly = false;
        return f.ShowDialog(owner) == DialogResult.OK ? box.Text.Trim() : null;
    }

    /// <summary>Hiện khoá để người dùng cất; đã tự chép vào clipboard.</summary>
    public static void Show(IWin32Window? owner, string title, string text, string key)
    {
        using var f = Base(title, text, out var box, out var ok);
        box.Text = key; box.ReadOnly = true; box.Font = new Font("Consolas", 16f, FontStyle.Bold);
        try { Clipboard.SetText(key); } catch { }
        f.ShowDialog(owner);
    }

    static Form Base(string title, string text, out TextBox box, out Button ok)
    {
        var f = new Form { Text = title, StartPosition = FormStartPosition.CenterParent, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false, ClientSize = new Size(560, 230), BackColor = Theme.Bg, ForeColor = Theme.Text, Font = Theme.Normal };
        var lbl = new Label { Text = text, Left = 16, Top = 14, Width = 528, Height = 100, ForeColor = Theme.Text };
        box = new TextBox { Left = 16, Top = 120, Width = 528, Font = new Font("Consolas", 14f), TextAlign = HorizontalAlignment.Center };
        ok = new Button { Text = "OK", Left = 360, Top = 180, Width = 90, DialogResult = DialogResult.OK };
        var cancel = new Button { Text = "Huỷ", Left = 456, Top = 180, Width = 88, DialogResult = DialogResult.Cancel };
        f.Controls.AddRange(new Control[] { lbl, box, ok, cancel });
        f.AcceptButton = ok; f.CancelButton = cancel;
        return f;
    }
}
