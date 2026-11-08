namespace GatewayApp.Ui;

/// <summary>Áp màu tối cho các control chuẩn của WinForms.</summary>
static class Skin
{
    public static void Grid(DataGridView g)
    {
        g.BackgroundColor = Theme.Panel; g.BorderStyle = BorderStyle.None; g.GridColor = Theme.Border;
        g.EnableHeadersVisualStyles = false; g.RowHeadersVisible = false; g.AllowUserToAddRows = false; g.AllowUserToResizeRows = false;
        g.ColumnHeadersBorderStyle = DataGridViewHeaderBorderStyle.None; g.CellBorderStyle = DataGridViewCellBorderStyle.SingleHorizontal;
        g.ColumnHeadersDefaultCellStyle = new DataGridViewCellStyle { BackColor = Theme.Panel2, ForeColor = Theme.Muted, Font = Theme.Semi, SelectionBackColor = Theme.Panel2, Padding = new Padding(6, 0, 0, 0) };
        g.ColumnHeadersHeight = 34; g.ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.DisableResizing;
        g.DefaultCellStyle = new DataGridViewCellStyle { BackColor = Theme.Panel, ForeColor = Theme.Text, Font = Theme.Normal, SelectionBackColor = Color.FromArgb(60, Theme.Accent), SelectionForeColor = Color.White, Padding = new Padding(6, 0, 0, 0) };
        g.AlternatingRowsDefaultCellStyle = new DataGridViewCellStyle { BackColor = Color.FromArgb(28, 31, 36) };
        g.RowTemplate.Height = 32; g.ReadOnly = true; g.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
    }

    public static void Input(Control c)
    {
        c.BackColor = Theme.Panel2; c.ForeColor = Theme.Text; c.Font = Theme.Normal;
        switch (c)
        {
            case TextBox t: t.BorderStyle = BorderStyle.FixedSingle; break;
            case ComboBox cb: cb.FlatStyle = FlatStyle.Flat; break;
            case NumericUpDown n: n.BorderStyle = BorderStyle.FixedSingle; break;
        }
    }

    public static Label Lbl(string text, bool muted = true) => new()
    {
        Text = text, AutoSize = true, ForeColor = muted ? Theme.Muted : Theme.Text, Font = Theme.Normal, BackColor = Color.Transparent, Anchor = AnchorStyles.Left,
    };
}
