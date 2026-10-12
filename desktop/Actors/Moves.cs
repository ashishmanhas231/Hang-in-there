using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Media;

namespace SpideyHang;

/// <summary>
/// A hero's set of moves, written as scripts. In a script, "yield return null" waits one frame,
/// and "foreach (var f in X()) yield return f;" runs another script to the end.
///
/// Idle runs until interrupted. OnClick and OnDoubleClick are his signature moves.
/// Dropped runs when you let go after dragging him.
/// </summary>
internal abstract class HeroMoves
{
    protected readonly Scene S;

    protected HeroMoves(Scene scene)
    {
        S = scene;
    }

    protected Actor A => S.Hero;
    protected double Size => S.Kit.Size;

    public static HeroMoves Create(string name, Scene scene) => name.ToLowerInvariant() switch
    {
        "ironman" => new IronManMoves(scene),
        "hulk" => new HulkMoves(scene),
        "captain" => new CaptainMoves(scene),
        "thor" => new ThorMoves(scene),
        "flash" => new FlashMoves(scene),
        _ => new FloaterMoves(scene),
    };

    /// <summary>The poses a move set cannot work without, minus the ones the hero has.</summary>
    public static List<string> MissingPoses(string? moves, IEnumerable<string> have)
    {
        var set = new HashSet<string>(have, StringComparer.OrdinalIgnoreCase);
        string[] needed = (moves ?? "").ToLowerInvariant() switch
        {
            "ironman" => new[] { "hover", "fly", "land" },
            "hulk" => new[] { "idle", "jump", "smash" },
            "captain" => new[] { "stand", "throw" },
            "thor" => new[] { "stand", "summon", "land" },
            "flash" => new[] { "stand", "run" },
            "floater" => Array.Empty<string>(),
            _ => new[] { "a known move set" },
        };
        var missing = needed.Where(n => !set.Contains(n)).ToList();
        if (set.Count == 0)
        {
            missing.Add("any picture");
        }
        return missing;
    }

    /// <summary>Which pose to show when the asked-for one is missing. Null = any resting pose.</summary>
    public virtual string? Fallback(string pose) => null;

    /// <summary>The pose he shows while you drag him.</summary>
    public virtual string DragPose => A.Pose;

    public abstract IEnumerable<object?> Idle();

    public virtual IEnumerable<object?> OnClick()
    {
        yield break;
    }

    public virtual IEnumerable<object?> OnDoubleClick() => OnClick();

    public virtual IEnumerable<object?> Dropped(Vector velocity) => FallAndLand(velocity, A.Pose, A.Pose, cracks: false);

    /// <summary>Drawn behind him: thruster flames, magic glow.</summary>
    public virtual void DrawBehind(DrawingContext dc)
    {
    }

    /// <summary>Drawn in front of him.</summary>
    public virtual void DrawFront(DrawingContext dc)
    {
    }

    // ---- Building blocks ----------------------------------------------------------------

    protected IEnumerable<object?> Wait(double seconds)
    {
        double end = S.Time + seconds;
        while (S.Time < end)
        {
            yield return null;
        }
    }

    protected static double Smooth(double t) => t * t * (3 - 2 * t);

    /// <summary>
    /// Tells the live app this move will cover the area around these points, so it can hold the
    /// hero's window still over it (see SceneHost). Cleared with Unstage, or when a new script starts.
    /// </summary>
    protected void Stage(params Point[] points)
    {
        var area = new Rect(points[0], points[0]);
        foreach (var p in points)
        {
            area.Union(p);
        }
        area.Inflate(Size * 1.9, Size * 1.9);
        S.StageArea = area;
    }

    protected void Unstage() => S.StageArea = null;

    protected static Point Bezier(Point a, Point control, Point b, double t)
    {
        double u = 1 - t;
        return new Point(u * u * a.X + 2 * u * t * control.X + t * t * b.X, u * u * a.Y + 2 * u * t * control.Y + t * t * b.Y);
    }

    /// <summary>Turns to face the mouse, unless it is nearly straight above or below him.</summary>
    protected void FaceMouse()
    {
        double dx = S.Mouse.X - A.Foot.X;
        if (Math.Abs(dx) > Size * 0.4)
        {
            A.Facing = Math.Sign(dx);
        }
    }

    protected double RandomX(double margin) => S.Area.Left + margin + S.Rng.NextDouble() * Math.Max(1, S.Area.Width - 2 * margin);

    /// <summary>A random x at least a quarter of the screen away from where he is, so the move is worth watching.</summary>
    protected double FarX(double margin)
    {
        double x = RandomX(margin);
        for (int i = 0; i < 10 && Math.Abs(x - A.Foot.X) < S.Area.Width * 0.25; i++)
        {
            x = RandomX(margin);
        }
        return x;
    }

    /// <summary>
    /// Flies along a curve to a point. With bank on, the body tilts so the nose follows the path
    /// (for a flat flying pose); with it off he stays upright.
    /// </summary>
    protected IEnumerable<object?> FlyTo(Point to, double speed, string pose, bool bank, double arc = 0.2)
    {
        var from = A.Foot;
        double distance = (to - from).Length;
        double duration = Math.Max(0.45, distance / speed);
        var control = from + (to - from) * 0.5 + new Vector(0, -distance * arc);
        Stage(from, to, control);
        A.SetPose(pose);
        if (Math.Abs(to.X - from.X) > 1)
        {
            A.Facing = to.X > from.X ? 1 : -1;
        }

        var previous = from;
        double t = 0;
        while (t < 1)
        {
            t = Math.Min(1, t + S.Dt / duration);
            var p = Bezier(from, control, to, Smooth(t));
            var v = p - previous;
            previous = p;
            A.Foot = p;
            if (bank && v.Length > 0.01)
            {
                double pitch = Math.Atan2(v.Y, Math.Abs(v.X)) * 180 / Math.PI;
                A.Rotation += (Math.Clamp(pitch, -35, 35) * A.Facing - A.Rotation) * Math.Min(1, S.Dt * 10);
            }
            yield return null;
        }
        Unstage();
    }

    /// <summary>A jump under gravity from where he is to a landing point, rising apexHeight above the higher end.</summary>
    protected IEnumerable<object?> Leap(Point to, double apexHeight, double gravity = 2600)
    {
        var from = A.Foot;
        double apexY = Math.Min(from.Y, to.Y) - apexHeight;
        double up = Math.Sqrt(2 * (from.Y - apexY) / gravity);
        double down = Math.Sqrt(2 * (to.Y - apexY) / gravity);
        double total = up + down;
        double vx = (to.X - from.X) / total;
        double vy0 = -gravity * up;
        Stage(from, to, new Point((from.X + to.X) / 2, apexY));

        double t = 0;
        while (t < total)
        {
            t = Math.Min(total, t + S.Dt);
            A.Foot = new Point(from.X + vx * t, from.Y + vy0 * t + 0.5 * gravity * t * t);
            yield return null;
        }
        A.Foot = to;
        Unstage();
    }

    /// <summary>Speed when he last hit the ground, for deciding how hard he lands.</summary>
    protected double LastImpactSpeed;

    /// <summary>Falls under gravity with the speed he was thrown at, off the screen sides, until he reaches the taskbar.</summary>
    protected IEnumerable<object?> Fall(Vector velocity, double gravity = 2600)
    {
        var v = velocity;
        double left = S.Area.Left + Size * 0.3;
        double right = S.Area.Right - Size * 0.3;
        Stage(new Point(Math.Max(left, A.Foot.X - 700), Math.Max(S.Area.Top, A.Foot.Y - 500)), new Point(Math.Min(right, A.Foot.X + 700), S.Ground));
        while (true)
        {
            v += new Vector(0, gravity * S.Dt);
            var p = A.Foot + v * S.Dt;
            if (p.X < left || p.X > right)
            {
                p.X = Math.Clamp(p.X, left, right);
                v.X = -v.X * 0.35;
            }
            if (p.Y < S.Area.Top + Size)
            {
                p.Y = S.Area.Top + Size;
                v.Y = Math.Max(0, v.Y);
            }
            A.Rotation += (0 - A.Rotation) * Math.Min(1, S.Dt * 4);
            if (p.Y >= S.Ground)
            {
                A.Foot = new Point(p.X, S.Ground);
                LastImpactSpeed = v.Y;
                Unstage();
                yield break;
            }
            A.Foot = p;
            yield return null;
        }
    }

    /// <summary>
    /// A landing: dust (and cracks if asked), a squash that springs back, and a shake.
    /// strength 1 is a heavy landing.
    /// </summary>
    protected IEnumerable<object?> LandHard(string pose, double strength, bool cracks)
    {
        A.SetPose(pose, 0.05);
        A.Rotation = 0;
        A.Foot = new Point(A.Foot.X, S.Ground);
        S.Add(new Impact(new Point(A.Foot.X, S.Ground), Size, strength, cracks, S.Rng));

        const double duration = 0.45;
        double t = 0;
        while (t < duration)
        {
            t += S.Dt;
            double k = Math.Min(1, t / duration);
            // A squash that springs back past normal once, then settles.
            double squash = strength * 0.2 * (1 - k) * Math.Cos(k * Math.PI * 1.5);
            A.ScaleY = 1 - squash;
            A.ScaleX = 1 + squash * 0.6;
            double shake = (1 - k) * strength * 7;
            A.Shake = new Vector((S.Rng.NextDouble() * 2 - 1) * shake, (S.Rng.NextDouble() * 2 - 1) * shake * 0.4);
            yield return null;
        }
        A.ScaleX = A.ScaleY = 1;
        A.Shake = default;
    }

    /// <summary>Default drop: falls, then lands hard if it was a long or fast fall.</summary>
    protected IEnumerable<object?> FallAndLand(Vector velocity, string fallPose, string landPose, bool cracks)
    {
        A.SetPose(fallPose);
        foreach (var f in Fall(velocity))
        {
            yield return f;
        }
        bool hard = LastImpactSpeed > 900;
        foreach (var f in LandHard(landPose, hard ? 1.0 : 0.35, cracks && hard))
        {
            yield return f;
        }
    }

    /// <summary>A named spot on the current pose, on screen. Falls back to a point relative to his centre.</summary>
    protected Point Spot(string name, double forward, double up)
    {
        var image = A.CurrentImage(S.Kit, this);
        var place = A.Placement;
        var points = image.Points(name);
        if (points.Count > 0)
        {
            return image.ToScreen(points[0], place);
        }
        var c = image.CenterOnScreen(place);
        return new Point(c.X + A.Facing * image.Width * forward, c.Y - image.Height * up);
    }

    /// <summary>Keeps the whole figure on screen: between the sides, below the top, not below the taskbar.</summary>
    protected void KeepOnScreen()
    {
        var image = A.CurrentImage(S.Kit, this);
        double halfWidth = image.Width * 0.5;
        A.Foot = new Point(
            Math.Clamp(A.Foot.X, S.Area.Left + halfWidth, S.Area.Right - halfWidth),
            Math.Clamp(A.Foot.Y, S.Area.Top + image.Height * 0.95, S.Ground));
    }

    /// <summary>Gentle breathing for a hero standing still.</summary>
    protected void Breathe(double depth = 1)
    {
        double b = Math.Sin(S.Time * 2 * Math.PI / 1.8);
        A.ScaleY = 1 + 0.016 * b * depth;
        A.ScaleX = 1 - 0.008 * b * depth;
    }

    /// <summary>The far point of a ray from a point, where it leaves the screen.</summary>
    protected Point ToScreenEdge(Point from, Vector dir)
    {
        dir.Normalize();
        double best = 4000;
        if (Math.Abs(dir.X) > 1e-6)
        {
            best = Math.Min(best, ((dir.X > 0 ? S.Area.Right : S.Area.Left) - from.X) / dir.X);
        }
        if (Math.Abs(dir.Y) > 1e-6)
        {
            best = Math.Min(best, ((dir.Y > 0 ? S.Ground : S.Area.Top) - from.Y) / dir.Y);
        }
        return from + dir * Math.Max(0, best);
    }
}

/// <summary>
/// Iron Man: hovers on boot thrusters, flies between spots (banking into the path), and sometimes
/// comes down in a superhero landing on the taskbar before taking off again.
/// Click: fly somewhere now. Double-click: repulsor blast at the mouse pointer.
/// </summary>
internal sealed class IronManMoves : HeroMoves
{
    private static readonly Color ThrusterBlue = Color.FromRgb(150, 215, 255);

    private Point home;
    private bool started;
    private bool thrusters = true;
    private double thrust = 1;

    public IronManMoves(Scene scene)
        : base(scene)
    {
    }

    public override string? Fallback(string pose) => pose switch
    {
        "blast" or "land" or "fly" => "hover",
        _ => null,
    };

    public override string DragPose => "hover";

    private Point PickHome() => new(RandomX(Size * 1.2), S.Area.Top + S.Area.Height * (0.2 + S.Rng.NextDouble() * 0.25));

    public override IEnumerable<object?> Idle()
    {
        if (!started)
        {
            started = true;
            A.Foot = home = PickHome();
            A.SetPose("hover", 0);
        }
        else if (A.Foot.Y >= S.Ground - 1)
        {
            foreach (var f in TakeOff())
            {
                yield return f;
            }
        }

        double until = S.Time + 14 + S.Rng.NextDouble() * 22;
        while (S.Time < until)
        {
            HoverStep();
            yield return null;
        }
        foreach (var f in Patrol())
        {
            yield return f;
        }
    }

    private void HoverStep()
    {
        A.SetPose("hover");
        thrusters = true;
        thrust += (1 - thrust) * Math.Min(1, S.Dt * 3);
        var bob = new Vector(Math.Sin(S.Time * 0.9) * 4, Math.Sin(S.Time * 2.4) * 6);
        A.Foot += (home + bob - A.Foot) * Math.Min(1, S.Dt * 4);
        A.Rotation += (0 - A.Rotation) * Math.Min(1, S.Dt * 5);
        FaceMouse();
    }

    private IEnumerable<object?> Patrol()
    {
        var target = PickHome();
        target.X = FarX(Size * 1.2);
        if (S.Rng.NextDouble() < 0.45)
        {
            var ground = new Point(target.X, S.Ground);
            foreach (var f in FlyTo(new Point(ground.X, ground.Y - Size * 0.6), 1100, "fly", bank: true, arc: 0.15))
            {
                yield return f;
            }
            foreach (var f in SuperheroLanding(ground))
            {
                yield return f;
            }
            foreach (var f in TakeOff())
            {
                yield return f;
            }
        }
        else
        {
            foreach (var f in FlyTo(target, 1100, "fly", bank: true))
            {
                yield return f;
            }
            home = target;
        }
        A.SetPose("hover", 0.15);
    }

    private IEnumerable<object?> SuperheroLanding(Point ground)
    {
        A.SetPose("land", 0.08);
        A.Rotation = 0;
        thrusters = false;
        var from = A.Foot;
        Stage(from, ground);
        double t = 0;
        while (t < 0.12)
        {
            t += S.Dt;
            A.Foot = from + (ground - from) * Math.Min(1, t / 0.12);
            yield return null;
        }
        foreach (var f in LandHard("land", 0.9, cracks: true))
        {
            yield return f;
        }
        foreach (var f in Wait(1.6))
        {
            yield return f;
        }
    }

    private IEnumerable<object?> TakeOff()
    {
        A.SetPose("hover", 0.15);
        thrusters = true;
        thrust = 2.2;
        home = PickHome();
        var from = A.Foot;
        Stage(from, home);
        double t = 0;
        while (t < 1)
        {
            t = Math.Min(1, t + S.Dt / 0.9);
            double e = Smooth(t);
            A.Foot = from + (home - from) * e;
            thrust = 2.2 - 1.2 * e;
            yield return null;
        }
        Unstage();
    }

    public override IEnumerable<object?> OnClick()
    {
        if (A.Foot.Y >= S.Ground - 1)
        {
            foreach (var f in TakeOff())
            {
                yield return f;
            }
        }
        foreach (var f in Patrol())
        {
            yield return f;
        }
    }

    public override IEnumerable<object?> OnDoubleClick()
    {
        FaceMouse();
        A.SetPose("blast", 0.1);
        A.Rotation = 0;
        foreach (var f in Wait(0.15))
        {
            yield return f;
        }
        var palm = Spot("palm", 0.5, 0.15);
        var dir = S.Mouse - palm;
        if (dir.Length < 1 || Math.Sign(dir.X) != A.Facing)
        {
            dir = new Vector(A.Facing, -0.05);
        }
        S.Add(new Beam(palm, ToScreenEdge(palm, dir), Color.FromRgb(120, 220, 255), Size * 0.05, 0.7, S.Rng));
        dir.Normalize();
        A.Foot -= dir * 10;
        foreach (var f in Wait(0.8))
        {
            yield return f;
        }
        A.SetPose("hover", 0.15);
    }

    public override IEnumerable<object?> Dropped(Vector velocity)
    {
        // He catches himself: thrusters fire and he slows to a hover, then flies back up.
        A.SetPose("hover");
        thrusters = true;
        thrust = 2;
        var v = velocity;
        while (v.Length > 30)
        {
            v *= Math.Pow(0.02, S.Dt);
            A.Foot += v * S.Dt;
            KeepOnScreen();
            A.Foot = new Point(A.Foot.X, Math.Min(A.Foot.Y, S.Ground - Size * 0.2));
            yield return null;
        }
        foreach (var f in TakeOff())
        {
            yield return f;
        }
    }

    public override void DrawBehind(DrawingContext dc)
    {
        if (!thrusters)
        {
            return;
        }
        var image = A.CurrentImage(S.Kit, this);
        var place = A.Placement;
        var dir = image.DirectionOnScreen(image.ThrustAngle, place);
        var points = image.Points("thrusters");
        double length = Size * 0.28 * thrust;
        double width = Size * 0.05;
        if (points.Count > 0)
        {
            for (int i = 0; i < points.Count; i++)
            {
                Fx.Flame(dc, image.ToScreen(points[i], place), dir, length, width, S.Time, i, ThrusterBlue);
            }
        }
        else
        {
            // No marked boots: one flame either side of his feet.
            var foot = image.ToScreen(new Point(0, 0), place);
            var side = new Vector(-dir.Y, dir.X) * image.Width * 0.12;
            Fx.Flame(dc, foot + side, dir, length, width, S.Time, 0, ThrusterBlue);
            Fx.Flame(dc, foot - side, dir, length, width, S.Time, 1, ThrusterBlue);
        }
    }
}

/// <summary>
/// Hulk: stands on the taskbar breathing heavily, facing the mouse. Now and then (or on a click)
/// crouches, leaps across the screen and lands with a smash: dust, cracks and a shake, then roars.
/// Drop him from a height and he smashes too.
/// </summary>
internal sealed class HulkMoves : HeroMoves
{
    private bool started;

    public HulkMoves(Scene scene)
        : base(scene)
    {
    }

    public override string? Fallback(string pose) => pose switch
    {
        "roar" => "smash",
        _ => "idle",
    };

    public override string DragPose => "jump";

    public override IEnumerable<object?> Idle()
    {
        if (!started)
        {
            started = true;
            A.Foot = new Point(RandomX(Size), S.Ground);
        }
        A.SetPose("idle", 0.2);
        A.Rotation = 0;
        double until = S.Time + 25 + S.Rng.NextDouble() * 45;
        while (S.Time < until)
        {
            Breathe(1.4);
            FaceMouse();
            yield return null;
        }
        foreach (var f in LeapAndSmash())
        {
            yield return f;
        }
    }

    private IEnumerable<object?> LeapAndSmash()
    {
        double x = FarX(Size);
        A.Facing = x > A.Foot.X ? 1 : -1;

        // Crouch to spring.
        double t = 0;
        while (t < 0.25)
        {
            t += S.Dt;
            double k = Smooth(Math.Min(1, t / 0.25));
            A.ScaleY = 1 - 0.16 * k;
            A.ScaleX = 1 + 0.09 * k;
            yield return null;
        }

        A.SetPose("jump", 0.06);
        A.ScaleX = 0.94;
        A.ScaleY = 1.1;
        var previous = A.Foot;
        foreach (var f in Leap(new Point(x, S.Ground), Math.Min(S.Area.Height * 0.55, Size * 2.6)))
        {
            // Stretch eases back to normal, and he leans into the climb, then over the top.
            A.ScaleX += (1 - A.ScaleX) * 0.08;
            A.ScaleY += (1 - A.ScaleY) * 0.08;
            var v = A.Foot - previous;
            previous = A.Foot;
            A.Rotation = Math.Clamp(Math.Atan2(v.Y, Math.Abs(v.X) + 1e-6) * 180 / Math.PI * 0.3, -15, 15) * A.Facing;
            yield return f;
        }

        foreach (var f in LandHard("smash", 1.2, cracks: true))
        {
            yield return f;
        }
        foreach (var f in Wait(0.6))
        {
            yield return f;
        }
        if (S.Kit.Has("roar"))
        {
            A.SetPose("roar", 0.15);
            foreach (var f in Wait(1.3))
            {
                yield return f;
            }
        }
        A.SetPose("idle", 0.25);
    }

    public override IEnumerable<object?> OnClick() => LeapAndSmash();

    public override IEnumerable<object?> Dropped(Vector velocity) => FallAndLand(velocity, "jump", "smash", cracks: true);
}

/// <summary>
/// Captain America: stands on the taskbar. Click: throws his shield. It spins out to the screen edge,
/// strikes sparks, and curves back to his hand. The shield is the hero folder's emblem picture.
/// </summary>
internal sealed class CaptainMoves : HeroMoves
{
    private static readonly Color Gold = Color.FromRgb(255, 215, 120);
    private bool started;

    public CaptainMoves(Scene scene)
        : base(scene)
    {
    }

    public override string? Fallback(string pose) => pose switch
    {
        "catch" or "throw" => "stand",
        _ => "stand",
    };

    public override IEnumerable<object?> Idle()
    {
        if (!started)
        {
            started = true;
            A.Foot = new Point(RandomX(Size), S.Ground);
        }
        A.SetPose("stand", 0.2);
        double until = S.Time + 40 + S.Rng.NextDouble() * 40;
        while (S.Time < until)
        {
            Breathe(0.7);
            FaceMouse();
            yield return null;
        }
        foreach (var f in ThrowShield())
        {
            yield return f;
        }
    }

    private IEnumerable<object?> ThrowShield()
    {
        if (S.Kit.Prop == null)
        {
            yield break;
        }
        // Throw toward whichever side has more room.
        A.Facing = S.Area.Right - A.Foot.X > A.Foot.X - S.Area.Left ? 1 : -1;
        A.ScaleX = A.ScaleY = 1;
        A.SetPose("throw", 0.08);
        foreach (var f in Wait(0.1))
        {
            yield return f;
        }

        var shield = new Projectile(S.Kit.Prop) { ScaleY = 0.45 };
        var start = Spot("hand", 0.45, 0.15);
        shield.Center = start;
        S.Projectiles.Add(shield);

        // Out to the screen edge, rising a little.
        double edgeX = A.Facing > 0 ? S.Area.Right - shield.Radius * 0.6 : S.Area.Left + shield.Radius * 0.6;
        var hit = new Point(edgeX, start.Y - Size * 0.35);
        var flight = new Rect(start, hit);
        flight.Union(new Point(start.X, start.Y - Size * 1.3));
        flight.Inflate(shield.Radius * 1.6, shield.Radius * 1.6);
        shield.Bounds = flight;
        double outTime = Math.Max(0.25, (hit - start).Length / 1600);
        double t = 0;
        while (t < 1)
        {
            t = Math.Min(1, t + S.Dt / outTime);
            shield.Center = start + (hit - start) * t;
            shield.Rotation += 1080 * S.Dt;
            yield return null;
        }

        S.Add(new Sparks(hit, new Vector(-A.Facing * 250, -120), 20, Gold, S.Rng));

        // Back along a curve to his hand, wherever it is now.
        var from = hit;
        var hand = Spot("hand", 0.45, 0.15);
        double backTime = Math.Max(0.35, (hand - from).Length / 1300 + 0.15);
        t = 0;
        while (t < 1)
        {
            t = Math.Min(1, t + S.Dt / backTime);
            hand = Spot("hand", 0.45, 0.15);
            var control = from + (hand - from) * 0.5 + new Vector(0, -Size * 1.1);
            shield.Center = Bezier(from, control, hand, Smooth(t));
            shield.Rotation += 1080 * S.Dt;
            // Only a real catch pose shows early. The stand pose has the shield on his arm, so showing it
            // before the thrown one arrives would put two shields on screen.
            if (t > 0.8 && S.Kit.Has("catch") && A.Pose != "catch")
            {
                A.SetPose("catch", 0.08);
            }
            yield return null;
        }
        shield.Alive = false;
        if (!S.Kit.Has("catch"))
        {
            A.SetPose("stand", 0.04);
        }

        // The catch knocks him back a step.
        var spot = A.Foot;
        t = 0;
        while (t < 0.3)
        {
            t += S.Dt;
            double k = Math.Min(1, t / 0.3);
            A.Foot = spot + new Vector(-A.Facing * 10 * Math.Sin(k * Math.PI), 0);
            yield return null;
        }
        foreach (var f in Wait(0.5))
        {
            yield return f;
        }
        A.SetPose("stand", 0.2);
    }

    public override IEnumerable<object?> OnClick() => ThrowShield();

    public override IEnumerable<object?> Dropped(Vector velocity) => FallAndLand(velocity, "stand", "stand", cracks: false);
}

/// <summary>
/// Thor: stands on the taskbar. Now and then (or on a click) raises Mjolnir and calls lightning down
/// onto it, then flies off with the hammer leading and lands hammer first: a bolt, dust, cracks and a shake.
/// Double-click: a bolt from the hammer to the mouse pointer.
/// </summary>
internal sealed class ThorMoves : HeroMoves
{
    private static readonly Color Storm = Color.FromRgb(170, 210, 255);
    private bool started;

    public ThorMoves(Scene scene)
        : base(scene)
    {
    }

    public override string? Fallback(string pose) => pose switch
    {
        "fly" => "summon",
        _ => "stand",
    };

    public override string DragPose => "summon";

    public override IEnumerable<object?> Idle()
    {
        if (!started)
        {
            started = true;
            A.Foot = new Point(RandomX(Size), S.Ground);
        }
        A.SetPose("stand", 0.2);
        A.Rotation = 0;
        double until = S.Time + 30 + S.Rng.NextDouble() * 40;
        while (S.Time < until)
        {
            Breathe(0.8);
            FaceMouse();
            yield return null;
        }
        foreach (var f in CallLightning(3))
        {
            yield return f;
        }
        foreach (var f in FlyAndStrike())
        {
            yield return f;
        }
    }

    /// <summary>Raises the hammer. Bolts come down from the top of the screen onto it.</summary>
    private IEnumerable<object?> CallLightning(int bolts)
    {
        A.SetPose("summon", 0.12);
        A.Rotation = 0;
        foreach (var f in Wait(0.25))
        {
            yield return f;
        }
        for (int i = 0; i < bolts; i++)
        {
            var hammer = Spot("hammer", 0.1, 0.55);
            var sky = new Point(hammer.X + (S.Rng.NextDouble() - 0.5) * Size * 1.4, S.Area.Top);
            S.Add(new Lightning(hammer, sky, 0.45, S.Rng));
            S.Add(new Sparks(hammer, new Vector(0, -60), 10, Storm, S.Rng));
            foreach (var f in Wait(0.3 + S.Rng.NextDouble() * 0.15))
            {
                yield return f;
            }
        }
    }

    /// <summary>An arc through the air to another spot on the taskbar, hammer leading, then a hammer-first landing.</summary>
    private IEnumerable<object?> FlyAndStrike()
    {
        double x = FarX(Size);
        A.Facing = x > A.Foot.X ? 1 : -1;
        A.SetPose("fly", 0.08);
        var previous = A.Foot;
        foreach (var f in Leap(new Point(x, S.Ground), Math.Min(S.Area.Height * 0.6, Size * 3), gravity: 1700))
        {
            // Lean into the path, so the raised hammer points the way he is going:
            // a little while climbing, flat at the top, steeper on the way down.
            var v = A.Foot - previous;
            previous = A.Foot;
            if (v.Length > 0.01)
            {
                double climb = Math.Atan2(-v.Y, Math.Abs(v.X)) * 180 / Math.PI;
                double lean = Math.Clamp((90 - climb) * 0.65, 12, 80);
                A.Rotation += (lean * A.Facing - A.Rotation) * Math.Min(1, S.Dt * 8);
            }
            yield return f;
        }
        foreach (var f in Strike(1.1))
        {
            yield return f;
        }
    }

    /// <summary>Lands hammer first: a bolt onto the hammer as it hits, then he rises to stand.</summary>
    private IEnumerable<object?> Strike(double strength)
    {
        A.Rotation = 0;
        A.SetPose("land", 0.04);
        var hammer = Spot("hammer", 0.2, 0.1);
        S.Add(new Lightning(hammer, new Point(hammer.X + (S.Rng.NextDouble() - 0.5) * Size, S.Area.Top), 0.5, S.Rng));
        S.Add(new Sparks(hammer, new Vector(0, -200), 22, Storm, S.Rng));
        foreach (var f in LandHard("land", strength, cracks: true))
        {
            yield return f;
        }
        foreach (var f in Wait(1.2))
        {
            yield return f;
        }
        A.SetPose("stand", 0.25);
    }

    public override IEnumerable<object?> OnClick()
    {
        foreach (var f in CallLightning(1))
        {
            yield return f;
        }
        foreach (var f in FlyAndStrike())
        {
            yield return f;
        }
    }

    public override IEnumerable<object?> OnDoubleClick()
    {
        FaceMouse();
        A.SetPose("summon", 0.1);
        A.Rotation = 0;
        foreach (var f in Wait(0.2))
        {
            yield return f;
        }
        var hammer = Spot("hammer", 0.1, 0.55);
        var target = S.Mouse;
        if ((target - hammer).Length < Size * 0.3)
        {
            target = hammer + new Vector(A.Facing * Size * 1.5, -Size * 0.3);
        }
        S.Add(new Lightning(hammer, target, 0.6, S.Rng));
        S.Add(new Sparks(target, new Vector(0, -120), 16, Storm, S.Rng));
        foreach (var f in Wait(0.9))
        {
            yield return f;
        }
        A.SetPose("stand", 0.2);
    }

    public override IEnumerable<object?> Dropped(Vector velocity)
    {
        A.SetPose("summon");
        foreach (var f in Fall(velocity))
        {
            yield return f;
        }
        if (LastImpactSpeed > 900)
        {
            foreach (var f in Strike(1.0))
            {
                yield return f;
            }
        }
        else
        {
            foreach (var f in LandHard("stand", 0.35, cracks: false))
            {
                yield return f;
            }
        }
    }
}

/// <summary>
/// Flash: waits at one side of the taskbar. Now and then (or on a click) runs the whole width of the
/// screen in about half a second, leaving lightning streaks and fading after-images, then skids to a stop.
/// </summary>
internal sealed class FlashMoves : HeroMoves
{
    private static readonly Color Gold = Color.FromRgb(255, 210, 60);
    private bool started;

    public FlashMoves(Scene scene)
        : base(scene)
    {
    }

    public override string? Fallback(string pose) => pose switch
    {
        "stop" => "stand",
        _ => "stand",
    };

    public override IEnumerable<object?> Idle()
    {
        if (!started)
        {
            started = true;
            A.Foot = new Point(S.Area.Left + S.Area.Width * 0.08, S.Ground);
            A.Facing = 1;
        }
        A.SetPose("stand", 0.2);
        double until = S.Time + 20 + S.Rng.NextDouble() * 25;
        while (S.Time < until)
        {
            Breathe(0.6);
            yield return null;
        }
        foreach (var f in Run())
        {
            yield return f;
        }
    }

    private IEnumerable<object?> Run()
    {
        double x0 = A.Foot.X;
        double target = x0 < S.Area.Left + S.Area.Width / 2
            ? S.Area.Right - S.Area.Width * 0.08
            : S.Area.Left + S.Area.Width * 0.08;
        A.Facing = target > x0 ? 1 : -1;

        // A quick crouch before the burst.
        double t = 0;
        while (t < 0.12)
        {
            t += S.Dt;
            double k = Math.Min(1, t / 0.12);
            A.ScaleY = 1 - 0.08 * k;
            A.ScaleX = 1 + 0.05 * k;
            yield return null;
        }
        A.ScaleX = A.ScaleY = 1;

        A.SetPose("run", 0.05);
        var bounds = new Rect(Math.Min(x0, target) - Size * 1.5, S.Ground - Size * 1.9, Math.Abs(target - x0) + Size * 3, Size * 2.3);
        var trail = new SpeedTrail(A.CurrentImage(S.Kit, this), bounds, S.Rng);
        S.Add(trail);
        S.StageArea = bounds;

        t = 0;
        while (t < 1)
        {
            t = Math.Min(1, t + S.Dt / 0.55);
            A.Foot = new Point(x0 + (target - x0) * Smooth(t), S.Ground);
            A.Rotation = 6 * A.Facing;
            trail.Add(A.Placement);
            yield return null;
        }
        trail.Stop();

        // Skid: sparks and dust from his heels as he slides to a stop.
        A.SetPose("stop", 0.05);
        A.Rotation = 0;
        S.Add(new Sparks(new Point(A.Foot.X, S.Ground - 3), new Vector(A.Facing * 320, -160), 18, Gold, S.Rng));
        S.Add(new Impact(new Point(A.Foot.X, S.Ground), Size * 0.6, 0.35, false, S.Rng));
        double slide = 0;
        while (slide < 0.3)
        {
            slide += S.Dt;
            A.Foot += new Vector(A.Facing * 420 * (1 - slide / 0.3) * S.Dt, 0);
            yield return null;
        }
        Unstage();
        foreach (var f in Wait(0.5))
        {
            yield return f;
        }
        A.Facing = -A.Facing;
        A.SetPose("stand", 0.15);
    }

    public override IEnumerable<object?> OnClick() => Run();

    public override IEnumerable<object?> Dropped(Vector velocity) => FallAndLand(velocity, "run", "stand", cracks: false);
}

/// <summary>
/// A floating hero (Doctor Doom, or anyone with one picture): drifts and bobs mid-air with glowing
/// magic round his hands, now and then floating to a new spot. Click: a blast at the mouse pointer.
/// </summary>
internal sealed class FloaterMoves : HeroMoves
{
    private static readonly Color Magic = Color.FromRgb(90, 255, 140);
    private Point home;
    private bool started;
    private double castGlow;

    public FloaterMoves(Scene scene)
        : base(scene)
    {
    }

    public override string? Fallback(string pose) => null;

    private Point PickHome() => new(RandomX(Size), S.Area.Top + S.Area.Height * (0.3 + S.Rng.NextDouble() * 0.3));

    public override IEnumerable<object?> Idle()
    {
        if (!started)
        {
            started = true;
            A.Foot = home = PickHome();
        }
        A.SetPose("hover", 0.2);
        double until = S.Time + 18 + S.Rng.NextDouble() * 20;
        while (S.Time < until)
        {
            var bob = new Vector(Math.Sin(S.Time * 0.6) * 5, Math.Sin(S.Time * 2 * Math.PI / 3.2) * 8);
            A.Foot += (home + bob - A.Foot) * Math.Min(1, S.Dt * 3);
            A.Rotation = Math.Sin(S.Time * 0.8) * 2;
            castGlow += (0 - castGlow) * Math.Min(1, S.Dt * 2);
            FaceMouse();
            yield return null;
        }
        var next = PickHome();
        next.X = FarX(Size);
        foreach (var f in FlyTo(next, 260, "hover", bank: false, arc: 0.08))
        {
            yield return f;
        }
        home = next;
    }

    public override IEnumerable<object?> OnClick()
    {
        FaceMouse();
        A.SetPose("cast", 0.1);
        castGlow = 1;
        foreach (var f in Wait(0.25))
        {
            yield return f;
        }
        var hand = Spot("hand", 0.35, 0.3);
        var dir = S.Mouse - hand;
        if (dir.Length < 1)
        {
            dir = new Vector(A.Facing, 0);
        }
        S.Add(new Beam(hand, ToScreenEdge(hand, dir), Magic, Size * 0.045, 0.9, S.Rng));
        foreach (var f in Wait(1.0))
        {
            yield return f;
        }
        A.SetPose("hover", 0.2);
    }

    public override IEnumerable<object?> Dropped(Vector velocity)
    {
        var v = velocity;
        while (v.Length > 20)
        {
            v *= Math.Pow(0.05, S.Dt);
            A.Foot += v * S.Dt;
            KeepOnScreen();
            yield return null;
        }
        var from = A.Foot;
        home = PickHome();
        double t = 0;
        while (t < 1)
        {
            t = Math.Min(1, t + S.Dt / 1.2);
            A.Foot = from + (home - from) * Smooth(t);
            yield return null;
        }
    }

    public override void DrawBehind(DrawingContext dc)
    {
        var image = A.CurrentImage(S.Kit, this);
        var place = A.Placement;
        var hands = image.Points("hands");
        var spots = new List<Point>();
        if (hands.Count > 0)
        {
            foreach (var p in hands)
            {
                spots.Add(image.ToScreen(p, place));
            }
        }
        else
        {
            var c = image.CenterOnScreen(place);
            spots.Add(new Point(c.X - image.Width * 0.35, c.Y + image.Height * 0.05));
            spots.Add(new Point(c.X + image.Width * 0.35, c.Y + image.Height * 0.05));
        }

        double r = Size * (0.08 + 0.05 * castGlow);
        for (int h = 0; h < spots.Count; h++)
        {
            var spot = spots[h];
            dc.DrawEllipse(Fx.Glow(Magic, 0.35 + 0.4 * castGlow), null, spot, r * 2, r * 2);
            for (int i = 0; i < 6; i++)
            {
                double a = S.Time * 3 + i * Math.PI / 3 + h;
                var p = spot + new Vector(Math.Cos(a) * r * 1.4, Math.Sin(a) * r * 0.8);
                dc.DrawEllipse(Fx.Glow(Magic, 0.9), null, p, 3.5, 3.5);
            }
        }
    }
}
