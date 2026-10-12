using System;
using System.Globalization;
using System.Threading;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;

namespace SpideyHang;

internal static class Program
{
    private const string MutexName = @"Local\SpideyHang.Instance";

    /// <summary>
    /// SpideyHang.exe                  Start the overlay. If it is already running, give him a swing.
    /// SpideyHang.exe --push [n]       Swing the running overlay. n = strength, default 1.
    /// SpideyHang.exe --reset          Hang him straight again.
    /// SpideyHang.exe --exit           Close the running overlay.
    /// SpideyHang.exe --at-login       What Windows runs at sign-in: waits a few seconds for the taskbar, then starts.
    /// SpideyHang.exe --sync-startup   Adds or removes the Windows sign-in entry to match the setting, then quits.
    ///                                 The VS Code extension runs this, because its writes reach the real registry.
    /// Test only. Nothing appears on screen:
    /// SpideyHang.exe --snapshot f.png [seconds] [kick] [picture|-] [flip|-] [swing|-] [edge]
    ///                                 Renders one frame to a PNG and quits. "-" skips an option.
    ///                                 edge = how far right of the web the screen ends, to test near a screen edge.
    /// SpideyHang.exe --export-figure f.png
    ///                                 Saves the drawn Spider-Man, upright, on a transparent background.
    /// </summary>
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length >= 2 && args[0] == "--snapshot")
        {
            double seconds = args.Length >= 3 ? double.Parse(args[2], CultureInfo.InvariantCulture) : 1;
            double kick = args.Length >= 4 ? double.Parse(args[3], CultureInfo.InvariantCulture) : 0;
            string? picture = args.Length >= 5 && args[4] != "-" ? args[4] : null;
            bool flip = args.Length >= 6 && args[5] == "flip";
            bool swing = args.Length >= 7 && args[6] == "swing";
            double edge = args.Length >= 8 ? double.Parse(args[7], CultureInfo.InvariantCulture) : 0;
            Snapshot.Render(args[1], seconds, kick, picture, flip, swing, edge);
            return 0;
        }
        if (args.Length >= 2 && args[0] == "--export-figure")
        {
            Snapshot.ExportFigure(args[1]);
            return 0;
        }
        if (args.Length >= 5 && args[0] == "--scene")
        {
            // --scene <hero folder> <out.png> <seconds> <frames> [click@2 dbl@5 drop@8 ...]
            Snapshot.RenderScene(args[1], args[2], double.Parse(args[3], CultureInfo.InvariantCulture),
                int.Parse(args[4], CultureInfo.InvariantCulture), args[5..]);
            return 0;
        }

        if (args.Length >= 1 && args[0] == "--sync-startup")
        {
            Startup.Sync(Settings.Load().StartAutomatically);
            return 0;
        }

        string command = ToCommand(args);

        using var mutex = new Mutex(true, MutexName, out bool firstInstance);
        if (!firstInstance)
        {
            CommandPipe.Send(command.Length > 0 ? command : "push 1");
            return 0;
        }

        // Nothing is running, so there is nothing to push, reset or close.
        if (command.Length > 0)
        {
            return 0;
        }

        // At sign-in the taskbar may not be there yet, and the screen area comes out wrong
        // (no taskbar means the "ground" is the very bottom of the screen). Give the shell a moment.
        bool atLogin = Array.IndexOf(args, "--at-login") >= 0;
        if (atLogin)
        {
            Thread.Sleep(4000);
        }

        // Do not remove: CPU and memory jump on the GPU path.
        // A transparent WPF window drawn on the GPU is copied back from the graphics card every frame,
        // and the graphics driver alone can take hundreds of MB. For a window this small the CPU is cheaper.
        RenderOptions.ProcessRenderMode = RenderMode.SoftwareOnly;

        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        app.DispatcherUnhandledException += (_, e) => Log.Write("CRASH " + e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log.Write("CRASH " + e.ExceptionObject);

        var settings = Settings.Load();
        Log.Write($"Start {typeof(Program).Assembly.GetName().Version} from {Environment.ProcessPath}{(atLogin ? " at sign-in" : "")}. "
            + $"Settings: size {settings.Size}, rope {settings.Rope}, hero {settings.Hero}, change hero every {settings.RotateMinutes} min, "
            + $"start automatically {settings.StartAutomatically}");

        // Keep the Windows sign-in entry in step with the setting, and pointing at the right copy.
        Startup.Sync(settings.StartAutomatically);
        var window = new OverlayWindow(settings);

        using var tray = new Tray(window, settings);
        using var pipe = new CommandPipe(line => window.Dispatcher.InvokeAsync(() => window.HandleCommand(line)));

        window.ShowForHero();
        app.Run();
        return 0;
    }

    private static string ToCommand(string[] args)
    {
        if (args.Length == 0)
        {
            return "";
        }

        return args[0] switch
        {
            "--push" => "push " + (args.Length > 1 ? args[1] : "1"),
            "--reset" => "reset",
            "--exit" => "exit",
            _ => "",
        };
    }
}
