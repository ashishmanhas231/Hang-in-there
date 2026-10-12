using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Media;

namespace SpideyHang;

/// <summary>
/// A short-lived effect drawn in screen coordinates (WPF units).
/// Bounds is fixed for the effect's whole life: the live app gives each effect a window that size,
/// so it must cover everywhere the effect can ever draw.
/// </summary>
internal interface IEffect
{
    bool Alive { get; }
    Rect Bounds { get; }
    void Update(double dt);
    void Draw(DrawingContext dc);
}

/// <summary>Drawing helpers shared by effects and moves.</summary>
internal static class Fx
{
    public static Brush Solid(Color c, double alpha = 1)
    {
        var b = new SolidColorBrush(Color.FromArgb((byte)Math.Clamp(c.A * alpha, 0, 255), c.R, c.G, c.B));
        b.Freeze();
        return b;
    }

    public static Pen Pen(Color c, double thickness, double alpha = 1)
    {
        var p = new Pen(Solid(c, alpha), thickness)
        {
            StartLineCap = PenLineCap.Round,
            EndLineCap = PenLineCap.Round,
            LineJoin = PenLineJoin.Round,
        };
        p.Freeze();
        return p;
    }

    /// <summary>A soft round glow: bright in the middle, fading to nothing at the edge.</summary>
    public static Brush Glow(Color c, double alpha = 1)
    {
        var b = new RadialGradientBrush
        {
            GradientStops =
            {
                new GradientStop(Color.FromArgb((byte)Math.Clamp(255 * alpha, 0, 255), c.R, c.G, c.B), 0),
                new GradientStop(Color.FromArgb((byte)Math.Clamp(110 * alpha, 0, 255), c.R, c.G, c.B), 0.45),
                new GradientStop(Color.FromArgb(0, c.R, c.G, c.B), 1),
            },
        };
        b.Freeze();
        return b;
    }

    public static Geometry Polyline(IReadOnlyList<Point> points)
    {
        var g = new StreamGeometry();
        using (var ctx = g.Open())
        {
            ctx.BeginFigure(points[0], false, false);
            for (int i = 1; i < points.Count; i++)
            {
                ctx.LineTo(points[i], true, true);
            }
        }
        g.Freeze();
        return g;
    }

    /// <summary>
    /// A thruster or jet flame: a white-hot core inside a blue glow, flickering.
    /// dir: the way the flame points (away from the boot or palm).
    /// </summary>
    public static void Flame(DrawingContext dc, Point origin, Vector dir, double length, double width, double time, double seed, Color tint)
    {
        // Two out-of-step waves make an irregular flicker without needing random numbers per frame.
        double flicker = 0.82 + 0.12 * Math.Sin(time * 37 + seed * 11) + 0.08 * Math.Sin(time * 61 + seed * 5);
        double len = length * flicker;
        var tip = origin + dir * len;
        var side = new Vector(-dir.Y, dir.X);

        // Outer glow, then the flame body, then the hot core.
        dc.DrawEllipse(Glow(tint, 0.55), null, origin + dir * (len * 0.35), width * 1.6, width * 1.6);
        Teardrop(dc, origin, tip, side, width * 0.75, Solid(tint, 0.85));
        Teardrop(dc, origin, origin + dir * (len * 0.55), side, width * 0.38, Solid(Colors.White, 0.95));
    }

    private static void Teardrop(DrawingContext dc, Point origin, Point tip, Vector side, double halfWidth, Brush fill)
    {
        var g = new StreamGeometry();
        using (var ctx = g.Open())
        {
            ctx.BeginFigure(origin + side * halfWidth, true, true);
            ctx.QuadraticBezierTo(origin + side * halfWidth + (tip - origin) * 0.6, tip, true, true);
            ctx.QuadraticBezierTo(origin - side * halfWidth + (tip - origin) * 0.6, origin - side * halfWidth, true, true);
            ctx.ArcTo(origin + side * halfWidth, new Size(halfWidth, halfWidth), 0, false, SweepDirection.Clockwise, true, true);
        }
        g.Freeze();
        dc.DrawGeometry(fill, null, g);
    }

    /// <summary>A jagged line from a to b, by repeatedly nudging midpoints sideways. Used for lightning and cracks.</summary>
    public static List<Point> Jagged(Point a, Point b, double roughness, int depth, Random rng)
    {
        var points = new List<Point> { a, b };
        double offset = (b - a).Length * roughness;
        for (int d = 0; d < depth; d++)
        {
            var next = new List<Point>(points.Count * 2) { points[0] };
            for (int i = 1; i < points.Count; i++)
            {
                var p = points[i - 1];
                var q = points[i];
                var dir = q - p;
                var normal = new Vector(-dir.Y, dir.X);
                if (normal.LengthSquared > 1e-9)
                {
                    normal.Normalize();
                }
                var mid = p + dir / 2 + normal * ((rng.NextDouble() * 2 - 1) * offset);
                next.Add(mid);
                next.Add(q);
            }
            points = next;
            offset *= 0.55;
        }
        return points;
    }
}

/// <summary>
/// A heavy landing: a ring of dust thrown out sideways, a flat shockwave along the ground,
/// chips of debris, and optionally cracks spreading into the taskbar below the impact.
/// </summary>
internal sealed class Impact : IEffect
{
    private sealed class Puff
    {
        public Point P;
        public Vector V;
        public double Radius;
        public double Grow;
        public double Life;
        public double Age;
        public bool Chip;
    }

    private static readonly Color DustColor = Color.FromRgb(150, 138, 120);
    private const double CrackLife = 2.8;

    private readonly List<Puff> puffs = new();
    private readonly List<List<Point>> cracks = new();
    private readonly Point ground;
    private readonly double size;
    private double age;

    public Impact(Point ground, double size, double strength, bool withCracks, Random rng)
    {
        this.ground = ground;
        this.size = size;
        double s = size / 170;

        int count = (int)(18 + 16 * strength);
        for (int i = 0; i < count; i++)
        {
            int side = i % 2 == 0 ? 1 : -1;
            puffs.Add(new Puff
            {
                P = ground + new Vector(side * rng.NextDouble() * size * 0.25, -rng.NextDouble() * 6),
                V = new Vector(side * (60 + rng.NextDouble() * 380 * strength) * s, -(20 + rng.NextDouble() * 200 * strength) * s),
                Radius = size * (0.05 + rng.NextDouble() * 0.06),
                Grow = size * (0.10 + rng.NextDouble() * 0.12),
                Life = 0.7 + rng.NextDouble() * 0.7,
            });
        }
        for (int i = 0; i < (int)(6 * strength); i++)
        {
            puffs.Add(new Puff
            {
                P = ground + new Vector((rng.NextDouble() - 0.5) * size * 0.3, -4),
                V = new Vector((rng.NextDouble() - 0.5) * 520 * s, -(250 + rng.NextDouble() * 350) * s * strength),
                Radius = 1.5 + rng.NextDouble() * 2.5,
                Life = 0.9,
                Chip = true,
            });
        }

        if (withCracks)
        {
            // Cracks spread out and down into the taskbar, like the floor gave way under him.
            int branches = 5 + rng.Next(3);
            for (int i = 0; i < branches; i++)
            {
                double angle = Math.PI * (0.05 + 0.9 * (i + rng.NextDouble() * 0.6) / branches);
                double length = size * (0.35 + rng.NextDouble() * 0.45) * strength;
                var end = ground + new Vector(Math.Cos(angle) * length * 1.8, Math.Sin(angle) * length * 0.32);
                cracks.Add(Fx.Jagged(ground + new Vector(0, 1), end, 0.22, 4, rng));
            }
        }

        Bounds = new Rect(ground.X - size * 2.8, ground.Y - size * 1.4, size * 5.6, size * 1.4 + size * 0.45);
    }

    public Rect Bounds { get; }
    public bool Alive => age < CrackLife;

    public void Update(double dt)
    {
        age += dt;
        foreach (var p in puffs)
        {
            p.Age += dt;
            p.V *= p.Chip ? 0.995 : Math.Pow(0.08, dt);
            p.V += new Vector(0, (p.Chip ? 1400 : 120) * dt);
            p.P += p.V * dt;
            if (!p.Chip && p.P.Y > ground.Y - p.Radius * 0.4)
            {
                p.P = new Point(p.P.X, ground.Y - p.Radius * 0.4);
            }
        }
    }

    public void Draw(DrawingContext dc)
    {
        // Shockwave: a flat ring racing out along the ground.
        if (age < 0.4)
        {
            double t = age / 0.4;
            double rx = size * (0.3 + 2.4 * t);
            dc.DrawEllipse(null, Fx.Pen(Colors.White, 2.5, (1 - t) * 0.7), ground, rx, rx * 0.12);
        }

        if (cracks.Count > 0)
        {
            double fade = age < CrackLife - 0.8 ? 1 : Math.Max(0, (CrackLife - age) / 0.8);
            double grow = Math.Min(1, age / 0.12);
            foreach (var crack in cracks)
            {
                int n = Math.Max(2, (int)(crack.Count * grow));
                var shown = crack.GetRange(0, n);
                var geometry = Fx.Polyline(shown);
                dc.DrawGeometry(null, Fx.Pen(Color.FromRgb(20, 16, 12), 3.2, 0.8 * fade), geometry);
                dc.DrawGeometry(null, Fx.Pen(Color.FromRgb(235, 228, 215), 1.2, 0.9 * fade), geometry);
            }
        }

        foreach (var p in puffs)
        {
            if (p.Age >= p.Life)
            {
                continue;
            }
            double t = p.Age / p.Life;
            if (p.Chip)
            {
                dc.DrawRectangle(Fx.Solid(Color.FromRgb(60, 52, 44), 1 - t), null, new Rect(p.P.X - p.Radius, p.P.Y - p.Radius, p.Radius * 2, p.Radius * 2));
            }
            else
            {
                double r = p.Radius + p.Grow * t;
                dc.DrawEllipse(Fx.Glow(DustColor, Math.Pow(1 - t, 1.3) * 0.6), null, p.P, r, r * 0.8);
            }
        }
    }
}

/// <summary>An energy beam: a white core in a coloured glow, with a flash where it starts.</summary>
internal sealed class Beam : IEffect
{
    private readonly Point from;
    private readonly Point to;
    private readonly Color color;
    private readonly double width;
    private readonly double life;
    private readonly Random rng;
    private double age;

    public Beam(Point from, Point to, Color color, double width, double life, Random rng)
    {
        this.from = from;
        this.to = to;
        this.color = color;
        this.width = width;
        this.life = life;
        this.rng = rng;
        var r = new Rect(from, to);
        r.Inflate(width * 4, width * 4);
        Bounds = r;
    }

    public Rect Bounds { get; }
    public bool Alive => age < life;

    public void Update(double dt) => age += dt;

    public void Draw(DrawingContext dc)
    {
        double e = age < 0.06 ? age / 0.06 : age > life - 0.2 ? Math.Max(0, (life - age) / 0.2) : 1;
        double w = width * (0.85 + 0.3 * rng.NextDouble());
        dc.DrawLine(Fx.Pen(color, w * 3.4, 0.30 * e), from, to);
        dc.DrawLine(Fx.Pen(color, w * 1.7, 0.75 * e), from, to);
        dc.DrawLine(Fx.Pen(Colors.White, w * 0.7, e), from, to);
        dc.DrawEllipse(Fx.Glow(color, e), null, from, w * 2.6, w * 2.6);
        dc.DrawEllipse(Fx.Glow(Colors.White, e * 0.9), null, from, w * 1.1, w * 1.1);
        dc.DrawEllipse(Fx.Glow(color, e * 0.7), null, to, w * 2, w * 2);
    }
}

/// <summary>A lightning strike between two points. The bolt is redrawn in a new shape every 50 ms so it crackles.</summary>
internal sealed class Lightning : IEffect
{
    private static readonly Color Blue = Color.FromRgb(140, 190, 255);
    private readonly Point a;
    private readonly Point b;
    private readonly Random rng;
    private readonly double life;
    private List<List<Point>> bolts = new();
    private double age;
    private double nextShape;

    public Lightning(Point a, Point b, double life, Random rng)
    {
        this.a = a;
        this.b = b;
        this.life = life;
        this.rng = rng;
        double spread = (b - a).Length * 0.35 + 40;
        var r = new Rect(a, b);
        r.Inflate(spread, 20);
        Bounds = r;
        Reshape();
    }

    public Rect Bounds { get; }
    public bool Alive => age < life;

    private void Reshape()
    {
        bolts = new List<List<Point>>();
        var main = Fx.Jagged(a, b, 0.16, 6, rng);
        bolts.Add(main);
        for (int i = 0; i < 2; i++)
        {
            var start = main[rng.Next(main.Count / 4, main.Count * 3 / 4)];
            var dir = b - a;
            var side = new Vector(-dir.Y, dir.X);
            side.Normalize();
            var end = start + dir * (0.2 + rng.NextDouble() * 0.2) + side * ((rng.NextDouble() - 0.5) * dir.Length * 0.5);
            bolts.Add(Fx.Jagged(start, end, 0.2, 4, rng));
        }
    }

    public void Update(double dt)
    {
        age += dt;
        nextShape -= dt;
        if (nextShape <= 0)
        {
            Reshape();
            nextShape = 0.05;
        }
    }

    public void Draw(DrawingContext dc)
    {
        // Strikes flicker: bright, dim, bright, then gone.
        double t = age / life;
        double e = t < 0.25 ? 1 : t < 0.4 ? 0.35 : t < 0.7 ? 0.9 : Math.Max(0, (1 - t) / 0.3);
        for (int i = 0; i < bolts.Count; i++)
        {
            var g = Fx.Polyline(bolts[i]);
            double main = i == 0 ? 1 : 0.6;
            dc.DrawGeometry(null, Fx.Pen(Blue, 9 * main, 0.22 * e), g);
            dc.DrawGeometry(null, Fx.Pen(Blue, 3.5 * main, 0.75 * e), g);
            dc.DrawGeometry(null, Fx.Pen(Colors.White, 1.4 * main, e), g);
        }
        dc.DrawEllipse(Fx.Glow(Blue, e * 0.8), null, a, 26, 26);
    }
}

/// <summary>Hot sparks flying from a point, falling as they fade.</summary>
internal sealed class Sparks : IEffect
{
    private sealed class Spark
    {
        public Point P;
        public Vector V;
        public double Life;
        public double Age;
    }

    private readonly List<Spark> sparks = new();
    private readonly Color color;
    private double age;

    public Sparks(Point at, Vector bias, int count, Color color, Random rng)
    {
        this.color = color;
        for (int i = 0; i < count; i++)
        {
            double angle = rng.NextDouble() * Math.PI * 2;
            double speed = 150 + rng.NextDouble() * 450;
            sparks.Add(new Spark
            {
                P = at,
                V = new Vector(Math.Cos(angle) * speed, Math.Sin(angle) * speed) + bias,
                Life = 0.3 + rng.NextDouble() * 0.35,
            });
        }
        Bounds = new Rect(at.X - 260, at.Y - 260, 520, 520);
    }

    public Rect Bounds { get; }
    public bool Alive => age < 0.7;

    public void Update(double dt)
    {
        age += dt;
        foreach (var s in sparks)
        {
            s.Age += dt;
            s.V += new Vector(0, 900 * dt);
            s.P += s.V * dt;
        }
    }

    public void Draw(DrawingContext dc)
    {
        foreach (var s in sparks)
        {
            if (s.Age >= s.Life)
            {
                continue;
            }
            double e = 1 - s.Age / s.Life;
            dc.DrawLine(Fx.Pen(color, 2, e), s.P, s.P - s.V * 0.025);
            dc.DrawLine(Fx.Pen(Colors.White, 0.9, e), s.P, s.P - s.V * 0.012);
        }
    }
}

/// <summary>
/// Speed trail for a very fast run: fading after-images of the runner, and crackling streaks of
/// lightning along the path behind him. Bounds is the whole run, set when the run starts.
/// </summary>
internal sealed class SpeedTrail : IEffect
{
    private static readonly Color Gold = Color.FromRgb(255, 200, 40);
    private static readonly Color Orange = Color.FromRgb(255, 120, 20);
    private const double GhostLife = 0.22;

    private readonly PoseImage pose;
    private readonly List<(Placement Place, double Time)> ghosts = new();
    private readonly List<Point> path = new();
    private readonly Random rng;
    private double now;
    private double stoppedAt = -1;

    public SpeedTrail(PoseImage pose, Rect bounds, Random rng)
    {
        this.pose = pose;
        this.rng = rng;
        Bounds = bounds;
    }

    public Rect Bounds { get; }
    public bool Alive => stoppedAt < 0 || now - stoppedAt < 0.5;

    public void Add(Placement place)
    {
        ghosts.Add((place, now));
        path.Add(pose.CenterOnScreen(place));
    }

    public void Stop() => stoppedAt = now;

    public void Update(double dt)
    {
        now += dt;
        ghosts.RemoveAll(g => now - g.Time > GhostLife);
    }

    public void Draw(DrawingContext dc)
    {
        double fade = stoppedAt < 0 ? 1 : Math.Max(0, 1 - (now - stoppedAt) / 0.5);

        // Streaks: two jagged lines through the last stretch of the path, freshly jagged each frame.
        if (path.Count >= 2)
        {
            var from = path[Math.Max(0, path.Count - 14)];
            var to = path[^1];
            for (int i = 0; i < 2; i++)
            {
                var offset = new Vector(0, (i == 0 ? -1 : 1) * pose.Height * 0.12);
                var line = Fx.Jagged(from + offset, to + offset, 0.06, 4, rng);
                var g = Fx.Polyline(line);
                dc.DrawGeometry(null, Fx.Pen(Orange, 5, 0.35 * fade), g);
                dc.DrawGeometry(null, Fx.Pen(Gold, 2, 0.9 * fade), g);
                dc.DrawGeometry(null, Fx.Pen(Colors.White, 0.8, fade), g);
            }
        }

        foreach (var (place, time) in ghosts)
        {
            double e = 1 - (now - time) / GhostLife;
            pose.Draw(dc, place, e * 0.45 * fade);
        }
    }
}
