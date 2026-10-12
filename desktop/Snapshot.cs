using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace SpideyHang;

/// <summary>
/// Test helpers. Nothing appears on screen.
///
/// Render: runs the physics for a while and saves one frame as a PNG. The left half of the
/// background is dark and the right half light, to check the web shows up on both.
/// Also writes &lt;path&gt;.log with how much he moves over time, to check he goes still.
///
/// ExportFigure: saves the drawn Spider-Man, upright, on a transparent background.
/// Loading that back in as "my own picture" (with Flip on) tests the picture path without
/// needing anybody's artwork.
/// </summary>
internal static class Snapshot
{
    /// <param name="screenEdge">
    /// How far right of the anchor the screen ends, in units. 0 = no edge in view. The window is
    /// always centred on the anchor (as in the app), so this only limits where he may swing on his own.
    /// </param>
    public static void Render(string path, double seconds, double kick, string? image, bool flip, bool autoSwing = false, double screenEdge = 0)
    {
        var settings = new Settings();
        double body = settings.BodyLength;
        const double rope = 280;
        double reach = rope + body * (1 + Rig.ReachPastHead);
        double width = 2 * reach + 40;
        double height = reach + 30;

        var rig = new Rig();
        rig.Build(width, height, width / 2, rope, body);
        if (screenEdge > 0)
        {
            rig.VisibleRight = width / 2 + screenEdge;
        }
        // The PNG is saved at 2 pixels per unit, so the cached pictures must be drawn at that density too.
        var stage = new Stage(rig) { PixelsPerDip = 2 };
        if (image != null && Directory.Exists(image))
        {
            // A hero folder: all its poses, so the log shows the pose changing with the motion.
            stage.Look = HeroLook.Load(HeroLibrary.ReadFolder(image), body, 2, message => throw new InvalidOperationException(message))
                ?? throw new InvalidOperationException("No usable pictures in " + image);
        }
        else if (image != null)
        {
            var figure = CustomFigure.TryLoad(image, flip, body, 2, out string? error)
                ?? throw new InvalidOperationException(error);
            stage.Look = HeroLook.Single("test", figure);
        }
        if (kick != 0)
        {
            rig.Kick(Math.Abs(kick), Math.Sign(kick));
        }

        var log = new StringBuilder("time  motion  pose  ropeAngleDegrees  bodyMinusRopeDegrees  ropeStretch  bodyAngleDegrees\n");
        const double frame = 1.0 / 60;
        double time = 0;
        while (time < seconds)
        {
            for (int i = 0; i < 4; i++)
            {
                rig.Simulate(time, settings.Breeze, autoSwing, null, default);
                time += Rig.Step;
            }
            stage.Advance(frame);
            // One row per frame, so frame-to-frame jitter shows up in the log.
            log.AppendLine($"{time,5:0.000}  {rig.Motion():0.000000}  {stage.CurrentPose}  {rig.RopeAngle * 180 / Math.PI,8:0.000}  {(rig.BodyAngle - rig.RopeAngle) * 180 / Math.PI,8:0.000}  {rig.RopeStretch:0.0000}  {rig.BodyAngle * 180 / Math.PI,8:0.000}");
        }
        File.WriteAllText(path + ".log", log.ToString());

        Save(path, width, height, 2, dc =>
        {
            dc.DrawRectangle(new SolidColorBrush(Color.FromRgb(30, 30, 30)), null, new Rect(0, 0, width / 2, height));
            dc.DrawRectangle(new SolidColorBrush(Color.FromRgb(235, 235, 235)), null, new Rect(width / 2, 0, width / 2, height));
            stage.Draw(dc);
        });
    }

    /// <summary>
    /// Plays an acting hero's moves offline on a pretend 1920x1032 screen with a taskbar, and saves
    /// a film strip of frames evenly spaced over the run, plus a log of what he did.
    /// actions: "click@2.5" (click him at 2.5 s), "dbl@6" (double-click), "drop@4" (pick up, fling, let go).
    /// </summary>
    public static void RenderScene(string folder, string path, double seconds, int frames, IReadOnlyList<string> actions)
    {
        var info = HeroLibrary.ReadFolder(folder);
        var kit = HeroKit.Load(info, 160, 1, message => throw new InvalidOperationException(message))
            ?? throw new InvalidOperationException("No pictures in " + folder);
        var area = new Rect(0, 0, 1920, 1032);
        var scene = new Scene(kit, area, new Random(7)) { Mouse = new Point(1300, 520) };

        // "zoom": each frame shows a 960x540 area around the hero instead of the whole screen.
        bool zoom = actions.Contains("zoom");
        var pending = actions
            .Where(a => a.Contains('@'))
            .Select(a => a.Split('@'))
            .Select(p => (Kind: p[0], Time: double.Parse(p[1], CultureInfo.InvariantCulture)))
            .OrderBy(a => a.Time)
            .ToList();

        const double dt = 1.0 / 60;
        var captures = new List<(double Time, string Status, DrawingGroup Drawing, Rect View)>();
        double nextCapture = seconds / frames;
        var log = new StringBuilder("time  status  effects  projectiles\n");
        double time = 0;
        double dropStart = -1;
        Point dropFrom = default;
        int frame = 0;

        while (time < seconds - 1e-9)
        {
            while (pending.Count > 0 && pending[0].Time <= time)
            {
                var (kind, _) = pending[0];
                pending.RemoveAt(0);
                switch (kind)
                {
                    case "click":
                        scene.Click();
                        break;
                    case "dbl":
                        scene.DoubleClick();
                        break;
                    case "drop":
                        dropFrom = scene.Hero.Foot + new Vector(0, -40);
                        scene.BeginDrag(dropFrom);
                        dropStart = time;
                        break;
                }
            }
            // A drop: carry him up and to the side for 0.4 s, then let go with that speed.
            if (dropStart >= 0)
            {
                double k = (time - dropStart) / 0.4;
                if (k < 1)
                {
                    scene.DragTo(dropFrom + new Vector(300 * k, -500 * k), dt);
                }
                else
                {
                    scene.EndDrag();
                    dropStart = -1;
                }
            }

            scene.Update(dt);
            time += dt;
            if (++frame % 6 == 0)
            {
                log.AppendLine($"{time,6:0.00}  {scene.Status}  {scene.Effects.Count}  {scene.Projectiles.Count}");
            }
            if (time >= nextCapture - 1e-9)
            {
                var g = new DrawingGroup();
                using (var gdc = g.Open())
                {
                    gdc.DrawRectangle(new SolidColorBrush(Color.FromRgb(46, 50, 58)), null, new Rect(0, 0, 1920, 1032));
                    gdc.DrawRectangle(new SolidColorBrush(Color.FromRgb(22, 22, 28)), null, new Rect(0, 1032, 1920, 60));
                    scene.DrawWorld(gdc);
                }
                var view = new Rect(0, 0, 1920, 1092);
                if (zoom)
                {
                    var c = scene.Hero.Foot - new Vector(0, 100);
                    view = new Rect(Math.Clamp(c.X - 480, 0, 1920 - 960), Math.Clamp(c.Y - 300, 0, 1092 - 540), 960, 540);
                }
                captures.Add((time, scene.Status, g, view));
                nextCapture += seconds / frames;
            }
        }
        File.WriteAllText(path + ".log", log.ToString());

        const int columns = 2;
        const double cellW = 576;
        double cellH = cellW * captures[0].View.Height / captures[0].View.Width + 26;
        int rows = (captures.Count + columns - 1) / columns;
        Save(path, cellW * columns, cellH * rows, 1, dc =>
        {
            for (int i = 0; i < captures.Count; i++)
            {
                double x = i % columns * cellW;
                double y = i / columns * cellH;
                var view = captures[i].View;
                double cell = cellW / view.Width;
                dc.PushClip(new RectangleGeometry(new Rect(x, y + 26, cellW, cellH - 26)));
                dc.PushTransform(new TranslateTransform(x, y + 26));
                dc.PushTransform(new ScaleTransform(cell, cell));
                dc.PushTransform(new TranslateTransform(-view.X, -view.Y));
                dc.DrawDrawing(captures[i].Drawing);
                dc.Pop();
                dc.Pop();
                dc.Pop();
                dc.Pop();
                var label = new FormattedText($"{captures[i].Time:0.00}s  {captures[i].Status}", CultureInfo.InvariantCulture,
                    FlowDirection.LeftToRight, new Typeface("Segoe UI"), 14, Brushes.White, 1.0);
                dc.DrawRectangle(Brushes.Black, null, new Rect(x, y, cellW, 26));
                dc.DrawText(label, new Point(x + 6, y + 4));
            }
        });
    }

    public static void ExportFigure(string path)
    {
        const double scale = 6;
        const double width = 60 * scale;
        const double height = 132 * scale;
        Save(path, width, height, 1, dc =>
        {
            dc.PushTransform(new TranslateTransform(width / 2, height - 8 * scale));
            dc.PushTransform(new ScaleTransform(scale, scale));
            SpideyArt.Draw(dc, 0);
            dc.Pop();
            dc.Pop();
        });
    }

    private static void Save(string path, double width, double height, double pixelScale, Action<DrawingContext> draw)
    {
        var visual = new DrawingVisual();
        using (var dc = visual.RenderOpen())
        {
            draw(dc);
        }
        var bitmap = new RenderTargetBitmap((int)(width * pixelScale), (int)(height * pixelScale), 96 * pixelScale, 96 * pixelScale, PixelFormats.Pbgra32);
        bitmap.Render(visual);
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using var file = File.Create(path);
        encoder.Save(file);
    }
}
