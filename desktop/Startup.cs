using System;
using System.IO;
using Microsoft.Win32;

namespace SpideyHang;

/// <summary>
/// Starting with Windows: a value in the current user's Run key, which Windows reads at sign-in.
/// Points at the shared app copy (%USERPROFILE%\.spidey-hang\app), whose path never changes with updates.
///
/// Only a write from a normal process counts. A process started by an app installed from the
/// Microsoft Store (an MSIX package, such as the Claude desktop app) has its registry writes
/// silently redirected to a private copy that Windows never reads at sign-in. So the entry is
/// written when the user starts Spidey, and by the VS Code extension (--sync-startup).
/// </summary>
internal static class Startup
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "Spidey Hang";

    /// <summary>The command Windows runs at sign-in.</summary>
    public static string Command
    {
        get
        {
            string shared = Path.Combine(Settings.Folder, "app", "SpideyHang.exe");
            string exe = File.Exists(shared) ? shared : Environment.ProcessPath ?? shared;
            return $"\"{exe}\" --at-login";
        }
    }

    /// <summary>Adds, corrects or removes the Run value to match the setting. Logs only real changes.</summary>
    public static void Sync(bool on)
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKey, writable: true);
            string? current = key.GetValue(ValueName) as string;
            if (on)
            {
                string wanted = Command;
                if (!string.Equals(current, wanted, StringComparison.OrdinalIgnoreCase))
                {
                    key.SetValue(ValueName, wanted, RegistryValueKind.String);
                    Log.Write($"Start automatically: on. Windows will run {wanted} at sign-in.");
                }
            }
            else if (current != null)
            {
                key.DeleteValue(ValueName, throwOnMissingValue: false);
                Log.Write("Start automatically: off. Removed from Windows sign-in.");
            }
        }
        catch (Exception ex)
        {
            Log.Write("Could not change starting with Windows: " + ex.Message);
        }
    }
}
