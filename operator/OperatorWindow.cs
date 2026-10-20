using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using System.Web.Script.Serialization;

// Thin native view for the shared Node/SQLite control record. No game/CDP code.
public sealed class AM4OperatorWindow : Form {
    readonly Label status = new Label(), detail = new Label();
    readonly Timer timer = new Timer();
    readonly string root = AppDomain.CurrentDomain.BaseDirectory;
    readonly string node;
    bool refreshing;
    public AM4OperatorWindow() {
        Text = "AM4 Operator Control"; ClientSize = new Size(610, 270);
        FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen; TopMost = true;
        Font = new Font("Segoe UI", 10);
        node = FindNode();
        status.SetBounds(16, 14, 578, 60); status.Font = new Font("Segoe UI", 13, FontStyle.Bold); Controls.Add(status);
        detail.SetBounds(16, 78, 578, 82); Controls.Add(detail);
        AddButton("PAUSE / MANUAL", 16, "pause");
        AddButton("RESUME AUTOMATIC", 214, "automatic");
        AddButton("ENTER TESTING", 412, "testing");
        var note = new Label(); note.SetBounds(16, 216, 578, 45);
        note.Text = "Wait for green SAFE TO USE GAME before using AM4.\nPause persists; closing this window does not resume automation."; Controls.Add(note);
        timer.Interval = 750; timer.Tick += delegate { RefreshStatus(); };
        Shown += delegate { RefreshStatus(); timer.Start(); Activate(); };
        FormClosed += delegate { timer.Stop(); timer.Dispose(); };
    }
    static string FindNode() {
        foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';')) {
            try { var file = Path.Combine(directory.Trim('"'), "node.exe"); if (File.Exists(file)) return file; } catch { }
        }
        var bundled = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), @".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe");
        if (File.Exists(bundled)) return bundled;
        throw new InvalidOperationException("Node.js 24 is required on PATH.");
    }
    Dictionary<string, object> Command(string command) {
        var start = new ProcessStartInfo(node, "\"" + Path.Combine(root, "cli.mjs") + "\" " + command);
        start.UseShellExecute = false; start.CreateNoWindow = true;
        start.RedirectStandardOutput = true; start.RedirectStandardError = true;
        start.StandardOutputEncoding = System.Text.Encoding.UTF8;
        using (var process = Process.Start(start)) {
            if (!process.WaitForExit(command == "automatic" ? 15000 : 5000)) { process.Kill(); throw new InvalidOperationException("Status unavailable; do not assume interface is released."); }
            var result = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(process.StandardOutput.ReadToEnd());
            if (result == null || !result.ContainsKey("ok") || !Convert.ToBoolean(result["ok"])) throw new InvalidOperationException((result != null && result.ContainsKey("error") ? Convert.ToString(result["error"]) : "CONTROL_UNAVAILABLE") + "\nOpen AM4 Process Review.cmd for read-only process and CDP-client diagnostics.");
            return result;
        }
    }
    static string Field(Dictionary<string, object> value, string key) { object item; return value.TryGetValue(key, out item) && item != null ? Convert.ToString(item) : "None"; }
    void RefreshStatus() {
        if (refreshing) return; refreshing = true;
        try {
            var s = Command("status"); status.Text = Field(s, "display");
            status.ForeColor = Convert.ToBoolean(s["safeToUseGame"]) ? Color.DarkGreen : Color.DarkRed;
            detail.Text = "Mode: " + Field(s, "mode") + "\nActive action: " + Field(s, "activeAction") + "\nLast completed: " + Field(s, "lastCompletedAction");
            object warning; if (s.TryGetValue("uncertainty", out warning) && warning != null) detail.Text += "\nOutcome uncertainty remains - inspect the action report.";
        } catch (Exception e) { status.Text = "STATUS UNAVAILABLE - DO NOT ASSUME RELEASED"; status.ForeColor = Color.DarkRed; detail.Text = e.Message; }
        finally { refreshing = false; }
    }
    void AddButton(string text, int left, string command) {
        var button = new Button(); button.Text = text; button.SetBounds(left, 165, 182, 39);
        button.Click += delegate {
            try {
                Command(command);
                if (command == "automatic") {
                    var controller = Path.GetFullPath(Path.Combine(root, "..", "Start-AM4.ps1"));
                    var start = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -File \"" + controller + "\"");
                    start.UseShellExecute = false; start.CreateNoWindow = true; Process.Start(start);
                }
                RefreshStatus();
            } catch (Exception e) { MessageBox.Show(this, e.Message, "AM4 operator control"); }
        };
        Controls.Add(button);
    }
    [STAThread] public static void Main() {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        try { Application.Run(new AM4OperatorWindow()); } catch (Exception e) { MessageBox.Show(e.Message, "AM4 operator control"); }
    }
}
