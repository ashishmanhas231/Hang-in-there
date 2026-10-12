using System;
using System.Collections.Generic;
using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace SpideyHang;

/// <summary>Per-pose settings from hero.json. Point coordinates are pixels in the original picture.</summary>
internal sealed class PoseOptions
{
    /// <summary>The figure in the picture faces left. The app mirrors it when he should face right.</summary>
    public bool FacesLeft { get; set; }

    /// <summary>Extra size multiplier, for poses the automatic sizing gets wrong (a cape spread wide, for example).</summary>
    public double Scale { get; set; } = 1;

    /// <summary>Named spots in the picture, such as "thrusters" (several), "palm", "hand", "eyes", "hammer".</summary>
    public Dictionary<string, List<Point>> Points { get; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Which way thruster flames point, in degrees in the picture: 90 = straight down, 180 = to the left.</summary>
    public double ThrustAngle { get; set; } = 90;
}

/// <summary>Where and how to draw a pose this frame.</summary>
internal readonly record struct Placement(Point Foot, int Facing, double Rotation, double ScaleX, double ScaleY);

/// <summary>
/// One pose picture, cropped to the figure and sized for the screen.
///
/// Everything is measured from the figure's "foot": the middle of the bottom row of visible pixels.
/// Standing heroes stand on it, so it is the natural point to place and squash them by.
///
/// Sizing: each pose is scaled so its visible area matches the hero's size setting.
/// Area, not height, because poses differ in shape: a crouch is short and wide, a flying pose is long
/// and flat. Matching heights would make a crouching hero as tall as a standing one.
/// The downloaded pictures also come in all resolutions, so a fixed scale per hero would not work.
/// </summary>
internal sealed class PoseImage
{
    private const byte AlphaThreshold = 24;

    /// <summary>Visible area as a share of size squared. A standing person is about a quarter as wide as tall.</summary>
    private const double AreaShare = 0.22;

    private readonly BitmapSource bitmap;
    private readonly Rect imageRect;
    private readonly Dictionary<string, List<Point>> points;

    private PoseImage(BitmapSource bitmap, Rect imageRect, Point center, double width, double height,
        bool facesRight, Dictionary<string, List<Point>> points, double thrustAngle)
    {
        this.bitmap = bitmap;
        this.imageRect = imageRect;
        this.points = points;
        Center = center;
        Width = width;
        Height = height;
        FacesRight = facesRight;
        ThrustAngle = thrustAngle;
    }

    /// <summary>The figure's centre of weight, relative to the foot, in WPF units.</summary>
    public Point Center { get; }

    public double Width { get; }
    public double Height { get; }
    public bool FacesRight { get; }
    public double ThrustAngle { get; }

    /// <summary>Named spots relative to the foot, in WPF units, as the picture faces. Empty if not set.</summary>
    public IReadOnlyList<Point> Points(string name)
    {
        return points.TryGetValue(name, out var list) ? list : Array.Empty<Point>();
    }

    public bool HasPoint(string name) => points.ContainsKey(name);

    /// <summary>
    /// Loads a pose. size: the hero's size in WPF units (roughly standing height).
    /// pixelsPerDip: screen pixels per WPF unit, so the stored picture is exactly screen size.
    /// </summary>
    public static PoseImage? Load(string path, PoseOptions options, double size, double pixelsPerDip, out string? error)
    {
        try
        {
            var source = new BitmapImage();
            source.BeginInit();
            source.UriSource = new Uri(Path.GetFullPath(path));
            source.CacheOption = BitmapCacheOption.OnLoad;
            source.CreateOptions = BitmapCreateOptions.IgnoreColorProfile;
            source.EndInit();
            source.Freeze();

            var pixels = new FormatConvertedBitmap(source, PixelFormats.Pbgra32, null, 0);
            int w = pixels.PixelWidth;
            int h = pixels.PixelHeight;
            int stride = w * 4;
            var data = new byte[stride * h];
            pixels.CopyPixels(data, stride, 0);

            // Visible box, visible "mass" (alpha-weighted pixel count) and centre of weight.
            int left = w, top = h, right = -1, bottom = -1;
            double mass = 0, sumX = 0, sumY = 0;
            for (int y = 0; y < h; y++)
            {
                int row = y * stride;
                for (int x = 0; x < w; x++)
                {
                    byte a = data[row + x * 4 + 3];
                    if (a < AlphaThreshold)
                    {
                        continue;
                    }
                    if (x < left) left = x;
                    if (x > right) right = x;
                    if (y < top) top = y;
                    if (y > bottom) bottom = y;
                    double weight = a / 255.0;
                    mass += weight;
                    sumX += weight * x;
                    sumY += weight * y;
                }
            }
            if (right < 0)
            {
                error = "The picture is completely transparent.";
                return null;
            }
            var box = new Int32Rect(left, top, right - left + 1, bottom - top + 1);

            // Foot: middle of the visible pixels along the bottom few rows.
            int band = Math.Max(1, box.Height / 25);
            double footSum = 0;
            int footCount = 0;
            for (int y = bottom - band + 1; y <= bottom; y++)
            {
                for (int x = left; x <= right; x++)
                {
                    if (data[y * stride + x * 4 + 3] >= AlphaThreshold)
                    {
                        footSum += x;
                        footCount++;
                    }
                }
            }
            double footX = footCount > 0 ? footSum / footCount : left + box.Width / 2.0;
            double footY = bottom + 1;

            // Units per source pixel. See the class comment for why this is by area.
            double scale = Math.Sqrt(AreaShare * size * size / Math.Max(1, mass)) * options.Scale;
            scale = Math.Min(scale, 2.2 * size / box.Height);

            var cropped = new CroppedBitmap(pixels, box);
            var final = CustomFigure.HighQualityResize(cropped, scale * pixelsPerDip);

            var imageRect = new Rect((left - footX) * scale, (top - footY) * scale, final.PixelWidth / pixelsPerDip, final.PixelHeight / pixelsPerDip);
            var center = new Point((sumX / mass - footX) * scale, (sumY / mass - footY) * scale);

            var named = new Dictionary<string, List<Point>>(StringComparer.OrdinalIgnoreCase);
            foreach (var (name, list) in options.Points)
            {
                var converted = new List<Point>();
                foreach (var p in list)
                {
                    converted.Add(new Point((p.X - footX) * scale, (p.Y - footY) * scale));
                }
                named[name] = converted;
            }

            error = null;
            return new PoseImage(final, imageRect, center, box.Width * scale, box.Height * scale,
                !options.FacesLeft, named, options.ThrustAngle);
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return null;
        }
    }

    /// <summary>
    /// The transform from picture units (relative to the foot) to the screen, for a placement.
    /// Turned about its centre of weight, squashed or stretched about the foot, mirrored to face the right way.
    /// </summary>
    public Matrix Transform(in Placement place)
    {
        int mirror = (place.Facing >= 0) == FacesRight ? 1 : -1;
        var m = Matrix.Identity;
        // Mirroring flips the direction of a turn, so turn the other way inside a mirrored picture.
        m.RotateAt(place.Rotation * mirror, Center.X, Center.Y);
        m.Scale(place.ScaleX * mirror, place.ScaleY);
        m.Translate(place.Foot.X, place.Foot.Y);
        return m;
    }

    public Point ToScreen(Point local, in Placement place) => Transform(place).Transform(local);

    /// <summary>The centre of weight on screen.</summary>
    public Point CenterOnScreen(in Placement place) => ToScreen(Center, place);

    /// <summary>A direction given in picture degrees (90 = down the picture), turned and mirrored as drawn.</summary>
    public Vector DirectionOnScreen(double pictureDegrees, in Placement place)
    {
        double r = pictureDegrees * Math.PI / 180;
        var m = Transform(place);
        var v = m.Transform(new Vector(Math.Cos(r), Math.Sin(r)));
        if (v.LengthSquared > 1e-12)
        {
            v.Normalize();
        }
        return v;
    }

    /// <summary>
    /// Draws turned about its centre of weight, then squashed about that centre.
    /// For thrown objects: a spinning shield squashed flat reads as a tilted disc.
    /// </summary>
    public void DrawCentered(DrawingContext dc, Point center, double rotation, double scaleX, double scaleY, double opacity = 1)
    {
        var m = Matrix.Identity;
        m.Translate(-Center.X, -Center.Y);
        m.Rotate(rotation);
        m.Scale(scaleX, scaleY);
        m.Translate(center.X, center.Y);
        dc.PushTransform(new MatrixTransform(m));
        if (opacity < 0.999)
        {
            dc.PushOpacity(opacity);
        }
        dc.DrawImage(bitmap, imageRect);
        if (opacity < 0.999)
        {
            dc.Pop();
        }
        dc.Pop();
    }

    public void Draw(DrawingContext dc, in Placement place, double opacity = 1)
    {
        if (opacity <= 0.001)
        {
            return;
        }
        dc.PushTransform(new MatrixTransform(Transform(place)));
        if (opacity < 0.999)
        {
            dc.PushOpacity(opacity);
        }
        dc.DrawImage(bitmap, imageRect);
        if (opacity < 0.999)
        {
            dc.Pop();
        }
        dc.Pop();
    }
}
