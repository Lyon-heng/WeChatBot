# 界面探测：列出微信的顶层窗口，并把朋友圈窗口的 UIA 控件树导出来。
# 只读：不点击、不输入、不改任何东西。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$src = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class W {
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

    public static List<string> Rows = new List<string>();
    public static void Scan() {
        Rows.Clear();
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            if (!IsWindowVisible(h)) return true;
            int len = GetWindowTextLength(h);
            var title = new StringBuilder(512);
            GetWindowText(h, title, 512);
            var cls = new StringBuilder(256);
            GetClassName(h, cls, 256);
            uint pid; GetWindowThreadProcessId(h, out pid);
            string proc = "";
            try { proc = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}
            if (!proc.StartsWith("Weixin") && !proc.StartsWith("wechat")) return true;
            RECT r; GetWindowRect(h, out r);
            Rows.Add(string.Format("{0}|{1}|{2}|{3}|{4},{5},{6},{7}", h.ToInt64(), proc, cls.ToString(), title.ToString(), r.L, r.T, r.R, r.B));
            return true;
        }, IntPtr.Zero);
    }
}
'@
Add-Type -TypeDefinition $src -ReferencedAssemblies 'System.dll'

[W]::Scan()
$rows = [W]::Rows
Write-Output "=== 微信顶层窗口（可见）: $($rows.Count) 个 ==="
foreach ($r in $rows) {
    $p = $r.Split('|')
    $hwnd = [int64]$p[0]
    Write-Output ("hwnd=0x{0:X}  proc={1}  class={2}  title={3}  rect={4}" -f $hwnd, $p[1], $p[2], $p[3], $p[4])
}
Write-Output ""

$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
Write-Output "=== UIA 顶层窗口: $($wins.Count) 个 ==="
foreach ($w in $wins) {
    try {
        $n = $w.Current.Name
        $cn = $w.Current.ClassName
        $pid = $w.Current.ProcessId
        $pn = (Get-Process -Id $pid -ErrorAction SilentlyContinue).ProcessName
        if ($pn -notmatch 'Weixin|wechat') { continue }
        $rect = $w.Current.BoundingRectangle
        Write-Output ("[{0}] name='{1}' class='{2}' pid={3} rect={4},{5},{6},{7}" -f $pn, $n, $cn, $pid, [int]$rect.X, [int]$rect.Y, [int]$rect.Width, [int]$rect.Height)
    } catch {}
}
Write-Output ""

# 对每个微信窗口导出控件树（深度 4）
function Dump-Tree($el, $depth, $maxDepth) {
    if ($depth -gt $maxDepth) { return }
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $child = $walker.GetFirstChild($el)
    while ($child -ne $null) {
        try {
            $c = $child.Current
            $rect = $c.BoundingRectangle
            $pad = ' ' * ($depth * 2)
            Write-Output ("{0}- type={1} name='{2}' autoId='{3}' class='{4}' rect={5},{6},{7},{8} enabled={9}" -f `
                $pad, $c.ControlType.ProgrammaticName.Replace('ControlType.',''), $c.Name, $c.AutomationId, $c.ClassName, `
                [int]$rect.X, [int]$rect.Y, [int]$rect.Width, [int]$rect.Height, $c.IsEnabled)
        } catch {}
        Dump-Tree $child ($depth + 1) $maxDepth
        try { $child = $walker.GetNextSibling($child) } catch { $child = $null }
    }
}

foreach ($w in $wins) {
    try {
        $pid2 = $w.Current.ProcessId
        $pn2 = (Get-Process -Id $pid2 -ErrorAction SilentlyContinue).ProcessName
        if ($pn2 -notmatch 'Weixin|wechat') { continue }
        Write-Output "=== 控件树: '$($w.Current.Name)' (class=$($w.Current.ClassName)) ==="
        Dump-Tree $w 1 4
        Write-Output ""
    } catch {}
}
