namespace GatewayApp.Ui;

/// <summary>Hỏi xác nhận trước thao tác không hoàn tác được. Mặc định chọn "Không" để lỡ bấm Enter cũng không xoá.</summary>
static class Ask
{
    /// <summary>Chỉ dùng trong --selftest để trả lời thay người dùng.</summary>
    public static bool? Override;

    public static bool Yes(IWin32Window? owner, string text, string title)
    {
        if (Override.HasValue) return Override.Value;
        return MessageBox.Show(owner, text, title, MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) == DialogResult.Yes;
    }
}
