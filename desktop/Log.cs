using System;
using System.IO;

namespace SpideyHang;

/// <summary>
/// Appends to %USERPROFILE%\.spidey-hang\log.txt. Check this first when he misbehaves.
/// The overlay has no console and no window chrome, so this is the only record of what went wrong.
/// Starts over once the file passes 256 KB.
/// </summary>
internal static class Log
{
    private const long MaxBytes = 256 * 1024;

    private static readonly string FilePath = Path.Combine(Settings.Folder, "log.txt");

    public static void Write(string message)
    {
        try
        {
            Directory.CreateDirectory(Settings.Folder);
            var info = new FileInfo(FilePath);
            if (info.Exists && info.Length > MaxBytes)
            {
                info.Delete();
            }
            File.AppendAllText(FilePath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss}  {message}{Environment.NewLine}");
        }
        catch (Exception)
        {
            // Logging must never crash the overlay.
        }
    }
}
