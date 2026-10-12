using System;
using System.IO;
using System.IO.Pipes;
using System.Threading;
using System.Threading.Tasks;

namespace SpideyHang;

/// <summary>
/// Receives one-line text commands ("push 1", "reset", "exit") on the named pipe \\.\pipe\SpideyHang.
/// The VS Code extension and a second launch of the exe both use it.
///
/// CurrentUserOnly: other Windows accounts on this PC cannot connect.
/// </summary>
internal sealed class CommandPipe : IDisposable
{
    public const string Name = "SpideyHang";
    // Long enough for "image <full path>".
    private const int MaxLineLength = 1024;

    private readonly CancellationTokenSource cts = new();
    private readonly Action<string> onCommand;

    public CommandPipe(Action<string> onCommand)
    {
        this.onCommand = onCommand;
        _ = Task.Run(() => ListenAsync(cts.Token));
    }

    /// <summary>Sends one command to a running overlay. Does nothing if none is running.</summary>
    public static void Send(string command)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", Name, PipeDirection.Out, PipeOptions.CurrentUserOnly);
            client.Connect(1000);
            using var writer = new StreamWriter(client) { AutoFlush = true };
            writer.WriteLine(command);
        }
        catch (Exception)
        {
            // Not running, or busy. Nothing useful to do.
        }
    }

    private async Task ListenAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            var server = new NamedPipeServerStream(
                Name,
                PipeDirection.In,
                NamedPipeServerStream.MaxAllowedServerInstances,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            try
            {
                await server.WaitForConnectionAsync(ct);
            }
            catch (OperationCanceledException)
            {
                await server.DisposeAsync();
                return;
            }
            catch (IOException)
            {
                await server.DisposeAsync();
                await Task.Delay(500, ct).ConfigureAwait(false);
                continue;
            }

            // Hand this client off and go straight back to listening for the next one.
            _ = Task.Run(() => ReadAsync(server, ct));
        }
    }

    private async Task ReadAsync(NamedPipeServerStream server, CancellationToken ct)
    {
        await using (server)
        {
            using var reader = new StreamReader(server);
            try
            {
                string? line;
                while ((line = await reader.ReadLineAsync(ct)) != null)
                {
                    if (line.Length <= MaxLineLength)
                    {
                        onCommand(line);
                    }
                }
            }
            catch (Exception)
            {
                // Client went away mid-line. Ignore it.
            }
        }
    }

    public void Dispose()
    {
        cts.Cancel();
    }
}
