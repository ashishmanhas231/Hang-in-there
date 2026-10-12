using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;

namespace SpideyHang;

/// <summary>
/// A transparent, always-on-top window that shows one part of the scene (the hero, a thrown object,
/// or an effect). Its Area is the part of the screen it covers. Everything inside is drawn in screen
/// coordinates, so it can be moved without redrawing differently.
///
/// Clicks fall through every fully transparent pixel, as with the hanging overlay.
/// </summary>
internal sealed class OverlayPane : Window
{
    private readonly PaneCanvas canvas;
    private IntPtr hwnd;
    private double pixelsPerDip = 1;

    public OverlayPane()
    {
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        Topmost = true;
        ShowInTaskbar = false;
        ShowActivated = false;
        ResizeMode = ResizeMode.NoResize;
        Title = "Spidey Hang";
        canvas = new PaneCanvas(this);
        Content = canvas;
        SourceInitialized += (_, _) =>
        {
            hwnd = new WindowInteropHelper(this).Handle;
            NativeMethods.MakeOverlay(hwnd);
            pixelsPerDip = VisualTreeHelper.GetDpi(this).PixelsPerDip;
        };
    }

    public PaneCanvas Canvas => canvas;

    /// <summary>The part of the screen this window covers, in WPF units.</summary>
    public Rect Area { get; private set; }

    public Action<DrawingContext>? Painter
    {
        get => canvas.Painter;
        set => canvas.Painter = value;
    }

    /// <summary>
    /// Moves (and if needed resizes) the window. A move alone goes straight to Windows in one call.
    /// Setting WPF's Left and Top separately would move it twice per frame.
    /// </summary>
    public void Place(Rect area)
    {
        bool resized = Math.Abs(area.Width - Area.Width) > 0.5 || Math.Abs(area.Height - Area.Height) > 0.5;
        Area = area;
        if (hwnd == IntPtr.Zero || resized)
        {
            Left = area.X;
            Top = area.Y;
            Width = area.Width;
            Height = area.Height;
        }
        else
        {
            NativeMethods.MoveWindow(hwnd, (int)Math.Round(area.X * pixelsPerDip), (int)Math.Round(area.Y * pixelsPerDip));
        }
        canvas.InvalidateVisual();
    }

    public void Redraw() => canvas.InvalidateVisual();
}

internal sealed class PaneCanvas : FrameworkElement
{
    private readonly OverlayPane pane;

    public PaneCanvas(OverlayPane pane)
    {
        this.pane = pane;
    }

    public Action<DrawingContext>? Painter { get; set; }

    protected override void OnRender(DrawingContext dc)
    {
        if (Painter == null)
        {
            return;
        }
        dc.PushTransform(new TranslateTransform(-pane.Area.X, -pane.Area.Y));
        Painter(dc);
        dc.Pop();
    }
}

/// <summary>
/// Runs a Scene live: one window for the hero, one per thrown object, one per effect.
///
/// The hero's window does not chase him every frame. Moving a window costs a frame of lag, which
/// shows as a jump at speed. So during a long move (a flight, leap, run or fall) the move sets
/// Scene.StageArea and the window covers that whole path, standing still while he moves inside it.
/// Otherwise the window re-centres on him only when he drifts well away from its middle.
/// Thrown objects and effects get a window covering their whole path, placed once.
/// </summary>
internal sealed class SceneHost : IDisposable
{
    private readonly Scene scene;
    private readonly OverlayPane heroPane;
    private readonly Dictionary<Projectile, OverlayPane> projectilePanes = new();
    private readonly Dictionary<IEffect, OverlayPane> effectPanes = new();
    private readonly Stack<OverlayPane> spare = new();
    private readonly List<IEffect> waitingEffects = new();
    private double lastFrame;
    private bool running;
    private bool inFrame;
    private bool growing;
    private Point anchor;
    private Rect? lastStage;

    // Frame timing, for the "stats" command. A gap over 25 ms is a dropped frame at 60 Hz.
    private int statFrames;
    private double statTime;
    private double statWorst;
    private int statSlow;

    // Mouse on the hero.
    private bool pressed;
    private bool dragging;
    private Point pressAt;
    private double lastMoveTime;

    public SceneHost(HeroKit kit)
    {
        scene = new Scene(kit, SystemParameters.WorkArea, new Random());
        heroPane = new OverlayPane { Painter = scene.DrawHero };
        heroPane.Canvas.Cursor = Cursors.Hand;
        heroPane.Canvas.MouseLeftButtonDown += OnDown;
        heroPane.Canvas.MouseMove += OnMove;
        heroPane.Canvas.MouseLeftButtonUp += OnUp;
        heroPane.Canvas.MouseRightButtonUp += (_, e) =>
        {
            MenuRequested?.Invoke();
            e.Handled = true;
        };

        // Windows to lend to thrown objects and effects. All created now and shown in Start, then parked
        // off-screen when not in use. Do not create or show a window during a frame: see OnFrame.
        for (int i = 0; i < 6; i++)
        {
            spare.Push(NewPane());
        }
    }

    private static readonly Rect Parked = new(-10000, -10000, 16, 16);

    /// <summary>Right-click on the hero. The tray shows its menu.</summary>
    public event Action? MenuRequested;

    public Scene Scene => scene;

    public void Start()
    {
        if (running)
        {
            return;
        }
        running = true;
        lastFrame = 0;
        scene.Update(1.0 / 60);
        anchor = scene.Hero.Foot;
        heroPane.Place(FollowArea());
        heroPane.Show();
        foreach (var pane in spare)
        {
            pane.Show();
        }
        CompositionTarget.Rendering += OnFrame;
    }

    public void Click() => scene.Click();

    /// <summary>Writes frame timing since the last call to the log, then starts counting again.</summary>
    public void LogStats()
    {
        double fps = statTime > 0 ? statFrames / statTime : 0;
        Log.Write($"Acting frames: {statFrames} in {statTime:0.0} s = {fps:0.0} per second, worst gap {statWorst * 1000:0} ms, "
            + $"dropped {statSlow}, windows: hero + {projectilePanes.Count} thrown + {effectPanes.Count} effects, {scene.Status}");
        statFrames = 0;
        statTime = 0;
        statWorst = 0;
        statSlow = 0;
    }

    public void DoubleClick() => scene.DoubleClick();

    private OverlayPane NewPane()
    {
        var pane = new OverlayPane();
        pane.Place(Parked);
        return pane;
    }

    private Rect FollowArea()
    {
        double size = scene.Kit.Size;
        return new Rect(anchor.X - size * 1.8, anchor.Y - size * 2.5, size * 3.6, size * 3.3);
    }

    /// <summary>
    /// One frame. Must never run inside itself: resizing a window makes WPF draw at once, which fires
    /// this event again part-way through. A nested run once tried to show a window mid-frame, Windows
    /// refused (Win32Exception "The operation completed successfully") and the app crashed.
    /// </summary>
    private void OnFrame(object? sender, EventArgs e)
    {
        if (inFrame)
        {
            return;
        }
        inFrame = true;
        try
        {
            Frame(e);
        }
        finally
        {
            inFrame = false;
        }
    }

    private void Frame(EventArgs e)
    {
        double now = e is RenderingEventArgs r ? r.RenderingTime.TotalSeconds : 0;
        if (now <= lastFrame)
        {
            return;
        }
        double dt = lastFrame <= 0 ? 1.0 / 60 : Math.Min(0.05, now - lastFrame);
        lastFrame = now;
        statFrames++;
        statTime += dt;
        statWorst = Math.Max(statWorst, dt);
        if (dt > 0.025)
        {
            statSlow++;
        }

        var (cx, cy) = NativeMethods.CursorPosition();
        double ppd = VisualTreeHelper.GetDpi(heroPane).PixelsPerDip;
        scene.Mouse = new Point(cx / ppd, cy / ppd);
        scene.Area = SystemParameters.WorkArea;
        scene.Update(dt);

        PlaceHero();
        SyncProjectiles();
        SyncEffects();
    }

    private void PlaceHero()
    {
        var stage = scene.StageArea;
        if (stage is Rect area)
        {
            if (lastStage != area)
            {
                heroPane.Place(area);
                lastStage = area;
            }
            anchor = scene.Hero.Foot;
        }
        else
        {
            bool fromStage = lastStage != null;
            lastStage = null;
            if (fromStage || scene.Dragging || (scene.Hero.Foot - anchor).Length > scene.Kit.Size * 0.5)
            {
                anchor = scene.Hero.Foot;
                heroPane.Place(FollowArea());
            }
        }
        heroPane.Redraw();
    }

    private void SyncProjectiles()
    {
        foreach (var p in scene.Projectiles)
        {
            if (!projectilePanes.TryGetValue(p, out var pane))
            {
                var borrowed = Borrow();
                if (borrowed == null)
                {
                    continue;
                }
                pane = borrowed;
                var projectile = p;
                pane.Painter = dc => projectile.Draw(dc);
                pane.Place(p.Bounds);
                projectilePanes[p] = pane;
            }
            pane.Redraw();
        }
        foreach (var gone in new List<Projectile>(projectilePanes.Keys))
        {
            if (!scene.Projectiles.Contains(gone))
            {
                Return(projectilePanes[gone]);
                projectilePanes.Remove(gone);
            }
        }
    }

    private void SyncEffects()
    {
        waitingEffects.AddRange(scene.NewEffects);
        scene.NewEffects.Clear();
        for (int i = 0; i < waitingEffects.Count; i++)
        {
            var effect = waitingEffects[i];
            if (!scene.Effects.Contains(effect))
            {
                waitingEffects.RemoveAt(i--);
                continue;
            }
            var pane = Borrow();
            if (pane == null)
            {
                break;
            }
            var fx = effect;
            pane.Painter = dc => fx.Draw(dc);
            pane.Place(effect.Bounds);
            effectPanes[effect] = pane;
            waitingEffects.RemoveAt(i--);
        }

        foreach (var (effect, pane) in new List<KeyValuePair<IEffect, OverlayPane>>(effectPanes))
        {
            if (scene.Effects.Contains(effect))
            {
                pane.Redraw();
            }
            else
            {
                Return(pane);
                effectPanes.Remove(effect);
            }
        }
    }

    /// <summary>
    /// A parked window, or null if none is free. Then two more are made after this frame (never during
    /// it), and whatever asked waits a frame.
    /// </summary>
    private OverlayPane? Borrow()
    {
        if (spare.Count > 0)
        {
            return spare.Pop();
        }
        if (!growing)
        {
            growing = true;
            heroPane.Dispatcher.BeginInvoke(new Action(() =>
            {
                for (int i = 0; i < 2; i++)
                {
                    var pane = NewPane();
                    pane.Show();
                    spare.Push(pane);
                }
                growing = false;
            }));
        }
        return null;
    }

    private void Return(OverlayPane pane)
    {
        pane.Painter = null;
        pane.Place(Parked);
        spare.Push(pane);
    }

    // ---- Mouse ------------------------------------------------------------------------

    private Point ScreenPoint(MouseEventArgs e)
    {
        var p = e.GetPosition(heroPane.Canvas);
        return new Point(p.X + heroPane.Area.X, p.Y + heroPane.Area.Y);
    }

    private void OnDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2)
        {
            pressed = false;
            scene.DoubleClick();
            e.Handled = true;
            return;
        }
        pressed = true;
        dragging = false;
        pressAt = ScreenPoint(e);
        lastMoveTime = lastFrame;
        heroPane.Canvas.CaptureMouse();
        e.Handled = true;
    }

    private void OnMove(object sender, MouseEventArgs e)
    {
        if (!pressed)
        {
            return;
        }
        var p = ScreenPoint(e);
        if (!dragging && (p - pressAt).Length > 6)
        {
            dragging = true;
            scene.BeginDrag(pressAt);
        }
        if (dragging)
        {
            double dt = Math.Max(1.0 / 240, lastFrame - lastMoveTime);
            lastMoveTime = lastFrame;
            scene.DragTo(p, dt);
        }
    }

    private void OnUp(object sender, MouseButtonEventArgs e)
    {
        if (!pressed)
        {
            return;
        }
        pressed = false;
        heroPane.Canvas.ReleaseMouseCapture();
        if (dragging)
        {
            dragging = false;
            scene.EndDrag();
        }
        else
        {
            scene.Click();
        }
    }

    public void Dispose()
    {
        if (running)
        {
            CompositionTarget.Rendering -= OnFrame;
            running = false;
        }
        heroPane.Close();
        foreach (var pane in projectilePanes.Values)
        {
            pane.Close();
        }
        foreach (var pane in effectPanes.Values)
        {
            pane.Close();
        }
        while (spare.Count > 0)
        {
            spare.Pop().Close();
        }
    }
}
