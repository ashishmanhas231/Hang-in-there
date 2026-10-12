using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SpideyHang;

/// <summary>
/// User choices from the tray menu. Saved to %USERPROFILE%\.spidey-hang\settings.json, next to
/// the log, the picture and the app copy that VS Code launches.
///
/// Do not move this back under %APPDATA%. Apps installed from the Microsoft Store (MSIX packages,
/// such as the Claude desktop app) have their AppData writes silently redirected to a private copy.
/// Anything such an app starts gets the same redirection. So a Spidey started from one of those
/// saw different settings, and a different picture, from a Spidey started by the user.
/// The user profile folder is not redirected, so everyone sees the same files.
/// </summary>
internal sealed class Settings
{
    private static readonly string FilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".spidey-hang", "settings.json");

    /// <summary>Where versions up to 0.4 kept their files. Copied over once if the new folder is empty.</summary>
    private static readonly string OldFolder = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "SpideyHang");

    /// <summary>Where the web is tied along the top of the screen. 0 = left edge, 1 = right edge.</summary>
    public double AnchorFraction { get; set; } = 0.88;

    /// <summary>Small, Medium or Large.</summary>
    public string Size { get; set; } = "Medium";

    /// <summary>Short, Medium or Long.</summary>
    public string Rope { get; set; } = "Medium";

    /// <summary>A light breeze that keeps him swaying. Off by default so he can go still and use no CPU.</summary>
    public bool Breeze { get; set; }

    /// <summary>Keep a steady swing going instead of settling. Uses CPU the whole time it is on.</summary>
    public bool AutoSwing { get; set; }

    /// <summary>
    /// Which hero to show: a folder name under heroes\, or one of the built-ins
    /// HeroLibrary.Drawn ("Drawn Spider-Man") and HeroLibrary.MyPicture ("My picture").
    /// </summary>
    public string Hero { get; set; } = "Spider-Man";

    /// <summary>Change to the next hero every this many minutes. 0 = never.</summary>
    public int RotateMinutes { get; set; }

    /// <summary>
    /// Start with Windows (at sign-in) and when VS Code starts. On unless switched off in the menu.
    /// The VS Code extension reads this from settings.json too, so keep the name.
    /// </summary>
    public bool StartAutomatically { get; set; } = true;

    /// <summary>
    /// Only read, to carry over the old on/off picture switch from versions before heroes.
    /// Never written back.
    /// </summary>
    [JsonPropertyName("UseImage")]
    public bool? LegacyUseImage { get; set; }

    /// <summary>The picture is upright (head at the top), so tie the web to its bottom edge instead.</summary>
    public bool FlipImage { get; set; }

    /// <summary>Our own copy of the user's picture, in the settings folder.</summary>
    public string? ImageFile { get; set; }

    [JsonIgnore]
    public static string Folder => Path.GetDirectoryName(FilePath)!;

    [JsonIgnore]
    public double BodyLength => Size switch
    {
        "Small" => 110,
        "Large" => 200,
        _ => 150,
    };

    /// <summary>Rope length as a share of the screen height.</summary>
    [JsonIgnore]
    public double RopeFraction => Rope switch
    {
        "Short" => 0.15,
        "Long" => 0.42,
        _ => 0.27,
    };

    public static Settings Load()
    {
        MoveFromOldFolder();
        try
        {
            if (File.Exists(FilePath))
            {
                string json = File.ReadAllText(FilePath);
                var loaded = JsonSerializer.Deserialize<Settings>(json) ?? new Settings();

                // Settings from before heroes existed have no "Hero". Keep what they showed:
                // their own picture if that was on, otherwise the drawn Spider-Man.
                if (!json.Contains("\"Hero\"", StringComparison.Ordinal) && loaded.LegacyUseImage is bool useImage)
                {
                    loaded.Hero = useImage ? HeroLibrary.MyPicture : HeroLibrary.Drawn;
                }
                loaded.LegacyUseImage = null;
                return loaded;
            }
        }
        catch (Exception ex)
        {
            // A broken settings file just means defaults.
            Log.Write("Settings file unreadable, using defaults. " + ex.Message);
        }
        return new Settings();
    }

    /// <summary>
    /// One-time copy from the old %APPDATA%\SpideyHang folder, only when the new folder has no settings yet.
    /// The old folder is left in place. A saved picture path that pointed into it is pointed at the copy.
    /// </summary>
    private static void MoveFromOldFolder()
    {
        try
        {
            if (File.Exists(FilePath) || !File.Exists(Path.Combine(OldFolder, "settings.json")))
            {
                return;
            }
            Directory.CreateDirectory(Folder);
            foreach (string file in Directory.GetFiles(OldFolder))
            {
                if (!Path.GetFileName(file).Equals("log.txt", StringComparison.OrdinalIgnoreCase))
                {
                    File.Copy(file, Path.Combine(Folder, Path.GetFileName(file)), overwrite: false);
                }
            }
            string oldPictures = Path.Combine(OldFolder, "pictures");
            if (Directory.Exists(oldPictures))
            {
                Directory.CreateDirectory(Path.Combine(Folder, "pictures"));
                foreach (string file in Directory.GetFiles(oldPictures))
                {
                    File.Copy(file, Path.Combine(Folder, "pictures", Path.GetFileName(file)), overwrite: false);
                }
            }

            string json = File.ReadAllText(FilePath);
            var moved = JsonSerializer.Deserialize<Settings>(json) ?? new Settings();
            if (moved.ImageFile != null && moved.ImageFile.StartsWith(OldFolder, StringComparison.OrdinalIgnoreCase))
            {
                moved.ImageFile = Path.Combine(Folder, moved.ImageFile.Substring(OldFolder.Length).TrimStart('\\', '/'));
                moved.Save();
            }
            Log.Write($"Copied settings from the old folder {OldFolder}");
        }
        catch (Exception ex)
        {
            Log.Write("Could not copy settings from the old folder. " + ex.Message);
        }
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions
            {
                WriteIndented = true,
                DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            }));
        }
        catch (Exception)
        {
            // Failing to save settings must never crash the overlay.
        }
    }
}
