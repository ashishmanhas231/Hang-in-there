using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Windows;
using System.Windows.Input;
using System.Linq;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Win32;

namespace SpideyHang;

/// <summary>
/// A borderless, transparent, always-on-top window tied to the top edge of the screen.
///
/// Clicks fall through every fully transparent pixel to whatever is underneath.
/// Only Spider-Man, the rope and the knot catch the mouse.
///
/// The window is only as big as his swing needs. A full-screen transparent window would cost
/// noticeably more CPU, because Windows re-copies the whole window every frame.
/// </summary>
internal sealed class OverlayWindow : Window
{
    private readonly Settings settings;
    private readonly Rig rig = new();
    private readonly Stage stage;
    private readonly Stopwatch clock = Stopwatch.StartNew();

    private bool animating;
    private double lastFrame;
    private double accumulator;
    private double simTime;
    private double quietTime;

    private Particle? dragged;
    private bool draggingAnchor;
    private bool dragMoved;
    private Point dragStart;
    private Point dragTarget;

    private Point lastHover;
    private double lastHoverTime = -1;

    // Heroes: auto-rotate, and live reload when pictures are added to the current hero's folder.
    private readonly DispatcherTimer rotateTimer = new();
    private readonly DispatcherTimer heroReloadTimer = new() { Interval = TimeSpan.FromMilliseconds(800) };
    private FileSystemWatcher? heroWatcher;

    // Acting mode: a hero with a move set runs around the whole screen in his own windows,
    // and this hanging window hides. Null while he hangs.
    private SceneHost? sceneHost;
    private bool shown;

    /// <summary>Raised on right-click. The tray shows its menu at the cursor.</summary>
    public event Action? MenuRequested;

    /// <summary>Raised with a message the user should see, such as a picture that would not load.</summary>
    public event Action<string>? Problem;

    // Problems raised before anyone listens. The window is built (and the picture loaded) before
    // the tray icon exists, so without this a startup failure would vanish silently.
    private readonly List<string> unseenProblems = new();

    public OverlayWindow(Settings settings)
    {
        this.settings = settings;

        Title = "Spidey Hang";
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        Topmost = true;
        ShowInTaskbar = false;
        ShowActivated = false;
        ResizeMode = ResizeMode.NoResize;

        stage = new Stage(rig) { Cursor = Cursors.Hand };
        Content = stage;

        SourceInitialized += (_, _) => NativeMethods.MakeOverlay(new WindowInteropHelper(this).Handle);

        stage.MouseLeftButtonDown += OnMouseDown;
        stage.MouseMove += OnMouseMove;
        stage.MouseLeftButtonUp += OnMouseUp;
        stage.LostMouseCapture += (_, _) => EndDrag();
        stage.MouseRightButtonUp += (_, e) =>
        {
            MenuRequested?.Invoke();
            e.Handled = true;
        };

        SystemEvents.DisplaySettingsChanged += OnDisplaySettingsChanged;
        Closed += (_, _) =>
        {
            SystemEvents.DisplaySettingsChanged -= OnDisplaySettingsChanged;
            heroWatcher?.Dispose();
        };

        rotateTimer.Tick += (_, _) => NextHero();
        heroReloadTimer.Tick += (_, _) =>
        {
            heroReloadTimer.Stop();
            Log.Write("Hero pictures changed on disk, reloading.");
            ReloadLook();
        };

        ApplyLayout();
        WatchHeroesFolder();
        StartRotateTimer();
    }

    /// <summary>Sizes and places the window from the settings, then hangs him straight with a small swing.</summary>
    public void ApplyLayout()
    {
        Rect area = SystemParameters.WorkArea;
        double body = settings.BodyLength;
        double hang = body * (1 + Rig.ReachPastHead);

        double rope = Math.Max(60, settings.RopeFraction * area.Height);
        rope = Math.Min(rope, Math.Max(60, area.Height - hang - 30));

        double reach = rope + hang;
        // Wide enough for a full sideways swing. Not capped at the screen width, for the same
        // reason the window is not clamped to the screen: a squeezed window means walls he can hit.
        double width = 2 * reach + 40;
        double height = Math.Min(area.Height, reach + 30);

        double anchorX = area.Left + Math.Clamp(settings.AnchorFraction, 0, 1) * area.Width;
        anchorX = Math.Clamp(anchorX, area.Left + 20, area.Right - 20);
        double asked = anchorX;
        if (settings.AutoSwing)
        {
            anchorX = RoomToSwing(anchorX, rope, body);
        }

        // Always centred on the anchor, even if that runs past the screen edge. Do not clamp it to
        // the screen: a squeezed window puts an invisible wall a short way from him, and hitting it
        // made the physics fling him over the top. Past the edge he just swings out of view and back.
        double left = anchorX - width / 2;

        Left = left;
        Top = area.Top;
        Width = width;
        Height = height;

        rig.Build(width, height, anchorX - left, rope, body);
        SetVisibleArea();
        Log.Write($"Layout: screen {area.Left:0}..{area.Right:0}, web at {anchorX:0} (saved spot {asked:0}), "
            + $"window {left:0}..{left + width:0}, rope {rope:0}, swing on his own {settings.AutoSwing}");
        stage.ResetPose();
        stage.Look = LoadLook(body);
        stage.InvalidateVisual();
        rig.Kick(0.5);
        Wake();
        if (shown)
        {
            UpdateMode();
        }
    }

    /// <summary>First show. Starts in acting mode straight away if the hero acts, so the hanging window never flashes up.</summary>
    public void ShowForHero()
    {
        shown = true;
        UpdateMode();
    }

    /// <summary>
    /// Acting mode if the chosen hero has a move set and every pose it needs, otherwise hanging mode.
    /// Called on start, on every hero change, and when the size changes.
    /// </summary>
    private void UpdateMode()
    {
        string hero = settings.Hero;
        bool builtIn = hero.Equals(HeroLibrary.Drawn, StringComparison.OrdinalIgnoreCase)
            || hero.Equals(HeroLibrary.MyPicture, StringComparison.OrdinalIgnoreCase);
        var info = builtIn ? null : HeroLibrary.Find(hero);

        sceneHost?.Dispose();
        sceneHost = null;

        if (info != null && info.CanAct)
        {
            var kit = HeroKit.Load(info, settings.BodyLength * 1.07, PixelsPerDip, RaiseProblem);
            if (kit != null)
            {
                Sleep();
                Hide();
                sceneHost = new SceneHost(kit);
                sceneHost.MenuRequested += () => MenuRequested?.Invoke();
                sceneHost.Start();
                Log.Write($"{info.Name} acts ({info.Moves}), poses: {string.Join(", ", kit.Poses.Keys)}");
                return;
            }
        }
        else if (info?.Moves != null)
        {
            Log.Write($"{info.Name} hangs for now. To act ({info.Moves}) he still needs: {string.Join(", ", HeroMoves.MissingPoses(info.Moves, info.Pictures.Keys))}");
        }

        if (!IsVisible)
        {
            Show();
        }
        Wake();
    }

    /// <summary>
    /// Moves an anchor position in from the screen edges, far enough for a full "swing on his own".
    /// Too close to an edge, the swing has to be tiny or he swings off the screen.
    /// If the screen is too narrow for that, the anchor goes to the middle.
    /// </summary>
    private static double RoomToSwing(double anchorX, double rope, double body)
    {
        Rect area = SystemParameters.WorkArea;
        double needed = Rig.DistanceForFullSwing(rope, body);
        if (area.Width < needed * 2)
        {
            return area.Left + area.Width / 2;
        }
        return Math.Clamp(anchorX, area.Left + needed, area.Right - needed);
    }

    /// <summary>Tells the physics which part of the window is on screen. Call after the window moves.</summary>
    private void SetVisibleArea()
    {
        Rect area = SystemParameters.WorkArea;
        rig.VisibleLeft = area.Left - Left;
        rig.VisibleRight = area.Right - Left;
    }

    /// <summary>Hands over any problems raised before the tray was listening. Call after subscribing to Problem.</summary>
    public void ShowUnseenProblems()
    {
        foreach (string message in unseenProblems)
        {
            Problem?.Invoke(message);
        }
        unseenProblems.Clear();
    }

    private void RaiseProblem(string message)
    {
        Log.Write("PROBLEM " + message);
        if (Problem == null)
        {
            unseenProblems.Add(message);
        }
        else
        {
            Problem.Invoke(message);
        }
    }

    /// <summary>Hangs the user's picture. Keeps our own copy, so moving or deleting the original does no harm.</summary>
    public void UseImage(string path)
    {
        Log.Write($"Use picture: {path}");
        if (CustomFigure.TryLoad(path, settings.FlipImage, settings.BodyLength, PixelsPerDip, out string? error) == null)
        {
            RaiseProblem($"Could not use that picture. {error}");
            return;
        }

        try
        {
            Directory.CreateDirectory(Settings.Folder);
            foreach (string old in Directory.GetFiles(Settings.Folder, "figure.*"))
            {
                File.Delete(old);
            }
            string copy = System.IO.Path.Combine(Settings.Folder, "figure" + System.IO.Path.GetExtension(path).ToLowerInvariant());
            File.Copy(path, copy, overwrite: true);
            settings.ImageFile = copy;
        }
        catch (Exception ex)
        {
            RaiseProblem($"Could not copy that picture. {ex.Message}");
            return;
        }

        SetHero(HeroLibrary.MyPicture);
    }

    /// <summary>Back to the drawn Spider-Man. Saved pictures and hero folders are untouched.</summary>
    public void UseDrawing()
    {
        SetHero(HeroLibrary.Drawn);
    }

    /// <summary>Switches to the saved picture, if there is one.</summary>
    public void UseSavedImage()
    {
        if (settings.ImageFile == null || !File.Exists(settings.ImageFile))
        {
            RaiseProblem("No picture saved yet. Use \"Use my own picture...\" first.");
            return;
        }
        SetHero(HeroLibrary.MyPicture);
    }

    public void FlipImage()
    {
        settings.FlipImage = !settings.FlipImage;
        settings.Save();
        ReloadLook();
    }

    // ---- Heroes -----------------------------------------------------------------------

    public string CurrentHero => settings.Hero;
    public int RotateMinutes => settings.RotateMinutes;

    /// <summary>Switches hero without restarting the swing.</summary>
    public void SetHero(string name)
    {
        settings.Hero = name;
        settings.Save();
        Log.Write($"Hero: {name}");
        ReloadLook();
    }

    /// <summary>The next hero (alphabetical, wrapping round) that has pictures. Used by auto-rotate and "hero next".</summary>
    public void NextHero()
    {
        var usable = HeroLibrary.Scan().Where(h => h.Usable).Select(h => h.Name).ToList();
        if (usable.Count == 0)
        {
            return;
        }
        int at = usable.FindIndex(n => n.Equals(settings.Hero, StringComparison.OrdinalIgnoreCase));
        SetHero(usable[(at + 1) % usable.Count]);
    }

    /// <summary>Change hero every so many minutes. 0 turns it off.</summary>
    public void SetRotate(int minutes)
    {
        settings.RotateMinutes = Math.Max(0, minutes);
        settings.Save();
        Log.Write($"Change hero every: {(minutes > 0 ? minutes + " min" : "off")}");
        StartRotateTimer();
    }

    public void OpenHeroesFolder()
    {
        try
        {
            Directory.CreateDirectory(HeroLibrary.Folder);
            Process.Start(new ProcessStartInfo("explorer.exe", $"\"{HeroLibrary.Folder}\"") { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            RaiseProblem($"Could not open the heroes folder. {ex.Message}");
        }
    }

    private void ReloadLook()
    {
        stage.Look = LoadLook(rig.BodyLength);
        stage.InvalidateVisual();
        Wake();
        if (shown)
        {
            UpdateMode();
        }
    }

    private void StartRotateTimer()
    {
        rotateTimer.Stop();
        if (settings.RotateMinutes > 0)
        {
            rotateTimer.Interval = TimeSpan.FromMinutes(settings.RotateMinutes);
            rotateTimer.Start();
        }
    }

    /// <summary>
    /// Watches the heroes folder, so pictures dropped in show up without a restart.
    /// Changes come in bursts (a copy fires several events), so this waits for 0.8 s of quiet first.
    /// </summary>
    private void WatchHeroesFolder()
    {
        try
        {
            Directory.CreateDirectory(HeroLibrary.Folder);
            heroWatcher = new FileSystemWatcher(HeroLibrary.Folder)
            {
                IncludeSubdirectories = true,
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size,
            };
            FileSystemEventHandler changed = (_, _) => Dispatcher.InvokeAsync(() =>
            {
                heroReloadTimer.Stop();
                heroReloadTimer.Start();
            });
            heroWatcher.Created += changed;
            heroWatcher.Changed += changed;
            heroWatcher.Deleted += changed;
            heroWatcher.Renamed += (s, e) => changed(s, e);
            heroWatcher.EnableRaisingEvents = true;
        }
        catch (Exception ex)
        {
            Log.Write($"Cannot watch the heroes folder, new pictures need a restart: {ex.Message}");
        }
    }

    /// <summary>
    /// Saves the overlay's own drawing (web and Spider-Man only, never the screen behind it) to a PNG.
    /// Lets someone without a view of the screen check what is actually being drawn.
    /// </summary>
    private void SaveSnapshot(string path)
    {
        if (!path.EndsWith(".png", StringComparison.OrdinalIgnoreCase))
        {
            Log.Write($"Snapshot refused, not a .png path: {path}");
            return;
        }
        try
        {
            var visual = new DrawingVisual();
            double w = Width;
            double h = Height;
            using (var dc = visual.RenderOpen())
            {
                if (sceneHost != null)
                {
                    // Acting: the whole work area, at half size.
                    var area = SystemParameters.WorkArea;
                    w = area.Width / 2;
                    h = area.Height / 2;
                    dc.DrawRectangle(new SolidColorBrush(Color.FromRgb(40, 40, 40)), null, new Rect(0, 0, w, h));
                    dc.PushTransform(new ScaleTransform(0.5, 0.5));
                    dc.PushTransform(new TranslateTransform(-area.X, -area.Y));
                    sceneHost.Scene.DrawWorld(dc);
                    dc.Pop();
                    dc.Pop();
                }
                else
                {
                    dc.DrawRectangle(new SolidColorBrush(Color.FromRgb(40, 40, 40)), null, new Rect(0, 0, w, h));
                    stage.Draw(dc);
                }
            }
            var bitmap = new System.Windows.Media.Imaging.RenderTargetBitmap((int)w, (int)h, 96, 96, PixelFormats.Pbgra32);
            bitmap.Render(visual);
            var encoder = new System.Windows.Media.Imaging.PngBitmapEncoder();
            encoder.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(bitmap));
            using var file = File.Create(path);
            encoder.Save(file);
            Log.Write($"Snapshot saved: {path} (hero {settings.Hero}, {(sceneHost != null ? sceneHost.Scene.Status : "pose " + stage.CurrentPose)})");
        }
        catch (Exception ex)
        {
            Log.Write($"Snapshot failed: {ex.Message}");
        }
    }

    /// <summary>Screen pixels per WPF unit on this display (1.0 at 100% scaling, 1.5 at 150%).</summary>
    private double PixelsPerDip => VisualTreeHelper.GetDpi(this).PixelsPerDip;

    /// <summary>Loads whatever settings.Hero names. Anything that fails falls back to the drawn Spider-Man, with a message.</summary>
    private HeroLook? LoadLook(double body)
    {
        string hero = settings.Hero;
        if (hero.Equals(HeroLibrary.Drawn, StringComparison.OrdinalIgnoreCase))
        {
            Log.Write("Look: drawn Spider-Man");
            return null;
        }

        if (hero.Equals(HeroLibrary.MyPicture, StringComparison.OrdinalIgnoreCase))
        {
            if (settings.ImageFile == null || !File.Exists(settings.ImageFile))
            {
                RaiseProblem($"Your picture is missing ({settings.ImageFile ?? "none saved"}), so he is drawn instead.");
                return null;
            }
            var figure = CustomFigure.TryLoad(settings.ImageFile, settings.FlipImage, body, PixelsPerDip, out string? error);
            if (figure == null)
            {
                RaiseProblem($"Could not load your picture, so he is drawn instead. {error}");
                return null;
            }
            Log.Write($"Look: my picture {settings.ImageFile} (flip {settings.FlipImage}, tilted {figure.BalanceDegrees:0.0} degrees to balance)");
            return HeroLook.Single(HeroLibrary.MyPicture, figure);
        }

        var info = HeroLibrary.Find(hero);
        if (info == null || !info.Usable)
        {
            RaiseProblem(info == null
                ? $"No hero folder called \"{hero}\", so the drawn Spider-Man is shown."
                : $"{hero} has no pictures yet. Add them to {info.FolderPath}.");
            return null;
        }
        var look = HeroLook.Load(info, body, PixelsPerDip, RaiseProblem);
        if (look == null)
        {
            RaiseProblem($"None of {hero}'s pictures would load, so the drawn Spider-Man is shown.");
            return null;
        }
        Log.Write($"Look: {hero} ({(look.OnlyEmblem ? "emblem" : string.Join(", ", info.Poses.Keys))}), line {look.Line}");
        return look;
    }

    public void Swing(double strength = 1)
    {
        if (sceneHost != null)
        {
            sceneHost.Click();
            return;
        }
        rig.Kick(strength);
        Wake();
    }

    /// <summary>The breeze changed. Restart the loop in case he was asleep.</summary>
    public void BreezeChanged()
    {
        Wake();
    }

    /// <summary>Turns "swing on his own" on or off. Starting from still, he gets a push to begin.</summary>
    public void SetAutoSwing(bool on)
    {
        settings.AutoSwing = on;
        Log.Write($"Swing on his own: {on}");
        if (on)
        {
            // Slide the web in from a screen edge if he would not have room to swing there.
            double anchorX = Left + rig.Anchor.X;
            double roomy = RoomToSwing(anchorX, rig.RopeLength, settings.BodyLength);
            if (Math.Abs(roomy - anchorX) > 0.5)
            {
                MoveAnchorTo(roomy);
                Rect area = SystemParameters.WorkArea;
                settings.AnchorFraction = (roomy - area.Left) / area.Width;
                Log.Write($"Moved the web in from the screen edge to make room to swing ({anchorX:0} to {roomy:0})");
            }
            if (rig.Motion() < 0.5)
            {
                rig.Kick(0.8);
            }
        }
        settings.Save();
        Wake();
    }

    /// <summary>
    /// Commands from the named pipe. Anything else is ignored.
    ///   push [strength]    swing him
    ///   reset              hang him straight
    ///   image &lt;path&gt;       hang this picture instead
    ///   image off          back to the drawn Spider-Man
    ///   swing on|off|toggle  keep swinging on his own, or not
    ///   snapshot &lt;x.png&gt;  save what the overlay is drawing right now (for checking problems)
    ///   exit               close
    /// </summary>
    public void HandleCommand(string line)
    {
        line = line.Trim();
        string[] parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0)
        {
            return;
        }

        switch (parts[0])
        {
            case "swing" when parts.Length == 2:
                SetAutoSwing(parts[1] switch
                {
                    "on" => true,
                    "off" => false,
                    _ => !settings.AutoSwing,
                });
                break;
            case "snapshot" when parts.Length >= 2:
                SaveSnapshot(line.Substring("snapshot".Length).Trim());
                break;
            case "stats":
                if (sceneHost != null)
                {
                    sceneHost.LogStats();
                }
                else
                {
                    LogFrameStats();
                }
                break;
            case "hero" when parts.Length == 2 && parts[1] == "next":
                NextHero();
                break;
            case "hero" when parts.Length >= 2:
                SetHero(line.Substring("hero".Length).Trim());
                break;
            case "rotate" when parts.Length == 2 && int.TryParse(parts[1], out int minutes):
                SetRotate(minutes);
                break;
            case "image" when parts.Length == 2 && parts[1] == "off":
                UseDrawing();
                break;
            case "image" when parts.Length >= 2:
                UseImage(line.Substring("image".Length).Trim());
                break;
            case "action":
                sceneHost?.Click();
                break;
            case "action2":
                sceneHost?.DoubleClick();
                break;
            case "push":
                double strength = parts.Length > 1
                    && double.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out double value)
                    ? Math.Clamp(value, 0, 3)
                    : 1;
                Swing(strength);
                break;
            case "reset":
                ApplyLayout();
                break;
            case "exit":
                Application.Current.Shutdown();
                break;
        }
    }

    // ---- Frame timing record (the "stats" pipe command) --------------------------------

    private int statFrames;
    private double statTime;
    private double statWorst;
    private int statSlow;

    /// <summary>Counts frames and gaps. A gap over 25 ms is a dropped frame at 60 Hz.</summary>
    private void RecordFrame(double frameDt)
    {
        statFrames++;
        statTime += frameDt;
        statWorst = Math.Max(statWorst, frameDt);
        if (frameDt > 0.025)
        {
            statSlow++;
        }
    }

    /// <summary>Writes frame timing since the last call to the log, then starts counting again.</summary>
    private void LogFrameStats()
    {
        double fps = statTime > 0 ? statFrames / statTime : 0;
        Log.Write($"Frames: {statFrames} in {statTime:0.0} s = {fps:0.0} per second, worst gap {statWorst * 1000:0} ms, "
            + $"dropped (gap over 25 ms) {statSlow}, CPU so far {Process.GetCurrentProcess().TotalProcessorTime.TotalSeconds:0.0} s");
        statFrames = 0;
        statTime = 0;
        statWorst = 0;
        statSlow = 0;
    }

    // ---- Animation loop ---------------------------------------------------------------

    private void Wake()
    {
        quietTime = 0;
        if (animating || sceneHost != null)
        {
            return;
        }
        animating = true;
        lastFrame = 0;     // the first frame after waking uses a standard 1/60 s step
        accumulator = 0;
        CompositionTarget.Rendering += OnFrame;
    }

    /// <summary>Stops the frame loop. He uses no CPU until something wakes him.</summary>
    private void Sleep()
    {
        if (!animating)
        {
            return;
        }
        animating = false;
        CompositionTarget.Rendering -= OnFrame;
    }

    private void OnFrame(object? sender, EventArgs e)
    {
        // Time the animation by when the frame will be shown (RenderingTime), not by when this
        // handler happens to run. The handler's own timing wobbles by a few milliseconds, and that
        // wobble showed up as uneven motion. WPF also sometimes calls this twice for one frame;
        // the second call has the same RenderingTime and is skipped.
        double now = e is RenderingEventArgs r ? r.RenderingTime.TotalSeconds : clock.Elapsed.TotalSeconds;
        if (now <= lastFrame)
        {
            return;
        }
        double frameDt = Math.Min(0.05, now - lastFrame);
        if (lastFrame <= 0)
        {
            frameDt = 1.0 / 60;
        }
        lastFrame = now;
        RecordFrame(frameDt);
        accumulator += frameDt;

        while (accumulator >= Rig.Step)
        {
            rig.Simulate(simTime, settings.Breeze, settings.AutoSwing, dragged, dragTarget);
            accumulator -= Rig.Step;
            simTime += Rig.Step;
        }
        stage.Blend = accumulator / Rig.Step;
        stage.Dragging = dragged != null;
        stage.Advance(frameDt);
        stage.InvalidateVisual();

        // 0.02 units per step is about 5 units a second: too slow to see.
        bool still = !settings.Breeze && !settings.AutoSwing && dragged == null && !draggingAnchor
            && rig.Motion() < 0.02 && stage.Settled;
        quietTime = still ? quietTime + frameDt : 0;
        if (quietTime > 0.5)
        {
            rig.Freeze();
            Sleep();
        }
    }

    // ---- Mouse ------------------------------------------------------------------------

    private void OnMouseDown(object sender, MouseButtonEventArgs e)
    {
        Point pt = e.GetPosition(stage);

        if (rig.NearAnchor(pt))
        {
            draggingAnchor = true;
        }
        else
        {
            dragged = rig.Pick(pt);
            if (dragged == null)
            {
                return;
            }
            dragStart = pt;
            dragTarget = pt;
            dragMoved = false;
        }

        stage.CaptureMouse();
        Wake();
        e.Handled = true;
    }

    private void OnMouseMove(object sender, MouseEventArgs e)
    {
        Point pt = e.GetPosition(stage);

        if (draggingAnchor)
        {
            MoveAnchorTo(Left + pt.X);
            return;
        }
        if (dragged != null)
        {
            dragTarget = pt;
            if ((pt - dragStart).Length > 4)
            {
                dragMoved = true;
            }
            return;
        }
        BrushPast(pt);
    }

    private void OnMouseUp(object sender, MouseButtonEventArgs e)
    {
        // A plain click on him (no drag) gives a nudge away from the click.
        if (dragged != null && !dragMoved)
        {
            Point pt = e.GetPosition(stage);
            rig.Kick(0.9, pt.X < (rig.Ankle.X + rig.Head.X) / 2 ? 1 : -1);
        }
        stage.ReleaseMouseCapture();
        EndDrag();
    }

    private void EndDrag()
    {
        if (draggingAnchor)
        {
            Rect area = SystemParameters.WorkArea;
            double dropped = Left + rig.Anchor.X;

            // Dropped too close to a screen edge while swinging: slide back in so he can keep swinging.
            // Left where it was, the swing would have to shrink to nothing to stay on screen,
            // and he would just stop. That looked like the swing was broken.
            if (settings.AutoSwing)
            {
                double roomy = RoomToSwing(dropped, rig.RopeLength, settings.BodyLength);
                if (Math.Abs(roomy - dropped) > 0.5)
                {
                    MoveAnchorTo(roomy);
                    Log.Write($"Web dropped too near the screen edge to swing; slid in from {dropped:0} to {roomy:0}");
                    dropped = roomy;
                }
            }

            settings.AnchorFraction = (dropped - area.Left) / area.Width;
            settings.Save();
        }
        dragged = null;
        draggingAnchor = false;
    }

    /// <summary>Moving the cursor across him without clicking pushes him, like brushing past a real charm.</summary>
    private void BrushPast(Point pt)
    {
        double now = clock.Elapsed.TotalSeconds;
        if (lastHoverTime >= 0 && now - lastHoverTime < 0.1)
        {
            double dt = Math.Max(0.004, now - lastHoverTime);
            double speedX = Math.Clamp((pt.X - lastHover.X) / dt, -1500, 1500);
            var part = rig.PickBody(pt);
            if (part != null && Math.Abs(speedX) > 60)
            {
                Rig.Nudge(part, speedX * 0.15);
                Wake();
            }
        }
        lastHover = pt;
        lastHoverTime = now;
    }

    /// <summary>
    /// Moves the knot along the top of the screen. The window moves with it.
    /// The body is shifted back by the same amount, so he stays where he was and the rope swings him along.
    /// </summary>
    private void MoveAnchorTo(double screenX)
    {
        Rect area = SystemParameters.WorkArea;
        screenX = Math.Clamp(screenX, area.Left + 20, area.Right - 20);
        // Centred on the anchor, even past the screen edge. See ApplyLayout for why.
        double newLeft = screenX - Width / 2;

        rig.ShiftAll(Left - newLeft);
        rig.MoveAnchor(screenX - newLeft);
        Left = newLeft;
        SetVisibleArea();
    }

    private void OnDisplaySettingsChanged(object? sender, EventArgs e)
    {
        Dispatcher.InvokeAsync(ApplyLayout);
    }
}
