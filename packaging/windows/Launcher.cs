using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

// Native GUI entry point: never starts cmd.exe or PowerShell.
internal static class Launcher {
    [STAThread]
    private static int Main(string[] args) {
        try {
            if (args.Length == 2 && args[0] == "--check-running") {
                string directory = Path.GetFullPath(args[1]).TrimEnd(Path.DirectorySeparatorChar);
                foreach (string name in new string[] { "WeChatBot", "WeChatAgent" }) {
                    foreach (Process process in Process.GetProcessesByName(name)) {
                        using (process) {
                            try {
                                if (String.Equals(Path.GetDirectoryName(process.MainModule.FileName), directory, StringComparison.OrdinalIgnoreCase)) return 10;
                            } catch (InvalidOperationException) { } // Process exited during enumeration.
                            catch (System.ComponentModel.Win32Exception) { return 11; } // Fail closed when identity cannot be checked.
                        }
                    }
                }
                return 0;
            }
            if (args.Length != 0) return 2;
            string root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string application = Path.Combine(root, "app", "WeChatBot.exe");
            if (!File.Exists(application)) throw new FileNotFoundException("未找到完整程序。请先解压整个便携包，再打开 WeChatBot.exe；不要在压缩包中直接运行。", application);
            ProcessStartInfo start = new ProcessStartInfo(application);
            start.WorkingDirectory = Path.GetDirectoryName(application);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            start.EnvironmentVariables.Remove("PSModulePath");
            Process.Start(start);
            return 0;
        } catch (Exception error) {
            MessageBox.Show(error.Message, "WeChatBot · 启动未完成", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
