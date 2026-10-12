using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace SpideyHang;

/// <summary>What a hero hangs from. None means nothing is drawn, so he seems to float.</summary>
internal enum LineStyle
{
    Web,
    Cable,
    Chain,
    Lasso,
    Grapple,
    None,
}

/// <summary>
/// One hero folder under %USERPROFILE%\.spidey-hang\heroes\.
///
/// Pictures are found by file name (any case, .png .webp .gif .bmp .jpg):
///   hang     at rest or moving slowly. If missing, the first other picture in the folder is used.
///   swing    while he is moving
///   fly      when he is swung up high
///   grab     while you drag him
///   emblem   shown only when the folder has no pose pictures yet
/// Add "-flip" to a pose name (hang-flip.png) for an upright picture that should hang by its feet.
///
/// hero.json (optional):
/// {
///   "line": "web" | "cable" | "chain" | "lasso" | "grapple" | "none",
///   "moves": "ironman" | "hulk" | "captain" | "thor" | "flash" | "floater",   (runs around the screen instead of hanging)
///   "poses": { "fly": { "facesLeft": true, "scale": 1.2, "thrustAngle": 180,
///                       "points": { "thrusters": [[410, 620], [455, 640]], "palm": [[120, 300]] } } }
/// }
/// </summary>
internal sealed class HeroInfo
{
    public required string Name { get; init; }
    public required string FolderPath { get; init; }
    public LineStyle Line { get; set; } = LineStyle.Web;

    /// <summary>Pose name (hang, swing, fly, grab) to its file, and whether it hangs by its feet. Used when he hangs.</summary>
    public Dictionary<string, (string File, bool Flip)> Poses { get; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Every picture except the emblem, by pose name (file name in lower case, without "-flip"). Used when he acts.</summary>
    public Dictionary<string, string> Pictures { get; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Per-pose settings from hero.json.</summary>
    public Dictionary<string, PoseOptions> PoseSettings { get; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>The move set from hero.json. Null means he hangs from his line.</summary>
    public string? Moves { get; set; }

    public string? Emblem { get; set; }

    public bool HasPoses => Poses.Count > 0;
    public bool Usable => HasPoses || Emblem != null;

    /// <summary>True when he has a move set and every pose it needs, so he acts instead of hanging.</summary>
    public bool CanAct => HeroMoves.MissingPoses(Moves, Pictures.Keys).Count == 0 && Moves != null;
}

internal static class HeroLibrary
{
    public static readonly string[] PoseNames = { "hang", "swing", "fly", "grab" };

    /// <summary>Built-in choices that are not folders.</summary>
    public const string Drawn = "Drawn Spider-Man";
    public const string MyPicture = "My picture";

    private static readonly string[] PictureTypes = { ".png", ".webp", ".gif", ".bmp", ".jpg", ".jpeg" };

    public static string Folder => Path.Combine(Settings.Folder, "heroes");

    /// <summary>Reads every hero folder. Folders without pictures are included, so the menu can show them as waiting.</summary>
    public static List<HeroInfo> Scan()
    {
        var heroes = new List<HeroInfo>();
        if (!Directory.Exists(Folder))
        {
            return heroes;
        }
        foreach (string dir in Directory.GetDirectories(Folder).OrderBy(d => d, StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                heroes.Add(Read(dir));
            }
            catch (Exception ex)
            {
                Log.Write($"Skipped hero folder {dir}: {ex.Message}");
            }
        }
        return heroes;
    }

    public static HeroInfo? Find(string name)
    {
        return Scan().FirstOrDefault(h => h.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>Reads one hero folder, wherever it is. Used by the snapshot test.</summary>
    public static HeroInfo ReadFolder(string dir) => Read(dir);

    private static HeroInfo Read(string dir)
    {
        var hero = new HeroInfo
        {
            Name = Path.GetFileName(dir),
            FolderPath = dir,
        };
        ReadSettings(Path.Combine(dir, "hero.json"), hero);

        var others = new List<string>();
        foreach (string file in Directory.GetFiles(dir).OrderBy(f => f, StringComparer.OrdinalIgnoreCase))
        {
            if (!PictureTypes.Contains(Path.GetExtension(file).ToLowerInvariant()))
            {
                continue;
            }
            string stem = Path.GetFileNameWithoutExtension(file).ToLowerInvariant();
            bool flip = stem.EndsWith("-flip", StringComparison.Ordinal);
            string pose = flip ? stem[..^"-flip".Length] : stem;

            if (pose == "emblem")
            {
                hero.Emblem = file;
                continue;
            }
            hero.Pictures[pose] = file;
            if (PoseNames.Contains(pose))
            {
                hero.Poses[pose] = (file, flip);
            }
            else
            {
                others.Add(file);
            }
        }

        // A folder of pictures with other names still works: the first one becomes the hang pose.
        if (!hero.Poses.ContainsKey("hang") && others.Count > 0)
        {
            string stem = Path.GetFileNameWithoutExtension(others[0]).ToLowerInvariant();
            hero.Poses["hang"] = (others[0], stem.EndsWith("-flip", StringComparison.Ordinal));
        }
        return hero;
    }

    /// <summary>Reads hero.json into the hero. A missing or broken file leaves the defaults.</summary>
    private static void ReadSettings(string jsonFile, HeroInfo hero)
    {
        if (!File.Exists(jsonFile))
        {
            return;
        }
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(jsonFile), new JsonDocumentOptions
            {
                AllowTrailingCommas = true,
                CommentHandling = JsonCommentHandling.Skip,
            });
            var root = doc.RootElement;
            if (root.TryGetProperty("line", out var line) && Enum.TryParse(line.GetString(), ignoreCase: true, out LineStyle style))
            {
                hero.Line = style;
            }
            if (root.TryGetProperty("moves", out var moves) && moves.ValueKind == JsonValueKind.String)
            {
                hero.Moves = moves.GetString();
            }
            if (root.TryGetProperty("poses", out var poses) && poses.ValueKind == JsonValueKind.Object)
            {
                foreach (var pose in poses.EnumerateObject())
                {
                    hero.PoseSettings[pose.Name] = ReadPose(pose.Value);
                }
            }
        }
        catch (Exception ex)
        {
            Log.Write($"Could not read {jsonFile}: {ex.Message}");
        }
    }

    private static PoseOptions ReadPose(JsonElement json)
    {
        var options = new PoseOptions();
        if (json.TryGetProperty("facesLeft", out var left) && (left.ValueKind == JsonValueKind.True || left.ValueKind == JsonValueKind.False))
        {
            options.FacesLeft = left.GetBoolean();
        }
        if (json.TryGetProperty("scale", out var scale) && scale.TryGetDouble(out double s) && s > 0)
        {
            options.Scale = s;
        }
        if (json.TryGetProperty("thrustAngle", out var angle) && angle.TryGetDouble(out double a))
        {
            options.ThrustAngle = a;
        }
        if (json.TryGetProperty("points", out var points) && points.ValueKind == JsonValueKind.Object)
        {
            foreach (var named in points.EnumerateObject())
            {
                var list = new List<System.Windows.Point>();
                // Accept one point [x, y] or a list of points [[x, y], [x, y]].
                if (named.Value.ValueKind == JsonValueKind.Array && named.Value.GetArrayLength() == 2
                    && named.Value[0].ValueKind == JsonValueKind.Number)
                {
                    list.Add(new System.Windows.Point(named.Value[0].GetDouble(), named.Value[1].GetDouble()));
                }
                else if (named.Value.ValueKind == JsonValueKind.Array)
                {
                    foreach (var p in named.Value.EnumerateArray())
                    {
                        if (p.ValueKind == JsonValueKind.Array && p.GetArrayLength() == 2)
                        {
                            list.Add(new System.Windows.Point(p[0].GetDouble(), p[1].GetDouble()));
                        }
                    }
                }
                options.Points[named.Name] = list;
            }
        }
        return options;
    }
}

/// <summary>
/// A hero's pictures, loaded and sized, ready to draw.
/// Asking for a pose he does not have gives the nearest one he does:
/// grab and fly fall back to swing, swing falls back to hang, hang falls back to the emblem.
/// </summary>
internal sealed class HeroLook
{
    private readonly Dictionary<string, CustomFigure> poses;
    private readonly CustomFigure? emblem;

    public HeroLook(string name, LineStyle line, Dictionary<string, CustomFigure> poses, CustomFigure? emblem)
    {
        Name = name;
        this.poses = poses;
        this.emblem = emblem;
        // An emblem is a charm pendant with its own hanging loop. Floating with nothing in the loop looks
        // wrong, so a "none" hero's emblem hangs on a chain until real poses arrive.
        Line = poses.Count == 0 && line == LineStyle.None ? LineStyle.Chain : line;
    }

    public string Name { get; }
    public LineStyle Line { get; }
    public bool OnlyEmblem => poses.Count == 0;

    public CustomFigure? Pose(string name)
    {
        foreach (string candidate in Fallbacks(name))
        {
            if (poses.TryGetValue(candidate, out var figure))
            {
                return figure;
            }
        }
        return poses.Values.FirstOrDefault() ?? emblem;
    }

    private static IEnumerable<string> Fallbacks(string name)
    {
        yield return name;
        if (name is "grab" or "fly")
        {
            yield return "swing";
        }
        yield return "hang";
    }

    /// <summary>Loads every picture of a hero. Pictures that fail are logged and skipped.</summary>
    public static HeroLook? Load(HeroInfo info, double bodyLength, double pixelsPerDip, Action<string> problem)
    {
        var loaded = new Dictionary<string, CustomFigure>(StringComparer.OrdinalIgnoreCase);
        foreach (var (pose, (file, flip)) in info.Poses)
        {
            var figure = CustomFigure.TryLoad(file, flip, bodyLength, pixelsPerDip, out string? error);
            if (figure != null)
            {
                loaded[pose] = figure;
            }
            else
            {
                problem($"{info.Name}: could not load {Path.GetFileName(file)}. {error}");
            }
        }

        CustomFigure? emblem = null;
        if (loaded.Count == 0 && info.Emblem != null)
        {
            // Emblems are compact charms, so they hang a little smaller than a full figure.
            emblem = CustomFigure.TryLoad(info.Emblem, false, bodyLength, pixelsPerDip, out string? error, heightShare: 0.85);
            if (emblem == null)
            {
                problem($"{info.Name}: could not load the emblem. {error}");
            }
        }

        if (loaded.Count == 0 && emblem == null)
        {
            return null;
        }
        return new HeroLook(info.Name, info.Line, loaded, emblem);
    }

    /// <summary>A single picture (the "My picture" choice), hanging from a web.</summary>
    public static HeroLook Single(string name, CustomFigure figure)
    {
        return new HeroLook(name, LineStyle.Web, new Dictionary<string, CustomFigure> { ["hang"] = figure }, null);
    }
}
