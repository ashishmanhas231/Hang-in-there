using System;
using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace SpideyHang;

/// <summary>
/// The user's own picture, hung in place of the drawn Spider-Man.
///
/// The web ties on at the middle of the picture's top edge, so a picture of him already hanging
/// upside down works as it is. For an upright picture, turn on Flip and the web ties on at the bottom
/// (his feet) instead.
///
/// Transparent parts of a PNG let clicks through to the window underneath, the same as the drawn one.
/// A JPG has no transparency, so it hangs as a rectangle.
/// </summary>
internal sealed class CustomFigure
{
    /// <summary>Pixels with less alpha than this count as empty when finding the picture's edges.</summary>
    private const byte AlphaThreshold = 24;

    private readonly BitmapSource bitmap;
    private readonly Point attach;
    private readonly bool flip;
    private readonly double balanceDegrees;
    private readonly double pixelsPerDip;

    private CustomFigure(BitmapSource bitmap, Point attach, bool flip, double balanceDegrees, double pixelsPerDip)
    {
        this.bitmap = bitmap;
        this.attach = attach;
        this.flip = flip;
        this.balanceDegrees = balanceDegrees;
        this.pixelsPerDip = pixelsPerDip;
    }

    /// <summary>How far the picture is tilted so its weight hangs straight below the tie-on point. For the log.</summary>
    public double BalanceDegrees => balanceDegrees;

    /// <summary>
    /// Loads and prepares the picture. Returns null and an error message if it cannot be used.
    /// pixelsPerDip: screen pixels per WPF unit (1.0 at 100% display scaling, 1.5 at 150%).
    /// heightShare: how tall the visible part is, in body lengths.
    /// </summary>
    public static CustomFigure? TryLoad(string path, bool flip, double bodyLength, double pixelsPerDip, out string? error, double heightShare = 1.3)
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
            int width = pixels.PixelWidth;
            int height = pixels.PixelHeight;
            int stride = width * 4;
            var data = new byte[stride * height];
            pixels.CopyPixels(data, stride, 0);

            if (!TryFindContent(data, width, height, stride, out Int32Rect box))
            {
                error = "The picture is completely transparent.";
                return null;
            }

            // Where the web ties on: the middle of the visible pixels along the top (or bottom) edge.
            // A thin band, so a fist or a pair of feet at the very top decides it, not the arm below.
            int band = Math.Max(1, box.Height / 50);
            int fromRow = flip ? box.Y + box.Height - band : box.Y;
            double attachX = CenterOfRows(data, width, stride, box, fromRow, band) - box.X;
            double attachY = flip ? box.Height : 0;

            // Anything held from one point tips until its weight sits straight below that point.
            // Tilt the picture the same way. Measured from tie-on point to the picture's centre of weight,
            // as the picture will be drawn (a flipped picture is turned 180 degrees first).
            Point weight = CenterOfWeight(data, stride, box);
            Vector down = flip
                ? new Vector(attachX - weight.X, attachY - weight.Y)
                : new Vector(weight.X - attachX, weight.Y - attachY);
            double balanceDegrees = Math.Atan2(down.X, down.Y) * 180 / Math.PI;

            // Scale so the visible part is heightShare body lengths tall, and never wider than 85% of that.
            // Stored at exactly screen-pixel size, so drawing it each frame only turns it, never shrinks it.
            // Do not go back to storing it larger and shrinking it every frame: the quick shrink used
            // while drawing skips pixels, so the edges sparkled and shimmered as he swung.
            double scale = bodyLength * heightShare / box.Height;
            scale = Math.Min(scale, bodyLength * heightShare * 0.85 / box.Width) * pixelsPerDip;

            var cropped = new CroppedBitmap(pixels, box);
            var final = HighQualityResize(cropped, scale);

            error = null;
            return new CustomFigure(final, new Point(attachX * scale, attachY * scale), flip, balanceDegrees, pixelsPerDip);
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return null;
        }
    }

    /// <summary>Draws with the tie-on point at (0, 0) and the picture's weight hanging straight toward +y.</summary>
    public void Draw(DrawingContext dc)
    {
        dc.PushTransform(new RotateTransform(balanceDegrees));
        if (flip)
        {
            dc.PushTransform(new RotateTransform(180));
        }
        dc.PushTransform(new ScaleTransform(1 / pixelsPerDip, 1 / pixelsPerDip));
        dc.DrawImage(bitmap, new Rect(-attach.X, -attach.Y, bitmap.PixelWidth, bitmap.PixelHeight));
        dc.Pop();
        if (flip)
        {
            dc.Pop();
        }
        dc.Pop();
    }

    /// <summary>Shrinks once, with the slow high-quality filter that averages every source pixel.</summary>
    internal static BitmapSource HighQualityResize(BitmapSource source, double scale)
    {
        int width = Math.Max(1, (int)Math.Round(source.PixelWidth * scale));
        int height = Math.Max(1, (int)Math.Round(source.PixelHeight * scale));

        var drawing = new DrawingGroup();
        RenderOptions.SetBitmapScalingMode(drawing, BitmapScalingMode.HighQuality);
        using (var dc = drawing.Open())
        {
            dc.DrawImage(source, new Rect(0, 0, width, height));
        }
        var visual = new DrawingVisual();
        using (var dc = visual.RenderOpen())
        {
            dc.DrawDrawing(drawing);
        }
        var result = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32);
        result.Render(visual);
        result.Freeze();
        return result;
    }

    /// <summary>The average position of the visible pixels, weighted by how opaque they are. In box coordinates.</summary>
    private static Point CenterOfWeight(byte[] data, int stride, Int32Rect box)
    {
        double sum = 0, sumX = 0, sumY = 0;
        for (int y = box.Y; y < box.Y + box.Height; y++)
        {
            int row = y * stride;
            for (int x = box.X; x < box.X + box.Width; x++)
            {
                byte alpha = data[row + x * 4 + 3];
                if (alpha > 0)
                {
                    sum += alpha;
                    sumX += alpha * (x - box.X);
                    sumY += alpha * (y - box.Y);
                }
            }
        }
        return sum > 0 ? new Point(sumX / sum, sumY / sum) : new Point(box.Width / 2.0, box.Height / 2.0);
    }

    private static bool TryFindContent(byte[] data, int width, int height, int stride, out Int32Rect box)
    {
        int left = width, top = height, right = -1, bottom = -1;
        for (int y = 0; y < height; y++)
        {
            int row = y * stride;
            for (int x = 0; x < width; x++)
            {
                if (data[row + x * 4 + 3] >= AlphaThreshold)
                {
                    if (x < left) left = x;
                    if (x > right) right = x;
                    if (y < top) top = y;
                    if (y > bottom) bottom = y;
                }
            }
        }
        box = right < 0 ? default : new Int32Rect(left, top, right - left + 1, bottom - top + 1);
        return right >= 0;
    }

    private static double CenterOfRows(byte[] data, int width, int stride, Int32Rect box, int fromRow, int rows)
    {
        double sum = 0;
        int count = 0;
        for (int y = fromRow; y < fromRow + rows; y++)
        {
            for (int x = box.X; x < box.X + box.Width; x++)
            {
                if (data[y * stride + x * 4 + 3] >= AlphaThreshold)
                {
                    sum += x;
                    count++;
                }
            }
        }
        return count > 0 ? sum / count : box.X + box.Width / 2.0;
    }
}
