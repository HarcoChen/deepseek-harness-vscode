using System;
using System.Diagnostics;
using System.IO;
using System.Text;
class DshShim {
    static int Main(string[] args) {
        foreach (var a in args) {
            if (a == "--version") { Console.WriteLine("0.1.5-rc.1"); return 0; }
        }
        var dir = AppDomain.CurrentDomain.BaseDirectory;
        var psi = new ProcessStartInfo(Environment.GetEnvironmentVariable("DSH_SHIM_NODE"),
            "\"" + Path.Combine(dir, "fake-dsh.cjs") + "\" " + JoinArgs(args));
        psi.UseShellExecute = false;
        var p = Process.Start(psi);
        p.WaitForExit();
        return p.ExitCode;
    }
    static string JoinArgs(string[] args) {
        var sb = new StringBuilder();
        foreach (var a in args) { sb.Append('"'); sb.Append(a.Replace("\"", "\\\"")); sb.Append('"'); sb.Append(' '); }
        return sb.ToString();
    }
}
