using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Reflection;
using System.Windows.Forms;

namespace SpideyHang;

/// <summary>
/// The notification-area icon next to the clock. Left-click swings him. Right-click opens the menu.
/// Right-clicking Spider-Man himself opens the same menu.
/// </summary>
internal sealed class Tray : IDisposable
{
    private static readonly (string Name, double Fraction)[] Positions =
    {
        ("Left", 0.12),
        ("Center", 0.5),
        ("Right", 0.88),
    };

    private readonly OverlayWindow window;
    private readonly Settings settings;
    private readonly Icon icon;
    private readonly NotifyIcon notifyIcon;
    private readonly ContextMenuStrip menu = new();
    private readonly List<(ToolStripMenuItem Item, Func<bool> IsChecked)> checks = new();
    private readonly ToolStripMenuItem heroMenu;

    public Tray(OverlayWindow window, Settings settings)
    {
        this.window = window;
        this.settings = settings;

        menu.Items.Add("Give him a swing", null, (_, _) => window.Swing());
        menu.Items.Add("Reset", null, (_, _) => window.ApplyLayout());
        menu.Items.Add(new ToolStripSeparator());

        var position = new ToolStripMenuItem("Position");
        foreach (var (name, fraction) in Positions)
        {
            AddChoice(position, name, () => Math.Abs(settings.AnchorFraction - fraction) < 0.005, () => settings.AnchorFraction = fraction);
        }
        menu.Items.Add(position);

        var size = new ToolStripMenuItem("Size");
        foreach (string name in new[] { "Small", "Medium", "Large" })
        {
            AddChoice(size, name, () => settings.Size == name, () => settings.Size = name);
        }
        menu.Items.Add(size);

        var rope = new ToolStripMenuItem("Rope length");
        foreach (string name in new[] { "Short", "Medium", "Long" })
        {
            AddChoice(rope, name, () => settings.Rope == name, () => settings.Rope = name);
        }
        menu.Items.Add(rope);

        // Filled in each time the menu opens, so new hero folders show up without a restart.
        heroMenu = new ToolStripMenuItem("Hero");
        menu.Items.Add(heroMenu);

        var autoSwing = new ToolStripMenuItem("Swing on his own", null, (_, _) => window.SetAutoSwing(!settings.AutoSwing));
        checks.Add((autoSwing, () => settings.AutoSwing));
        menu.Items.Add(autoSwing);

        var breeze = new ToolStripMenuItem("Breeze", null, (_, _) =>
        {
            settings.Breeze = !settings.Breeze;
            settings.Save();
            window.BreezeChanged();
        });
        checks.Add((breeze, () => settings.Breeze));
        menu.Items.Add(breeze);

        menu.Items.Add(new ToolStripSeparator());
        var autoStart = new ToolStripMenuItem("Start automatically (with Windows and VS Code)", null, (_, _) =>
        {
            settings.StartAutomatically = !settings.StartAutomatically;
            settings.Save();
            Startup.Sync(settings.StartAutomatically);
        });
        checks.Add((autoStart, () => settings.StartAutomatically));
        menu.Items.Add(autoStart);
        menu.Items.Add("Take him down (exit)", null, (_, _) => System.Windows.Application.Current.Shutdown());
        menu.Opening += (_, _) =>
        {
            FillHeroMenu();
            RefreshChecks();
        };

        icon = CreateIcon();
        notifyIcon = new NotifyIcon
        {
            Icon = icon,
            Text = "Spidey Hang",
            ContextMenuStrip = menu,
            Visible = true,
        };
        notifyIcon.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left)
            {
                window.Swing();
            }
        };

        window.MenuRequested += ShowMenuAtCursor;
        window.Problem += ShowProblem;
        window.ShowUnseenProblems();
    }

    /// <summary>
    /// The Hero submenu: one entry per hero folder, then the built-in choices and the settings.
    /// A hero with only an emblem says so. A hero with no pictures is greyed out.
    /// </summary>
    private void FillHeroMenu()
    {
        heroMenu.DropDownItems.Clear();
        string current = window.CurrentHero;

        foreach (var hero in HeroLibrary.Scan())
        {
            string label = hero.HasPoses ? $"{hero.Name}   ({hero.Poses.Count} pose{(hero.Poses.Count == 1 ? "" : "s")})"
                : hero.Emblem != null ? $"{hero.Name}   (emblem, add poses)"
                : $"{hero.Name}   (add pictures)";
            string name = hero.Name;
            var item = new ToolStripMenuItem(label, null, (_, _) => window.SetHero(name))
            {
                Enabled = hero.Usable,
                Checked = name.Equals(current, StringComparison.OrdinalIgnoreCase),
            };
            heroMenu.DropDownItems.Add(item);
        }

        heroMenu.DropDownItems.Add(new ToolStripSeparator());
        heroMenu.DropDownItems.Add(new ToolStripMenuItem(HeroLibrary.Drawn, null, (_, _) => window.UseDrawing())
        {
            Checked = current.Equals(HeroLibrary.Drawn, StringComparison.OrdinalIgnoreCase),
        });
        heroMenu.DropDownItems.Add(new ToolStripMenuItem(HeroLibrary.MyPicture, null, (_, _) => window.UseSavedImage())
        {
            Checked = current.Equals(HeroLibrary.MyPicture, StringComparison.OrdinalIgnoreCase),
            Enabled = settings.ImageFile != null,
        });
        heroMenu.DropDownItems.Add("Use my own picture...", null, (_, _) => ChoosePicture());
        heroMenu.DropDownItems.Add(new ToolStripMenuItem("Flip my picture (it shows him upright)", null, (_, _) => window.FlipImage())
        {
            Checked = settings.FlipImage,
        });

        heroMenu.DropDownItems.Add(new ToolStripSeparator());
        var rotate = new ToolStripMenuItem("Change hero every");
        foreach (int minutes in new[] { 0, 2, 5, 10, 30 })
        {
            int m = minutes;
            rotate.DropDownItems.Add(new ToolStripMenuItem(m == 0 ? "Never" : $"{m} minutes", null, (_, _) => window.SetRotate(m))
            {
                Checked = window.RotateMinutes == m,
            });
        }
        heroMenu.DropDownItems.Add(rotate);
        heroMenu.DropDownItems.Add("Next hero", null, (_, _) => window.NextHero());
        heroMenu.DropDownItems.Add("Open heroes folder", null, (_, _) => window.OpenHeroesFolder());
    }

    private void ChoosePicture()
    {
        using var dialog = new OpenFileDialog
        {
            Title = "Choose a picture to hang",
            Filter = "Pictures (PNG works best)|*.png;*.webp;*.gif;*.bmp;*.jpg;*.jpeg|All files|*.*",
        };
        if (dialog.ShowDialog() == DialogResult.OK)
        {
            window.UseImage(dialog.FileName);
        }
    }

    private void ShowProblem(string message)
    {
        notifyIcon.ShowBalloonTip(5000, "Spidey Hang", message, ToolTipIcon.Warning);
    }

    private void AddChoice(ToolStripMenuItem parent, string name, Func<bool> isChecked, Action apply)
    {
        var item = new ToolStripMenuItem(name, null, (_, _) =>
        {
            apply();
            settings.Save();
            window.ApplyLayout();
        });
        checks.Add((item, isChecked));
        parent.DropDownItems.Add(item);
    }

    private void RefreshChecks()
    {
        foreach (var (item, isChecked) in checks)
        {
            item.Checked = isChecked();
        }
    }

    /// <summary>
    /// Uses NotifyIcon's own (private) ShowContextMenu. It brings the menu to the foreground first.
    /// Without that, the menu would not close when you click somewhere else, because the overlay never takes focus.
    /// </summary>
    private void ShowMenuAtCursor()
    {
        var show = typeof(NotifyIcon).GetMethod("ShowContextMenu", BindingFlags.Instance | BindingFlags.NonPublic);
        if (show != null)
        {
            show.Invoke(notifyIcon, null);
        }
        else
        {
            menu.Show(Cursor.Position);
        }
    }

    /// <summary>A small Spidey mask, drawn in code so the app needs no .ico file.</summary>
    private static Icon CreateIcon()
    {
        using var bitmap = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);

            using var red = new SolidBrush(Color.FromArgb(0xC8, 0x20, 0x2A));
            using var white = new SolidBrush(Color.FromArgb(0xF5, 0xF5, 0xF5));
            using var ink = new Pen(Color.FromArgb(0x0E, 0x0E, 0x14), 1.4f);
            using var web = new Pen(Color.FromArgb(150, 0x0E, 0x0E, 0x14), 0.8f);

            g.FillEllipse(red, 4, 1, 24, 30);
            g.DrawLine(web, 16, 1, 16, 31);
            g.DrawArc(web, 4, -2, 24, 14, 20, 140);
            g.DrawArc(web, 4, 12, 24, 14, 20, 140);

            // Inner corners lower than outer corners.
            foreach (int side in new[] { -1, 1 })
            {
                var state = g.Save();
                g.TranslateTransform(16 + side * 5.5f, 16.5f);
                g.RotateTransform(-side * 24);
                g.FillEllipse(white, -5.5f, -3.3f, 11, 6.6f);
                g.DrawEllipse(ink, -5.5f, -3.3f, 11, 6.6f);
                g.Restore(state);
            }
        }
        return Icon.FromHandle(bitmap.GetHicon());
    }

    public void Dispose()
    {
        window.MenuRequested -= ShowMenuAtCursor;
        window.Problem -= ShowProblem;
        notifyIcon.Visible = false;
        notifyIcon.Dispose();
        menu.Dispose();
        icon.Dispose();
    }
}
