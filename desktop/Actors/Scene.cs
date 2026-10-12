using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Media;

namespace SpideyHang;

/// <summary>The hero on screen: where his feet are, which way he faces, his pose, and any squash or tilt.</summary>
internal sealed class Actor
{
    private string? fromPose;
    private double fade = 1;
    private double fadeTime = 0.12;

    public Point Foot;
    public int Facing = 1;
    public double Rotation;
    public double ScaleX = 1;
    public double ScaleY = 1;

    /// <summary>A temporary jolt added when drawing (landing shake). Not part of his real position.</summary>
    public Vector Shake;

    public string Pose { get; private set; } = "idle";

    /// <summary>Switches pose with a short cross-fade, so the swap does not jump.</summary>
    public void SetPose(string pose, double crossfade = 0.12)
    {
        if (pose == Pose)
        {
            return;
        }
        fromPose = crossfade > 0 ? Pose : null;
        Pose = pose;
        fade = crossfade > 0 ? 0 : 1;
        fadeTime = Math.Max(0.01, crossfade);
    }

    public Placement Placement => new(Foot + Shake, Facing, Rotation, ScaleX, ScaleY);

    public void Update(double dt)
    {
        if (fade < 1)
        {
            fade = Math.Min(1, fade + dt / fadeTime);
        }
    }

    public void Draw(DrawingContext dc, HeroKit kit, HeroMoves moves)
    {
        var place = Placement;
        if (fromPose != null && fade < 1)
        {
            kit.Pose(fromPose, moves.Fallback(fromPose)).Draw(dc, place, 1 - fade);
            kit.Pose(Pose, moves.Fallback(Pose)).Draw(dc, place, fade);
        }
        else
        {
            kit.Pose(Pose, moves.Fallback(Pose)).Draw(dc, place);
        }
    }

    public PoseImage CurrentImage(HeroKit kit, HeroMoves moves) => kit.Pose(Pose, moves.Fallback(Pose));
}

/// <summary>A thrown object with its own window: Captain America's shield, Thor's hammer.</summary>
internal sealed class Projectile
{
    public Projectile(PoseImage image)
    {
        Image = image;
    }

    public PoseImage Image { get; }
    public Point Center;
    public double Rotation;
    public double ScaleY = 1;
    public bool Alive = true;

    public double Radius => Math.Max(Image.Width, Image.Height) * 0.6;

    /// <summary>Everywhere it will fly, set when thrown. The live app gives it a window this size.</summary>
    public Rect Bounds;

    public void Draw(DrawingContext dc) => Image.DrawCentered(dc, Center, Rotation, 1, ScaleY);
}

/// <summary>
/// A hero's loaded pictures. Poses are looked up by name. A missing pose falls back to the move's
/// own fallback, then to any resting pose, then to whatever pose exists.
/// </summary>
internal sealed class HeroKit
{
    private static readonly string[] RestPoses = { "idle", "stand", "hover", "stance", "hang", "perch", "summon" };

    public HeroKit(string name, string moves, Dictionary<string, PoseImage> poses, PoseImage? prop, double size)
    {
        Name = name;
        Moves = moves;
        Poses = poses;
        Prop = prop;
        Size = size;
    }

    public string Name { get; }
    public string Moves { get; }
    public Dictionary<string, PoseImage> Poses { get; }

    /// <summary>The emblem picture, used as a thrown object where it is one (shield, hammer). May be null.</summary>
    public PoseImage? Prop { get; }

    public double Size { get; }

    public bool Has(string pose) => Poses.ContainsKey(pose);

    public PoseImage Pose(string name, string? fallback = null)
    {
        if (Poses.TryGetValue(name, out var p))
        {
            return p;
        }
        if (fallback != null && Poses.TryGetValue(fallback, out p))
        {
            return p;
        }
        foreach (string rest in RestPoses)
        {
            if (Poses.TryGetValue(rest, out p))
            {
                return p;
            }
        }
        return Poses.Values.First();
    }

    /// <summary>Loads every picture in a hero folder. Returns null if none loads.</summary>
    public static HeroKit? Load(HeroInfo info, double size, double pixelsPerDip, Action<string> problem)
    {
        var poses = new Dictionary<string, PoseImage>(StringComparer.OrdinalIgnoreCase);
        foreach (var (name, file) in info.Pictures)
        {
            var options = info.PoseSettings.TryGetValue(name, out var o) ? o : new PoseOptions();
            var image = PoseImage.Load(file, options, size, pixelsPerDip, out string? error);
            if (image != null)
            {
                poses[name] = image;
            }
            else
            {
                problem($"{info.Name}: could not load {System.IO.Path.GetFileName(file)}. {error}");
            }
        }
        if (poses.Count == 0)
        {
            return null;
        }

        PoseImage? prop = null;
        if (info.Emblem != null)
        {
            var options = info.PoseSettings.TryGetValue("emblem", out var o) ? o : new PoseOptions();
            // A thrown shield or hammer is about half his size.
            prop = PoseImage.Load(info.Emblem, options, size * 0.55, pixelsPerDip, out _);
        }
        return new HeroKit(info.Name, info.Moves ?? "", poses, prop, size);
    }
}

/// <summary>
/// Everything happening on screen: the hero, thrown objects and effects, in screen coordinates (WPF units).
/// Knows nothing about windows, so the same scene runs live or in the snapshot test.
///
/// Moves are scripts (C# iterators): each "yield return null" waits one frame.
/// The idle script runs until something interrupts it. A click starts the move's action script,
/// and when that ends the idle script starts again.
/// </summary>
internal sealed class Scene
{
    private readonly HeroMoves moves;
    private IEnumerator<object?>? routine;
    private bool acting;
    private Vector grabOffset;
    private Point lastDragPoint;
    private Vector dragVelocity;

    public Scene(HeroKit kit, Rect area, Random rng)
    {
        Kit = kit;
        Area = area;
        Rng = rng;
        moves = HeroMoves.Create(kit.Moves, this);
        Hero.Foot = new Point(area.Left + area.Width * 0.75, area.Bottom);
    }

    public HeroKit Kit { get; }
    public Actor Hero { get; } = new();
    public HeroMoves Moves => moves;
    public Random Rng { get; }

    /// <summary>The usable screen: the taskbar's top edge is the ground (Area.Bottom).</summary>
    public Rect Area { get; set; }

    public double Ground => Area.Bottom;
    public double Time { get; private set; }
    public double Dt { get; private set; }

    /// <summary>Where the mouse pointer is, for heroes that watch it or aim at it.</summary>
    public Point Mouse { get; set; }

    public bool Dragging { get; private set; }

    /// <summary>
    /// Set by a long move (flight, leap, run, fall) to the whole area it will cover, and cleared after.
    /// The live app then holds the hero's window still over that area instead of chasing him.
    /// </summary>
    public Rect? StageArea { get; set; }

    public List<IEffect> Effects { get; } = new();
    public List<Projectile> Projectiles { get; } = new();

    /// <summary>Effects started this frame. The live app gives each one a window.</summary>
    public List<IEffect> NewEffects { get; } = new();

    /// <summary>A short line for the log and tests: what the hero is doing right now.</summary>
    public string Status => $"{Hero.Pose} at ({Hero.Foot.X:0},{Hero.Foot.Y:0}) facing {(Hero.Facing > 0 ? "right" : "left")}{(acting ? " acting" : "")}";

    public void Add(IEffect effect)
    {
        Effects.Add(effect);
        NewEffects.Add(effect);
    }

    public void Update(double dt)
    {
        Dt = dt;
        Time += dt;
        Hero.Update(dt);

        if (Dragging)
        {
            Hero.Foot = lastDragPoint + grabOffset;
            Hero.Rotation += (Math.Clamp(dragVelocity.X * 0.02, -25, 25) - Hero.Rotation) * Math.Min(1, dt * 10);
        }
        else
        {
            if (routine == null || !routine.MoveNext())
            {
                acting = false;
                StageArea = null;
                routine = moves.Idle().GetEnumerator();
                routine.MoveNext();
            }
        }

        foreach (var effect in Effects)
        {
            effect.Update(dt);
        }
        Effects.RemoveAll(e => !e.Alive);
        Projectiles.RemoveAll(p => !p.Alive);
    }

    /// <summary>Single click on the hero: his signature move. Ignored while a move is already running.</summary>
    public void Click() => StartAction(moves.OnClick());

    /// <summary>Double-click: his second move, if he has one. Interrupts the first.</summary>
    public void DoubleClick() => StartAction(moves.OnDoubleClick(), force: true);

    private void StartAction(IEnumerable<object?> action, bool force = false)
    {
        if (Dragging || (acting && !force))
        {
            return;
        }
        acting = true;
        StageArea = null;
        routine = action.GetEnumerator();
    }

    public void BeginDrag(Point at)
    {
        Dragging = true;
        acting = false;
        routine = null;
        StageArea = null;
        grabOffset = Hero.Foot - at;
        lastDragPoint = at;
        dragVelocity = default;
        Hero.SetPose(moves.DragPose);
        Hero.ScaleX = Hero.ScaleY = 1;
    }

    public void DragTo(Point at, double dt)
    {
        if (!Dragging)
        {
            return;
        }
        if (dt > 0)
        {
            var v = (at - lastDragPoint) / dt;
            dragVelocity = dragVelocity * 0.6 + v * 0.4;
        }
        lastDragPoint = at;
    }

    public void EndDrag()
    {
        if (!Dragging)
        {
            return;
        }
        Dragging = false;
        acting = true;
        var v = dragVelocity;
        if (v.Length > 2500)
        {
            v *= 2500 / v.Length;
        }
        routine = moves.Dropped(v).GetEnumerator();
    }

    /// <summary>Draws the hero and everything around him.</summary>
    public void DrawHero(DrawingContext dc)
    {
        moves.DrawBehind(dc);
        Hero.Draw(dc, Kit, moves);
        moves.DrawFront(dc);
    }

    /// <summary>Everything at once, for the snapshot test. The live app draws each part in its own window.</summary>
    public void DrawWorld(DrawingContext dc)
    {
        DrawHero(dc);
        foreach (var p in Projectiles)
        {
            p.Draw(dc);
        }
        foreach (var e in Effects)
        {
            e.Draw(dc);
        }
    }
}
