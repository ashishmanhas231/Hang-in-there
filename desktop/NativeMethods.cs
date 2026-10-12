using System;
using System.Runtime.InteropServices;

namespace SpideyHang;

internal static class NativeMethods
{
    private const int GwlExStyle = -20;
    private const long WsExToolWindow = 0x00000080;
    private const long WsExAppWindow = 0x00040000;
    private const long WsExNoActivate = 0x08000000;

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    private static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    private const uint SwpNoSize = 0x0001;
    private const uint SwpNoZOrder = 0x0004;
    private const uint SwpNoActivate = 0x0010;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out NativePoint point);

    /// <summary>Moves a window in one call, in screen pixels, without resizing, re-ordering or activating it.</summary>
    public static void MoveWindow(IntPtr hwnd, int x, int y)
    {
        SetWindowPos(hwnd, IntPtr.Zero, x, y, 0, 0, SwpNoSize | SwpNoZOrder | SwpNoActivate);
    }

    /// <summary>The mouse pointer position in screen pixels.</summary>
    public static (int X, int Y) CursorPosition()
    {
        return GetCursorPos(out var p) ? (p.X, p.Y) : (0, 0);
    }

    /// <summary>
    /// Keeps the overlay out of Alt+Tab and stops it taking focus when clicked.
    /// Without NOACTIVATE, grabbing him would steal the keyboard from VS Code.
    /// </summary>
    public static void MakeOverlay(IntPtr hwnd)
    {
        long style = GetWindowLongPtr(hwnd, GwlExStyle).ToInt64();
        style = (style | WsExToolWindow | WsExNoActivate) & ~WsExAppWindow;
        SetWindowLongPtr(hwnd, GwlExStyle, new IntPtr(style));
    }
}
