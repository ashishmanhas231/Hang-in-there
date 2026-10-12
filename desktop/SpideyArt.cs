using System;
using System.Windows;
using System.Windows.Media;

namespace SpideyHang;

/// <summary>
/// Draws Spider-Man upright in a 100-unit space: ankles at (0, 0), top of head at (0, -100).
/// His hands reach past his head to about y = -122. Hanging upside down, that is his arms dangling.
/// The caller rotates this onto the rope, which turns him upside down while he hangs.
///
/// Every part is drawn twice, so only the outer silhouette gets a dark outline:
///   1. filled with a thick dark pen (the outline),
///   2. filled again with its real colours on top. That hides the outline wherever two parts meet.
/// </summary>
internal static class SpideyArt
{
    private static readonly Color RedDark = Color.FromRgb(0x5A, 0x07, 0x0F);
    private static readonly Color Red = Color.FromRgb(0xC2, 0x1A, 0x26);
    private static readonly Color RedLight = Color.FromRgb(0xF2, 0x5C, 0x5E);
    private static readonly Color BlueDark = Color.FromRgb(0x09, 0x16, 0x40);
    private static readonly Color Blue = Color.FromRgb(0x1D, 0x46, 0x9C);
    private static readonly Color BlueLight = Color.FromRgb(0x5E, 0x8A, 0xDC);
    private static readonly Color OutlineColor = Color.FromRgb(0x12, 0x05, 0x08);

    public static readonly Color WebColor = Color.FromRgb(0xF1, 0xF3, 0xF6);

    /// <summary>
    /// Alpha 1 of 255. Looks invisible, but Windows still sends clicks to it.
    /// Fully transparent pixels (alpha 0) let clicks fall through to the window underneath.
    /// </summary>
    public static readonly Brush HitArea = Solid(Color.FromArgb(1, 0, 0, 0));

    private static readonly Brush OutlineFill = Solid(OutlineColor);
    private static readonly Pen OutlinePen = Frozen(new Pen(OutlineFill, 1.3) { LineJoin = PenLineJoin.Round });
    private static readonly Pen EdgePen = Frozen(new Pen(Solid(Color.FromArgb(150, 0x12, 0x05, 0x08)), 0.45) { LineJoin = PenLineJoin.Round });
    private static readonly Pen SuitWebPen = Frozen(new Pen(Solid(Color.FromArgb(220, 0x22, 0x04, 0x08)), 0.3));
    private static readonly Pen MusclePen = Frozen(new Pen(Solid(Color.FromArgb(80, 0, 0, 0)), 0.6)
    {
        StartLineCap = PenLineCap.Round, EndLineCap = PenLineCap.Round,
    });
    private static readonly Brush Ink = Solid(Color.FromRgb(0x0B, 0x0B, 0x10));
    private static readonly Pen EmblemPen = Frozen(new Pen(Ink, 0.62)
    {
        StartLineCap = PenLineCap.Round, EndLineCap = PenLineCap.Round, LineJoin = PenLineJoin.Round,
    });
    private static readonly Pen EyeFramePen = Frozen(new Pen(Ink, 1.2) { LineJoin = PenLineJoin.Round });
    private static readonly Brush LensBrush = Frozen(new LinearGradientBrush(Color.FromRgb(0xFF, 0xFF, 0xFF), Color.FromRgb(0xC4, 0xCD, 0xD8), 90));
    private static readonly Brush LensGlint = Solid(Color.FromArgb(230, 255, 255, 255));
    private static readonly Pen WrapPen = Frozen(new Pen(Solid(Color.FromArgb(240, 0xF1, 0xF3, 0xF6)), 0.55));
    private static readonly Pen WrapShadowPen = Frozen(new Pen(Solid(Color.FromArgb(110, 0, 0, 0)), 1.1));

    // Must stay last: it uses every brush and pen above. Static fields initialise in source order.
    private static readonly Drawing Body = BuildBody();

    /// <summary>
    /// Pre-drawn pictures of the body and both arms. Drawing all the web lines live costs about
    /// 4x the CPU of drawing these pictures, because the overlay is drawn in software.
    ///
    /// The arms are drawn at rest. Swinging only turns an arm around its shoulder, so turning the
    /// picture gives exactly the same result.
    /// </summary>
    public sealed record Cache(
        double PixelsPerUnit,
        ImageSource Body, Rect BodyRect,
        ImageSource LeftArm, Rect LeftRect, Point LeftShoulder,
        ImageSource RightArm, Rect RightRect, Point RightShoulder);

    /// <summary>Draws the pictures once, at `pixelsPerUnit` screen pixels per drawing unit.</summary>
    public static Cache Render(double pixelsPerUnit)
    {
        var left = BuildArm(-1, 0);
        var right = BuildArm(1, 0);
        var (body, bodyRect) = Rasterize(dc => dc.DrawDrawing(Body), Body.Bounds, pixelsPerUnit);
        var (leftArm, leftRect) = Rasterize(dc => DrawWholeArm(dc, left), ArmBounds(left), pixelsPerUnit);
        var (rightArm, rightRect) = Rasterize(dc => DrawWholeArm(dc, right), ArmBounds(right), pixelsPerUnit);
        return new Cache(pixelsPerUnit, body, bodyRect, leftArm, leftRect, left.Shoulder, rightArm, rightRect, right.Shoulder);
    }

    /// <summary>Fast path: draws the pre-drawn pictures, with each arm turned by armOffset around its shoulder.</summary>
    public static void Draw(DrawingContext dc, double armOffset, Cache cache)
    {
        double degrees = armOffset * 180 / Math.PI;
        dc.PushTransform(new RotateTransform(degrees, cache.LeftShoulder.X, cache.LeftShoulder.Y));
        dc.DrawImage(cache.LeftArm, cache.LeftRect);
        dc.Pop();
        dc.PushTransform(new RotateTransform(degrees, cache.RightShoulder.X, cache.RightShoulder.Y));
        dc.DrawImage(cache.RightArm, cache.RightRect);
        dc.Pop();
        dc.DrawImage(cache.Body, cache.BodyRect);
    }

    private static void DrawWholeArm(DrawingContext dc, Arm arm)
    {
        dc.DrawGeometry(OutlineFill, OutlinePen, arm.Limb);
        dc.DrawGeometry(OutlineFill, OutlinePen, arm.Hand);
        DrawArm(dc, arm);
    }

    private static Rect ArmBounds(Arm arm)
    {
        var bounds = arm.Limb.Bounds;
        bounds.Union(arm.Hand.Bounds);
        return bounds;
    }

    private static (ImageSource Image, Rect Rect) Rasterize(Action<DrawingContext> draw, Rect bounds, double pixelsPerUnit)
    {
        // Room for the outline pen, which sits half outside each shape.
        bounds.Inflate(1.5, 1.5);
        int width = Math.Max(1, (int)Math.Ceiling(bounds.Width * pixelsPerUnit));
        int height = Math.Max(1, (int)Math.Ceiling(bounds.Height * pixelsPerUnit));

        var visual = new DrawingVisual();
        using (var dc = visual.RenderOpen())
        {
            dc.PushTransform(new ScaleTransform(pixelsPerUnit, pixelsPerUnit));
            dc.PushTransform(new TranslateTransform(-bounds.X, -bounds.Y));
            draw(dc);
            dc.Pop();
            dc.Pop();
        }
        var bitmap = new System.Windows.Media.Imaging.RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32);
        bitmap.Render(visual);
        bitmap.Freeze();
        return (bitmap, new Rect(bounds.X, bounds.Y, width / pixelsPerUnit, height / pixelsPerUnit));
    }

    /// <summary>Slow path: draws everything as shapes. Used for the exported picture.</summary>
    public static void Draw(DrawingContext dc, double armOffset)
    {
        var left = BuildArm(-1, armOffset);
        var right = BuildArm(1, armOffset);

        dc.DrawGeometry(OutlineFill, OutlinePen, left.Limb);
        dc.DrawGeometry(OutlineFill, OutlinePen, left.Hand);
        dc.DrawGeometry(OutlineFill, OutlinePen, right.Limb);
        dc.DrawGeometry(OutlineFill, OutlinePen, right.Hand);
        DrawArm(dc, left);
        DrawArm(dc, right);

        dc.DrawDrawing(Body);
    }

    // ---- Arms (rebuilt every frame, because they swing) ---------------------------------

    private sealed record Arm(Geometry Limb, Geometry Hand, Point[] Center, double[] Widths, Point Shoulder, Point Wrist);

    private static Arm BuildArm(int side, double offset)
    {
        var shoulder = new Point(side * 12.0, -77.4);
        // Angles are measured from straight "up" (toward the head). Upside down, that is straight down.
        double upper = side * 0.2 + offset;
        double lower = upper + side * 0.12;
        var elbow = shoulder + Direction(upper) * 16;
        var forearm = Direction(lower);
        var wrist = elbow + forearm * 13.5;

        var center = new[] { shoulder, Lerp(shoulder, elbow, 0.45), elbow, Lerp(elbow, wrist, 0.4), wrist };
        var widths = new[] { 6.8, 6.3, 4.7, 4.9, 3.5 };

        // A gloved fist: an oval along the forearm, with the thumb on the side nearest his body.
        double degrees = lower * 180 / Math.PI;
        var palm = wrist + forearm * 3.0;
        var inward = new Vector(-forearm.Y, forearm.X) * -side;
        var thumb = wrist + forearm * 1.6 + inward * 1.9;
        // Union, not a GeometryGroup: overlapping shapes in a group can cancel out and leave a hole.
        var hand = new CombinedGeometry(
            GeometryCombineMode.Union,
            new EllipseGeometry(palm, 2.3, 3.5, new RotateTransform(degrees, palm.X, palm.Y)),
            new EllipseGeometry(thumb, 1.0, 1.8, new RotateTransform(degrees - side * 25, thumb.X, thumb.Y)));
        hand.Freeze();

        return new Arm(SmoothLimb(center, widths), hand, center, widths, shoulder, wrist);
    }

    private static void DrawArm(DrawingContext dc, Arm arm)
    {
        dc.DrawGeometry(Across(arm.Shoulder, arm.Wrist, 7.2, RedDark, Red, RedLight), null, arm.Limb);
        dc.DrawGeometry(Across(arm.Shoulder, arm.Wrist, 7.2, RedDark, Red, RedLight), null, arm.Hand);

        // Suit web: rings around the arm, plus two lines running along it.
        dc.PushClip(arm.Limb);
        var web = new StreamGeometry();
        using (var ctx = web.Open())
        {
            WalkLimb(arm.Center, arm.Widths, 2.6, (p, dir, width) =>
            {
                var n = new Vector(-dir.Y, dir.X) * (width / 2 + 0.4);
                ctx.BeginFigure(p - n, false, false);
                ctx.QuadraticBezierTo(p + dir * 0.9, p + n, true, false);
            });
            foreach (double share in new[] { -0.22, 0.22 })
            {
                ctx.BeginFigure(Offset(arm.Center, arm.Widths, 0, share), false, false);
                for (int i = 1; i < arm.Center.Length; i++)
                {
                    ctx.LineTo(Offset(arm.Center, arm.Widths, i, share), true, true);
                }
            }
        }
        web.Freeze();
        dc.DrawGeometry(null, SuitWebPen, web);
        dc.Pop();
    }

    // ---- Body (built once) ---------------------------------------------------------------

    private static Drawing BuildBody()
    {
        var legs = new[] { Leg(-1), Leg(1) };
        var feet = new[] { Foot(-1), Foot(1) };
        var neck = Polygon(new(-3.2, -84.5), new(3.2, -84.5), new(3.9, -80.2), new(-3.9, -80.2));
        var torso = Torso();
        var head = Head();

        var group = new DrawingGroup();
        using (var dc = group.Open())
        {
            // Invisible. Lets the gaps between his limbs still catch the mouse.
            dc.DrawGeometry(HitArea, null, SmoothLimb(new[] { new Point(0, 3), new Point(0, -100) }, new[] { 26.0, 26.0 }));

            // Pass 1: the dark silhouette edge.
            foreach (var g in new[] { legs[0], legs[1], feet[0], feet[1], neck, torso, head })
            {
                dc.DrawGeometry(OutlineFill, OutlinePen, g);
            }

            // Pass 2: colours and details.
            DrawLeg(dc, -1, legs[0], feet[0]);
            DrawLeg(dc, 1, legs[1], feet[1]);
            dc.DrawGeometry(Across(new Point(0, -84), new Point(0, -80), 8, RedDark, Red, RedLight), null, neck);
            DrawTorso(dc, torso);
            DrawHead(dc, head);
            DrawAnkleWrap(dc);
        }
        group.Freeze();
        return group;
    }

    private static Geometry Leg(int s)
    {
        return SmoothLimb(
            new[] { new Point(s * 5.0, -50), new Point(s * 4.6, -39), new Point(s * 3.9, -27.5), new Point(s * 3.6, -19), new Point(s * 2.3, -3.6) },
            new[] { 9.8, 8.0, 5.9, 6.6, 3.9 });
    }

    private static Geometry Foot(int s)
    {
        return SmoothLimb(
            new[] { new Point(s * 2.3, -3.6), new Point(s * 2.15, 0.6), new Point(s * 2.0, 4.2) },
            new[] { 3.9, 3.7, 3.1 });
    }

    private static void DrawLeg(DrawingContext dc, int s, Geometry leg, Geometry foot)
    {
        var hip = new Point(s * 5.0, -50);
        var ankle = new Point(s * 2.3, -3.6);
        dc.DrawGeometry(Across(hip, ankle, 10, BlueDark, Blue, BlueLight), null, leg);

        // Knee.
        dc.DrawGeometry(null, MusclePen, Curve(new(s * 1.8, -28.6), new(s * 3.9, -26.2), new(s * 6.0, -28.6)));
        // Thigh muscle line.
        dc.DrawGeometry(null, MusclePen, Curve(new(s * 2.0, -46), new(s * 2.6, -38), new(s * 3.0, -32)));

        // Red boot, with its top rising to a point at the front.
        double cx = s * 3.75;
        var boot = Path(new Point(cx - 6, -21.8), ctx =>
        {
            ctx.QuadraticBezierTo(new Point(cx, -26.4), new Point(cx + 6, -21.8), true, true);
            ctx.LineTo(new Point(cx + 6, 9), true, true);
            ctx.LineTo(new Point(cx - 6, 9), true, true);
        }, closed: true);

        dc.PushClip(leg);
        dc.PushClip(boot);
        dc.DrawRectangle(Across(hip, ankle, 10, RedDark, Red, RedLight), null, new Rect(cx - 7, -27, 14, 36));

        var web = new StreamGeometry();
        using (var ctx = web.Open())
        {
            for (double y = -21; y < 2; y += 2.5)
            {
                double t = Math.Clamp((y + 19) / 15.4, 0, 1);
                double x = s * (3.6 - 1.3 * t);
                double w = 6.6 - 2.7 * t;
                ctx.BeginFigure(new Point(x - w / 2 - 0.5, y), false, false);
                ctx.QuadraticBezierTo(new Point(x, y + 0.9), new Point(x + w / 2 + 0.5, y), true, false);
            }
            foreach (double dx in new[] { -1.6, 0, 1.6 })
            {
                ctx.BeginFigure(new Point(cx + dx, -26), false, false);
                ctx.LineTo(new Point(s * 2.3 + dx * 0.6, 5), true, false);
            }
        }
        web.Freeze();
        dc.DrawGeometry(null, SuitWebPen, web);
        dc.Pop();
        dc.DrawGeometry(null, EdgePen, Curve(new(cx - 6, -21.8), new(cx, -26.4), new(cx + 6, -21.8)));
        dc.Pop();

        dc.DrawGeometry(Across(ankle, new Point(s * 2.0, 4.2), 4, RedDark, Red, RedLight), null, foot);
    }

    private static Geometry Torso()
    {
        return Path(new Point(3.0, -81.8), ctx =>
        {
            ctx.QuadraticBezierTo(new Point(7.6, -81.6), new Point(11.6, -79.4), true, true);      // trapezius
            ctx.BezierTo(new Point(13.6, -79.2), new Point(14.8, -77.0), new Point(14.6, -74.6), true, true); // shoulder
            ctx.BezierTo(new Point(14.2, -70.0), new Point(10.2, -64.4), new Point(9.0, -59.6), true, true);  // side to waist
            ctx.QuadraticBezierTo(new Point(8.4, -55.4), new Point(9.9, -51.6), true, true);        // waist to hip
            ctx.QuadraticBezierTo(new Point(9.2, -47.0), new Point(2.4, -46.4), true, true);        // hip to crotch
            ctx.QuadraticBezierTo(new Point(0, -45.4), new Point(-2.4, -46.4), true, true);
            ctx.QuadraticBezierTo(new Point(-9.2, -47.0), new Point(-9.9, -51.6), true, true);
            ctx.QuadraticBezierTo(new Point(-8.4, -55.4), new Point(-9.0, -59.6), true, true);
            ctx.BezierTo(new Point(-10.2, -64.4), new Point(-14.2, -70.0), new Point(-14.6, -74.6), true, true);
            ctx.BezierTo(new Point(-14.8, -77.0), new Point(-13.6, -79.2), new Point(-11.6, -79.4), true, true);
            ctx.QuadraticBezierTo(new Point(-7.6, -81.6), new Point(-3.0, -81.8), true, true);
        }, closed: true);
    }

    /// <summary>The red part of the chest: shoulders and chest, narrowing down the middle into a red belt.</summary>
    private static Geometry RedChest()
    {
        return Path(new Point(-16, -84), ctx =>
        {
            ctx.LineTo(new Point(16, -84), true, true);
            ctx.LineTo(new Point(16, -73.5), true, true);
            ctx.BezierTo(new Point(13.6, -66.5), new Point(7.4, -62.6), new Point(5.0, -59.6), true, true);
            ctx.LineTo(new Point(10.5, -55.6), true, true);
            ctx.LineTo(new Point(10.5, -52.6), true, true);
            ctx.LineTo(new Point(-10.5, -52.6), true, true);
            ctx.LineTo(new Point(-10.5, -55.6), true, true);
            ctx.LineTo(new Point(-5.0, -59.6), true, true);
            ctx.BezierTo(new Point(-7.4, -62.6), new Point(-13.6, -66.5), new Point(-16, -73.5), true, true);
        }, closed: true);
    }

    private static void DrawTorso(DrawingContext dc, Geometry torso)
    {
        var chest = RedChest();
        var a = new Point(0, -82);
        var b = new Point(0, -46);

        dc.DrawGeometry(Across(a, b, 30, BlueDark, Blue, BlueLight), null, torso);

        dc.PushClip(torso);
        dc.DrawGeometry(Across(a, b, 30, RedDark, Red, RedLight), null, chest);

        // Web radiating from the emblem across the red part.
        dc.PushClip(chest);
        dc.DrawGeometry(null, SuitWebPen, RadialWeb(new Point(0, -71.5), 18, new[] { 3.0, 6.0, 9.5, 13.0, 16.5, 20.0, 24.0, 28.0 }));
        dc.Pop();

        // Chest and stomach muscles.
        foreach (int s in new[] { -1, 1 })
        {
            dc.DrawGeometry(null, MusclePen, Curve(new(s * 0.8, -69.6), new(s * 6.2, -66.6), new(s * 12.4, -71.2)));
            dc.DrawGeometry(null, MusclePen, Curve(new(s * 12.6, -68.6), new(s * 10.4, -62.4), new(s * 7.6, -58.6)));
        }
        dc.DrawLine(MusclePen, new Point(0, -67), new Point(0, -56.5));

        // Soft shadow toward the waist, so the chest reads as nearer.
        var waistShade = new LinearGradientBrush(Color.FromArgb(0, 0, 0, 0), Color.FromArgb(70, 0, 0, 0), new Point(0, -66), new Point(0, -46))
        {
            MappingMode = BrushMappingMode.Absolute,
        };
        waistShade.Freeze();
        dc.DrawRectangle(waistShade, null, new Rect(-16, -66, 32, 21));

        dc.DrawGeometry(null, EdgePen, chest);
        dc.Pop();

        DrawEmblem(dc);
    }

    /// <summary>The black spider on his chest.</summary>
    private static void DrawEmblem(DrawingContext dc)
    {
        var legs = new StreamGeometry();
        using (var ctx = legs.Open())
        {
            foreach (int s in new[] { -1, 1 })
            {
                Polyline(ctx, new(s * 0.8, -73.4), new(s * 3.6, -76.8), new(s * 4.2, -80.0));
                Polyline(ctx, new(s * 1.0, -72.8), new(s * 4.8, -74.6), new(s * 6.4, -77.0));
                Polyline(ctx, new(s * 1.1, -72.0), new(s * 4.8, -70.6), new(s * 6.4, -67.4));
                Polyline(ctx, new(s * 0.9, -71.4), new(s * 3.6, -67.8), new(s * 4.0, -64.2));
            }
        }
        legs.Freeze();
        dc.DrawGeometry(null, EmblemPen, legs);
        dc.DrawEllipse(Ink, null, new Point(0, -73.2), 1.3, 1.7);
        dc.DrawEllipse(Ink, null, new Point(0, -69.6), 1.8, 2.8);
    }

    private static Geometry Head()
    {
        // Wider at the cranium, narrower at the chin. The chin overlaps the top of the torso, so there is no gap.
        return Path(new Point(0, -100.4), ctx =>
        {
            ctx.BezierTo(new Point(4.8, -100.4), new Point(7.8, -96.8), new Point(7.8, -91.6), true, true);
            ctx.BezierTo(new Point(7.8, -87.0), new Point(5.0, -81.6), new Point(0, -81.2), true, true);
            ctx.BezierTo(new Point(-5.0, -81.6), new Point(-7.8, -87.0), new Point(-7.8, -91.6), true, true);
            ctx.BezierTo(new Point(-7.8, -96.8), new Point(-4.8, -100.4), new Point(0, -100.4), true, true);
        }, closed: true);
    }

    private static void DrawHead(DrawingContext dc, Geometry head)
    {
        var fill = new RadialGradientBrush
        {
            MappingMode = BrushMappingMode.Absolute,
            GradientOrigin = new Point(-2.8, -95.8),
            Center = new Point(-1.0, -92.6),
            RadiusX = 10.6,
            RadiusY = 11.6,
            GradientStops = { new GradientStop(RedLight, 0), new GradientStop(Red, 0.45), new GradientStop(RedDark, 1) },
        };
        fill.Freeze();
        dc.DrawGeometry(fill, null, head);

        dc.PushClip(head);
        dc.DrawGeometry(null, SuitWebPen, RadialWeb(new Point(0, -90.2), 18, new[] { 2.0, 4.0, 6.2, 8.4, 10.8, 13.2 }));
        dc.Pop();
        dc.DrawGeometry(null, EdgePen, head);

        // Eyes: a thick black frame, a white lens inside, and a small glint.
        foreach (int s in new[] { -1, 1 })
        {
            var eye = Path(new Point(s * 1.0, -90.2), ctx =>
            {
                ctx.BezierTo(new Point(s * 1.3, -93.6), new Point(s * 3.8, -95.7), new Point(s * 6.1, -95.5), true, true);
                ctx.BezierTo(new Point(s * 6.8, -92.2), new Point(s * 4.9, -89.4), new Point(s * 1.0, -90.2), true, true);
            }, closed: true);
            var middle = new Point(s * 3.8, -92.6);

            dc.DrawGeometry(Ink, EyeFramePen, eye);
            dc.PushTransform(new ScaleTransform(0.78, 0.72, middle.X, middle.Y));
            dc.DrawGeometry(LensBrush, null, eye);
            dc.Pop();
            dc.DrawEllipse(LensGlint, null, new Point(s * 2.7, -93.3), 0.6, 0.42);
        }
    }

    /// <summary>Web strands wound round both ankles, where the rope is tied.</summary>
    private static void DrawAnkleWrap(DrawingContext dc)
    {
        var wrap = new StreamGeometry();
        using (var ctx = wrap.Open())
        {
            Ellipse(ctx, new Point(0, -6.2), 6.4, 1.5);
            Ellipse(ctx, new Point(0, -4.0), 6.0, 1.4);
            Ellipse(ctx, new Point(0, -1.8), 5.4, 1.3);
            Polyline(ctx, new(-5.6, -7.2), new(5.0, -0.8));
            Polyline(ctx, new(5.6, -7.2), new(-5.0, -0.8));
        }
        wrap.Freeze();
        dc.DrawGeometry(null, WrapShadowPen, wrap);
        dc.DrawGeometry(null, WrapPen, wrap);
        dc.DrawEllipse(Solid(Color.FromArgb(235, 0xF1, 0xF3, 0xF6)), WrapShadowPen, new Point(0, 0.6), 1.9, 1.4);
    }

    // ---- Helpers -------------------------------------------------------------------------

    /// <summary>
    /// A web pattern: straight spokes from the centre, joined by rings that sag a little toward it.
    /// </summary>
    private static Geometry RadialWeb(Point center, int spokes, double[] rings)
    {
        var web = new StreamGeometry();
        using (var ctx = web.Open())
        {
            double outer = rings[^1] + 4;
            for (int i = 0; i < spokes; i++)
            {
                double a = i * 2 * Math.PI / spokes;
                ctx.BeginFigure(center, false, false);
                ctx.LineTo(center + new Vector(Math.Cos(a), Math.Sin(a)) * outer, true, false);
            }
            foreach (double r in rings)
            {
                for (int i = 0; i < spokes; i++)
                {
                    double a1 = i * 2 * Math.PI / spokes;
                    double a2 = (i + 1) * 2 * Math.PI / spokes;
                    double am = (a1 + a2) / 2;
                    ctx.BeginFigure(center + new Vector(Math.Cos(a1), Math.Sin(a1)) * r, false, false);
                    ctx.QuadraticBezierTo(
                        center + new Vector(Math.Cos(am), Math.Sin(am)) * r * 0.9,
                        center + new Vector(Math.Cos(a2), Math.Sin(a2)) * r, true, false);
                }
            }
        }
        web.Freeze();
        return web;
    }

    /// <summary>
    /// A smooth limb through center points, with a width at each point and rounded ends.
    ///
    /// Built as ONE closed outline, rounded caps included. Do not go back to "outline plus two
    /// end circles": where a circle overlaps the outline the two can cancel out, leaving
    /// see-through crescents at the hips and armpits.
    /// </summary>
    private static Geometry SmoothLimb(Point[] center, double[] widths)
    {
        int n = center.Length;
        var left = new Point[n];
        var right = new Point[n];
        for (int i = 0; i < n; i++)
        {
            Vector dir = i == 0 ? center[1] - center[0] : i == n - 1 ? center[n - 1] - center[n - 2] : center[i + 1] - center[i - 1];
            dir.Normalize();
            var normal = new Vector(-dir.Y, dir.X) * (widths[i] / 2);
            left[i] = center[i] + normal;
            right[i] = center[i] - normal;
        }
        Array.Reverse(right);

        Vector endDir = center[n - 1] - center[n - 2];
        endDir.Normalize();
        Vector startDir = center[0] - center[1];
        startDir.Normalize();

        var outline = new StreamGeometry();
        using (var ctx = outline.Open())
        {
            ctx.BeginFigure(left[0], true, true);
            SmoothThrough(ctx, left);
            RoundCap(ctx, center[n - 1], endDir, widths[n - 1] / 2);
            SmoothThrough(ctx, right);
            RoundCap(ctx, center[0], startDir, widths[0] / 2);
        }
        outline.Freeze();
        return outline;
    }

    /// <summary>
    /// A half circle around `tip`, bulging along `dir`, from one side of the limb to the other.
    /// Two cubic curves, each close to a quarter circle (0.552 is the usual control-point factor).
    /// </summary>
    private static void RoundCap(StreamGeometryContext ctx, Point tip, Vector dir, double radius)
    {
        const double k = 0.552;
        var side = new Vector(-dir.Y, dir.X) * radius;
        var forward = dir * radius;
        var from = tip + side;
        var point = tip + forward;
        var to = tip - side;
        ctx.BezierTo(from + forward * k, point + side * k, point, true, true);
        ctx.BezierTo(point - side * k, to + forward * k, to, true, true);
    }

    /// <summary>Curves through the points. The current point must already be points[0].</summary>
    private static void SmoothThrough(StreamGeometryContext ctx, Point[] points)
    {
        for (int i = 1; i < points.Length - 1; i++)
        {
            ctx.QuadraticBezierTo(points[i], Lerp(points[i], points[i + 1], 0.5), true, true);
        }
        ctx.LineTo(points[^1], true, true);
    }

    /// <summary>Calls back every `step` units along a limb with the point, direction and width there.</summary>
    private static void WalkLimb(Point[] center, double[] widths, double step, Action<Point, Vector, double> visit)
    {
        double carry = step / 2;
        for (int i = 0; i < center.Length - 1; i++)
        {
            Vector seg = center[i + 1] - center[i];
            double len = seg.Length;
            seg.Normalize();
            for (double d = carry; d < len; d += step)
            {
                double t = d / len;
                visit(center[i] + seg * d, seg, widths[i] + (widths[i + 1] - widths[i]) * t);
                carry = d + step - len;
            }
        }
    }

    /// <summary>A point beside the limb's centre line, `share` of the width out to one side.</summary>
    private static Point Offset(Point[] center, double[] widths, int i, double share)
    {
        int n = center.Length;
        Vector dir = i == 0 ? center[1] - center[0] : i == n - 1 ? center[n - 1] - center[n - 2] : center[i + 1] - center[i - 1];
        dir.Normalize();
        return center[i] + new Vector(-dir.Y, dir.X) * (widths[i] * share);
    }

    /// <summary>
    /// Shading for a rounded limb: dark at both edges, a highlight just off centre.
    /// The gradient runs across the line from a to b, `width` wide.
    /// </summary>
    private static Brush Across(Point a, Point b, double width, Color dark, Color mid, Color light)
    {
        Vector dir = b - a;
        dir.Normalize();
        var normal = new Vector(-dir.Y, dir.X) * (width / 2);
        var middle = Lerp(a, b, 0.5);
        var brush = new LinearGradientBrush
        {
            MappingMode = BrushMappingMode.Absolute,
            StartPoint = middle + normal,
            EndPoint = middle - normal,
            GradientStops =
            {
                new GradientStop(dark, 0),
                new GradientStop(mid, 0.3),
                new GradientStop(light, 0.46),
                new GradientStop(mid, 0.66),
                new GradientStop(dark, 1),
            },
        };
        brush.Freeze();
        return brush;
    }

    private static Geometry Path(Point start, Action<StreamGeometryContext> draw, bool closed)
    {
        var geometry = new StreamGeometry();
        using (var ctx = geometry.Open())
        {
            ctx.BeginFigure(start, true, closed);
            draw(ctx);
        }
        geometry.Freeze();
        return geometry;
    }

    private static Geometry Polygon(params Point[] points)
    {
        return Path(points[0], ctx => ctx.PolyLineTo(points[1..], true, true), closed: true);
    }

    private static Geometry Curve(Point from, Point control, Point to)
    {
        return Path(from, ctx => ctx.QuadraticBezierTo(control, to, true, true), closed: false);
    }

    private static void Polyline(StreamGeometryContext ctx, params Point[] points)
    {
        ctx.BeginFigure(points[0], false, false);
        ctx.PolyLineTo(points[1..], true, true);
    }

    private static void Ellipse(StreamGeometryContext ctx, Point c, double rx, double ry)
    {
        ctx.BeginFigure(new Point(c.X - rx, c.Y), false, true);
        ctx.ArcTo(new Point(c.X + rx, c.Y), new Size(rx, ry), 0, false, SweepDirection.Clockwise, true, false);
        ctx.ArcTo(new Point(c.X - rx, c.Y), new Size(rx, ry), 0, false, SweepDirection.Clockwise, true, false);
    }

    private static Vector Direction(double angleFromUp)
    {
        return new Vector(Math.Sin(angleFromUp), -Math.Cos(angleFromUp));
    }

    private static Point Lerp(Point a, Point b, double t)
    {
        return new Point(a.X + (b.X - a.X) * t, a.Y + (b.Y - a.Y) * t);
    }

    private static SolidColorBrush Solid(Color color)
    {
        return Frozen(new SolidColorBrush(color));
    }

    private static T Frozen<T>(T freezable) where T : Freezable
    {
        freezable.Freeze();
        return freezable;
    }
}
