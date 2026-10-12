using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Media;

namespace SpideyHang;

/// <summary>
/// Draws the top fitting, the line, and the hero, from the rig's particle positions.
/// It reads the rig. It never moves particles.
///
/// The hero is either the built-in drawn Spider-Man (Look is null) or a HeroLook of pictures.
/// A HeroLook has poses, and the pose follows the motion (see UpdatePose).
/// </summary>
internal sealed class Stage : FrameworkElement
{
    private static readonly Color Silk = SpideyArt.WebColor;
    private static readonly Color SilkShade = Color.FromRgb(0x9C, 0xA6, 0xB2);
    private static readonly Color SilkDeep = Color.FromRgb(0x5E, 0x67, 0x72);

    /// <summary>How each kind of line looks: shading colours across it, thickness, and extras.</summary>
    private sealed record LinePaint(Color Deep, Color Shade, Color Light, double WidthShare, bool Twist, bool Fibres, Color? Glow);

    private static readonly Dictionary<LineStyle, LinePaint> Paints = new()
    {
        [LineStyle.Web] = new(SilkDeep, SilkShade, Colors.White, 1.0, true, true, null),
        [LineStyle.Cable] = new(Color.FromRgb(0x2E, 0x33, 0x3A), Color.FromRgb(0x7A, 0x84, 0x90), Color.FromRgb(0xE6, 0xEA, 0xEE), 0.95, true, false, null),
        [LineStyle.Lasso] = new(Color.FromRgb(0x8A, 0x5A, 0x10), Color.FromRgb(0xD9, 0xA4, 0x2A), Color.FromRgb(0xFF, 0xF0, 0xB0), 1.15, true, false, Color.FromArgb(70, 0xFF, 0xD2, 0x4A)),
        [LineStyle.Grapple] = new(Color.FromRgb(0x08, 0x08, 0x0A), Color.FromRgb(0x2A, 0x2C, 0x30), Color.FromRgb(0x70, 0x74, 0x7A), 0.7, false, false, null),
    };

    private static readonly Color Steel = Color.FromRgb(0xB8, 0xC0, 0xC8);
    private static readonly Color SteelDark = Color.FromRgb(0x3A, 0x40, 0x48);

    private readonly Rig rig;
    private double armOffset;
    private double? prevTheta;
    private SpideyArt.Cache? cache;

    // Pose state. See UpdatePose.
    private HeroLook? look;
    private string pose = "hang";
    private string? candidate;
    private double candidateTime;
    private CustomFigure? shown;
    private CustomFigure? fadingOut;
    private double fade = 1;
    private double activity;

    public Stage(Rig rig)
    {
        this.rig = rig;
    }

    /// <summary>The hero's pictures. Null means the built-in drawn Spider-Man.</summary>
    public HeroLook? Look
    {
        get => look;
        set
        {
            look = value;
            shown = value?.Pose(pose);
            fadingOut = null;
            fade = 1;
            candidate = null;
        }
    }

    /// <summary>True while the user is dragging him. Shows the grab pose.</summary>
    public bool Dragging { get; set; }

    /// <summary>
    /// Screen pixels per WPF unit. Null means ask the display (1.0 at 100% scaling, 1.5 at 150%).
    /// The snapshot test sets it, because its picture is not on any display.
    /// </summary>
    public double? PixelsPerDip { get; set; }

    /// <summary>
    /// How far between the last two physics steps to draw him: 0 = the step before, 1 = the latest.
    ///
    /// The physics moves in fixed 1/240 s steps, and screen frames do not land exactly on them.
    /// Drawing the latest step meant some frames showed 3 steps of movement and others 5, which
    /// reads as stutter. Drawing the in-between position for each frame keeps the motion even.
    /// </summary>
    public double Blend { get; set; } = 1;

    /// <summary>The pose being shown, for the log and tests.</summary>
    public string CurrentPose => pose;

    /// <summary>True once nothing is still changing on its own: arms still, no pose change or fade under way.</summary>
    public bool Settled => Math.Abs(armOffset) < 0.002 && fade >= 1 && candidate == null;

    private LineStyle Line => look?.Line ?? LineStyle.Web;

    /// <summary>Where to draw a particle this frame. See Blend.</summary>
    private Point At(Particle p)
    {
        double back = 1 - Blend;
        return new Point(p.X - back * (p.X - p.PX), p.Y - back * (p.Y - p.PY));
    }

    /// <summary>Width of the line. Scales with his size.</summary>
    private double RopeWidth => Math.Clamp(rig.BodyLength / 55, 1.8, 3.4);

    public void ResetPose()
    {
        prevTheta = null;
        armOffset = 0;
        activity = 0;
        pose = "hang";
        candidate = null;
        shown = look?.Pose(pose);
        fadingOut = null;
        fade = 1;
    }

    /// <summary>Call once per frame: loose arms lag behind the swing, and the pose follows the motion.</summary>
    public void Advance(double frameDt)
    {
        if (rig.Particles.Count == 0)
        {
            return;
        }
        double theta = BodyAngle();
        if (prevTheta is double prev && frameDt > 0)
        {
            double delta = Math.IEEERemainder(theta - prev, 2 * Math.PI);
            double target = Math.Clamp(-delta / frameDt * 0.1, -0.7, 0.7);
            armOffset += (target - armOffset) * 0.12;
        }
        prevTheta = theta;
        UpdatePose(frameDt);
    }

    /// <summary>
    /// Picks the pose from the motion:
    ///   grab   while being dragged
    ///   fly    when the rope leans more than about 43 degrees
    ///   swing  while moving
    ///   hang   otherwise
    ///
    /// "Moving" uses the recent top speed, fading over about a second, not the speed this instant.
    /// The instant speed drops to zero at both ends of every swing, so he would flick to "hang"
    /// twice a swing. A new pose must also hold for 0.2 s before it shows (dragging shows at once),
    /// and the change cross-fades over 0.25 s.
    /// </summary>
    private void UpdatePose(double frameDt)
    {
        if (look == null)
        {
            return;
        }
        var ankle = rig.Ankle;
        double speed = Math.Sqrt((ankle.X - ankle.PX) * (ankle.X - ankle.PX) + (ankle.Y - ankle.PY) * (ankle.Y - ankle.PY)) / Rig.Step;
        activity = Math.Max(speed, activity * Math.Exp(-frameDt / 0.8));

        // Separate thresholds for starting and stopping a pose, so he cannot flick back and forth
        // while the speed or angle hovers near one value. (With one threshold of 120, a settling
        // swing went hang, swing, hang within half a second.)
        double flyFrom = pose == "fly" ? 0.6 : 0.75;      // radians: about 34 and 43 degrees
        double swingFrom = pose is "swing" or "fly" ? 90 : 150;
        string wanted = Dragging ? "grab"
            : Math.Abs(rig.RopeAngle) > flyFrom ? "fly"
            : activity > swingFrom ? "swing"
            : "hang";

        if (wanted == pose)
        {
            candidate = null;
        }
        else
        {
            if (wanted != candidate)
            {
                candidate = wanted;
                candidateTime = 0;
            }
            candidateTime += frameDt;
            if (Dragging || candidateTime >= 0.2)
            {
                pose = wanted;
                candidate = null;
                var next = look.Pose(pose);
                if (!ReferenceEquals(next, shown))
                {
                    fadingOut = shown;
                    shown = next;
                    fade = 0;
                }
            }
        }

        if (fade < 1)
        {
            fade = Math.Min(1, fade + frameDt / 0.25);
        }
    }

    protected override void OnRender(DrawingContext dc)
    {
        Draw(dc);
    }

    public void Draw(DrawingContext dc)
    {
        if (rig.Particles.Count == 0)
        {
            return;
        }

        var line = SampleRope();
        DrawLine(dc, line);
        DrawTopFitting(dc);

        double degrees = BodyAngle() * 180 / Math.PI;
        var ankle = At(rig.Ankle);
        dc.PushTransform(new TranslateTransform(ankle.X, ankle.Y));

        if (look != null)
        {
            // A picture hangs from its top edge, so it needs 180 degrees less turn than the upright drawing.
            dc.PushTransform(new RotateTransform(degrees - 180));
            if (fadingOut != null && fade < 1)
            {
                dc.PushOpacity(1 - fade);
                fadingOut.Draw(dc);
                dc.Pop();
                dc.PushOpacity(fade);
                shown?.Draw(dc);
                dc.Pop();
            }
            else
            {
                shown?.Draw(dc);
            }
            dc.Pop();
            DrawEndFitting(dc);
        }
        else
        {
            dc.PushTransform(new RotateTransform(degrees));
            double scale = rig.BodyLength / 100;
            dc.PushTransform(new ScaleTransform(scale, scale));

            // Redraw the cached pictures only when his size or the display scaling changes.
            double pixelsPerUnit = scale * (PixelsPerDip ?? VisualTreeHelper.GetDpi(this).PixelsPerDip);
            if (cache == null || Math.Abs(cache.PixelsPerUnit - pixelsPerUnit) > 1e-6)
            {
                cache = SpideyArt.Render(pixelsPerUnit);
            }
            SpideyArt.Draw(dc, armOffset, cache);

            dc.Pop();
            dc.Pop();
        }
        dc.Pop();
    }

    /// <summary>
    /// The angle that turns his upright drawing (feet to head = straight up) onto the ankle-to-head line.
    /// Hanging straight down gives 180 degrees, so he is upside down.
    /// </summary>
    private double BodyAngle()
    {
        var ankle = At(rig.Ankle);
        var head = At(rig.Head);
        return Math.Atan2(head.Y - ankle.Y, head.X - ankle.X) + Math.PI / 2;
    }

    // ---- The line ---------------------------------------------------------------------

    /// <summary>Samples per rope segment. Twist marks and chain links sit on these, so they stay put on the rope.</summary>
    private const int SamplesPerSegment = 4;

    /// <summary>
    /// Points along the smoothed rope, SamplesPerSegment per segment, at fixed places on each segment.
    /// Quadratic curves through the midpoints between particles, so there are no corners.
    /// </summary>
    private List<Point> SampleRope()
    {
        var particles = rig.Particles;
        int count = rig.RopeCount;
        var points = new List<Point>(count * SamplesPerSegment + 4)
        {
            At(particles[0]),
        };

        Point from = points[0];
        for (int i = 1; i < count - 1; i++)
        {
            var control = At(particles[i]);
            var next = At(particles[i + 1]);
            var to = new Point((control.X + next.X) / 2, (control.Y + next.Y) / 2);
            for (int k = 1; k <= SamplesPerSegment; k++)
            {
                double t = (double)k / SamplesPerSegment;
                double u = 1 - t;
                points.Add(new Point(
                    u * u * from.X + 2 * u * t * control.X + t * t * to.X,
                    u * u * from.Y + 2 * u * t * control.Y + t * t * to.Y));
            }
            from = to;
        }
        points.Add(At(rig.Ankle));
        return points;
    }

    private void DrawLine(DrawingContext dc, List<Point> line)
    {
        switch (Line)
        {
            case LineStyle.None:
                return;
            case LineStyle.Chain:
                DrawChain(dc, line);
                return;
            default:
                DrawCord(dc, line, Paints[Line]);
                return;
        }
    }

    /// <summary>
    /// A cord (web, cable, lasso or grapple line), layered back to front:
    ///   1. an invisible wide stroke so the thin line is easy to grab,
    ///   2. an optional glow (the lasso),
    ///   3. a soft shadow (two faint passes, no blur effect needed),
    ///   4. rounded shading: several thin strokes side by side, dark at the edges, bright in the middle,
    ///   5. slanted twist marks, so it reads as twisted strands rather than a plain line,
    ///   6. a bright sheen along one side, and for the web a few stray fibres.
    /// </summary>
    private void DrawCord(DrawingContext dc, List<Point> line, LinePaint paint)
    {
        double w = RopeWidth * paint.WidthShare;
        var normals = Normals(line);

        dc.DrawGeometry(null, RoundPen(SpideyArt.HitArea, Math.Max(10, w * 4)), Polyline(line));

        if (paint.Glow is Color glow)
        {
            dc.DrawGeometry(null, RoundPen(Brush(glow), w * 4), Polyline(line));
            dc.DrawGeometry(null, RoundPen(Brush(Color.FromArgb((byte)(glow.A * 1.6), glow.R, glow.G, glow.B)), w * 2.2), Polyline(line));
        }

        dc.DrawGeometry(null, RoundPen(Brush(Color.FromArgb(40, 0, 0, 0)), w + 3.2), Polyline(Shift(line, 0.9, 1.2)));
        dc.DrawGeometry(null, RoundPen(Brush(Color.FromArgb(70, 0, 0, 0)), w + 1.4), Polyline(Shift(line, 0.4, 0.6)));

        var tones = new[] { paint.Deep, paint.Shade, paint.Light, paint.Shade, paint.Deep };
        int bands = tones.Length;
        for (int i = 0; i < bands; i++)
        {
            double across = (i - (bands - 1) / 2.0) / bands * w;
            dc.DrawGeometry(null, RoundPen(Brush(tones[i]), w / bands * 1.6), Polyline(Offset(line, normals, across)));
        }

        // Twist marks sit on the fixed sample points, so they move with the rope.
        // Do not go back to a dashed pen: dashes are measured along the curve, and as the rope
        // bent the curve's length changed, so the dashes crept up and down the rope while he swung.
        if (paint.Twist)
        {
            var twist = new StreamGeometry();
            using (var ctx = twist.Open())
            {
                for (int i = 2; i < line.Count - 2; i++)
                {
                    Vector along = line[i + 1] - line[i - 1];
                    if (along.LengthSquared < 1e-9)
                    {
                        continue;
                    }
                    along.Normalize();
                    ctx.BeginFigure(line[i] - normals[i] * (w * 0.38) - along * (w * 0.3), false, false);
                    ctx.LineTo(line[i] + normals[i] * (w * 0.38) + along * (w * 0.3), true, false);
                }
            }
            twist.Freeze();
            dc.DrawGeometry(null, RoundPen(Brush(Color.FromArgb(120, paint.Deep.R, paint.Deep.G, paint.Deep.B)), w * 0.28), twist);
        }

        dc.DrawGeometry(null, RoundPen(Brush(Color.FromArgb(200, 255, 255, 255)), w * 0.18), Polyline(Offset(line, normals, -w * 0.28)));

        if (paint.Fibres)
        {
            DrawFibres(dc, line, normals, w);
        }
    }

    /// <summary>
    /// A steel chain: a link on every other sample point, alternating face-on (a ring) and
    /// edge-on (a short bar). The links sit on fixed sample points, so they move with the rope.
    /// </summary>
    private void DrawChain(DrawingContext dc, List<Point> line)
    {
        double w = RopeWidth;
        double length = Math.Max(6, w * 2.6);
        double width = length * 0.62;
        double thick = Math.Max(1.1, w * 0.5);

        dc.DrawGeometry(null, RoundPen(SpideyArt.HitArea, Math.Max(10, w * 4)), Polyline(line));

        var outline = RoundPen(Brush(SteelDark), thick + 1.2);
        var metal = RoundPen(Brush(Steel), thick);
        var shine = RoundPen(Brush(Color.FromArgb(200, 255, 255, 255)), thick * 0.35);

        int link = 0;
        for (int i = 1; i < line.Count - 1; i += 2, link++)
        {
            Vector along = line[i + 1] - line[i - 1];
            if (along.LengthSquared < 1e-9)
            {
                continue;
            }
            double degrees = Math.Atan2(along.Y, along.X) * 180 / Math.PI;
            var p = line[i];
            dc.PushTransform(new RotateTransform(degrees, p.X, p.Y));
            if (link % 2 == 0)
            {
                dc.DrawEllipse(null, outline, p, length / 2, width / 2);
                dc.DrawEllipse(null, metal, p, length / 2, width / 2);
                dc.DrawLine(shine, new Point(p.X - length * 0.25, p.Y - width * 0.42), new Point(p.X + length * 0.2, p.Y - width * 0.42));
            }
            else
            {
                var a = new Point(p.X - length / 2, p.Y);
                var b = new Point(p.X + length / 2, p.Y);
                dc.DrawLine(outline, a, b);
                dc.DrawLine(metal, a, b);
            }
            dc.Pop();
        }
    }

    /// <summary>
    /// A few loose strands sticking out of the web. Each belongs to a fixed sample point, so it
    /// rides along with the rope. (Placing them by distance along the curve made them jump about.)
    /// </summary>
    private static void DrawFibres(DrawingContext dc, List<Point> line, Vector[] normals, double w)
    {
        var fibres = new StreamGeometry();
        using (var ctx = fibres.Open())
        {
            int index = 0;
            for (int i = 6; i < line.Count - 3; i += 5 + (index * 3 % 4))
            {
                // Fixed pseudo-random pattern, so fibres look scattered but never move along the rope.
                double side = index % 2 == 0 ? 1 : -1;
                double length = 2.2 + (index * 37 % 5) * 0.6;
                Vector along = line[i + 1] - line[i - 1];
                if (along.LengthSquared < 1e-9)
                {
                    continue;
                }
                along.Normalize();
                var start = line[i] + normals[i] * side * w * 0.4;
                ctx.BeginFigure(start, false, false);
                ctx.QuadraticBezierTo(start + along * length * 0.5 + normals[i] * side * length * 0.25,
                    start + along * length + normals[i] * side * length * 0.6, true, false);
                index++;
            }
        }
        fibres.Freeze();
        dc.DrawGeometry(null, RoundPen(Brush(Color.FromArgb(150, Silk.R, Silk.G, Silk.B)), 0.5), fibres);
    }

    // ---- Fittings at each end of the line ------------------------------------------------

    /// <summary>
    /// What holds the line at the top of the screen. Also the handle you drag to move him along the top,
    /// so it keeps an invisible grab area even when nothing is drawn.
    /// </summary>
    private void DrawTopFitting(DrawingContext dc)
    {
        double cx = rig.Anchor.X;
        double cy = rig.Anchor.Y;
        dc.DrawEllipse(SpideyArt.HitArea, null, new Point(cx, cy * 0.6), 18, 18);

        switch (Line)
        {
            case LineStyle.None:
                return;
            case LineStyle.Web:
                DrawSplat(dc, cx, cy);
                return;
            default:
                // A small steel plate fixed to the top edge, with a ring the line hangs from.
                dc.DrawRoundedRectangle(Brush(Steel), RoundPen(Brush(SteelDark), 1), new Rect(cx - 7, -3, 14, cy * 0.75 + 3), 2.5, 2.5);
                DrawRing(dc, new Point(cx, cy), RopeWidth * 1.1);
                return;
        }
    }

    /// <summary>What joins the line to the picture.</summary>
    private void DrawEndFitting(DrawingContext dc)
    {
        switch (Line)
        {
            case LineStyle.None:
                return;
            case LineStyle.Web:
                DrawBlob(dc, new Point(0, 0), RopeWidth * 1.1);
                return;
            default:
                DrawRing(dc, new Point(0, 0), RopeWidth * 1.0);
                return;
        }
    }

    /// <summary>Where the web sticks to the top of the screen: strands fanning out, a blob, and dabs where each strand lands.</summary>
    private void DrawSplat(DrawingContext dc, double cx, double cy)
    {
        var strands = new StreamGeometry();
        var dabs = new List<Point>();
        using (var ctx = strands.Open())
        {
            foreach (double dx in new[] { -19.0, -12.0, -6.5, -2.0, 3.0, 8.5, 14.0, 20.0 })
            {
                var end = new Point(cx + dx, 0);
                ctx.BeginFigure(new Point(cx, cy), false, false);
                ctx.QuadraticBezierTo(new Point(cx + dx * 0.3, cy * 0.45), end, true, false);
                dabs.Add(end);
            }
            // Cross strands, like the start of a real web.
            ctx.BeginFigure(new Point(cx - 10, 3.4), false, false);
            ctx.QuadraticBezierTo(new Point(cx, 5.2), new Point(cx + 11, 3.2), true, false);
            ctx.BeginFigure(new Point(cx - 15, 1.2), false, false);
            ctx.QuadraticBezierTo(new Point(cx, 3.0), new Point(cx + 16, 1.2), true, false);
        }
        strands.Freeze();

        dc.DrawGeometry(null, RoundPen(Brush(Color.FromArgb(70, 0, 0, 0)), 1.8), strands);
        dc.DrawGeometry(null, RoundPen(Brush(Silk), 0.75), strands);

        var dab = Brush(Color.FromArgb(225, Silk.R, Silk.G, Silk.B));
        foreach (var p in dabs)
        {
            dc.DrawEllipse(dab, null, p, 1.6, 1.1);
        }
        DrawBlob(dc, new Point(cx, cy), RopeWidth * 1.2);
    }

    private static void DrawBlob(DrawingContext dc, Point at, double radius)
    {
        var fill = new RadialGradientBrush(Colors.White, SilkShade)
        {
            GradientOrigin = new Point(0.35, 0.3),
        };
        fill.Freeze();
        dc.DrawEllipse(fill, RoundPen(Brush(Color.FromArgb(110, 0, 0, 0)), 0.8), at, radius, radius * 1.15);
    }

    private static void DrawRing(DrawingContext dc, Point at, double radius)
    {
        dc.DrawEllipse(null, RoundPen(Brush(SteelDark), 2.4), at, radius + 1, radius + 1);
        dc.DrawEllipse(null, RoundPen(Brush(Steel), 1.4), at, radius + 1, radius + 1);
    }

    // ---- Small helpers ----------------------------------------------------------------

    private static Vector[] Normals(List<Point> line)
    {
        var normals = new Vector[line.Count];
        for (int i = 0; i < line.Count; i++)
        {
            Vector d = line[Math.Min(i + 1, line.Count - 1)] - line[Math.Max(i - 1, 0)];
            if (d.LengthSquared < 1e-9)
            {
                d = new Vector(0, 1);
            }
            d.Normalize();
            normals[i] = new Vector(-d.Y, d.X);
        }
        return normals;
    }

    private static List<Point> Offset(List<Point> line, Vector[] normals, double distance)
    {
        var result = new List<Point>(line.Count);
        for (int i = 0; i < line.Count; i++)
        {
            result.Add(line[i] + normals[i] * distance);
        }
        return result;
    }

    private static List<Point> Shift(List<Point> line, double dx, double dy)
    {
        var result = new List<Point>(line.Count);
        foreach (var p in line)
        {
            result.Add(new Point(p.X + dx, p.Y + dy));
        }
        return result;
    }

    private static Geometry Polyline(List<Point> points)
    {
        var geometry = new StreamGeometry();
        using (var ctx = geometry.Open())
        {
            ctx.BeginFigure(points[0], false, false);
            ctx.PolyLineTo(points.GetRange(1, points.Count - 1), true, true);
        }
        geometry.Freeze();
        return geometry;
    }

    private static Pen RoundPen(Brush brush, double thickness)
    {
        var pen = new Pen(brush, thickness)
        {
            StartLineCap = PenLineCap.Round,
            EndLineCap = PenLineCap.Round,
            LineJoin = PenLineJoin.Round,
        };
        pen.Freeze();
        return pen;
    }

    private static Brush Brush(Color color)
    {
        var brush = new SolidColorBrush(color);
        brush.Freeze();
        return brush;
    }
}
