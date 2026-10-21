import { getErrorMessage } from "../error-message";
import {
  Button,
  ConnectionLogProvider,
  ConnectionScreen,
  RobustClipboardProvider,
  Select2,
  cn,
  copyToClipboard,
  isElectron,
  pluginWsUrl,
  readFromClipboard,
  resolveConnectionOrigin,
  useAppTheme as useTheme,
  useConnectionLog,
} from "@termix-ssh/plugin-sdk/ui";
import type { KubeHost, ResourceSummary } from "../types";
import { useConsoleLook, type ConsoleLook } from "./console-look";
import React from "react";
import { useXTerm } from "react-xtermjs";
import { FitAddon } from "@xterm/addon-fit";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { WebLinksAddon } from "@xterm/addon-web-links";
import {
  Copy,
  Power,
  PowerOff,
  Terminal as TerminalIcon,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  useTranslation,
  useConnectionRetry,
} from "@termix-ssh/plugin-sdk/frontend";

function applyConsoleLook(
  terminal: NonNullable<ReturnType<typeof useXTerm>["instance"]>,
  look: ConsoleLook,
): void {
  terminal.options.cursorBlink = look.cursorBlink;
  terminal.options.cursorStyle = look.cursorStyle;
  terminal.options.fontSize = look.fontSize;
  terminal.options.fontFamily = look.fontFamily;
  terminal.options.scrollback = look.scrollback;
  terminal.options.letterSpacing = look.letterSpacing;
  terminal.options.lineHeight = look.lineHeight;
  terminal.options.theme = { ...look.colors };
}

interface ConsoleTerminalProps {
  pod: ResourceSummary;
  context?: string;
  hostConfig: KubeHost;
  readOnly?: boolean;
}

export function ConsoleTerminal(
  props: ConsoleTerminalProps,
): React.ReactElement {
  return (
    <ConnectionLogProvider>
      <ConsoleTerminalInner {...props} />
    </ConnectionLogProvider>
  );
}

function ConsoleTerminalInner({
  pod,
  context,
  hostConfig,
  readOnly = false,
}: ConsoleTerminalProps): React.ReactElement {
  const { t } = useTranslation();
  const containers = pod.containers ?? [];
  const [container, setContainer] = React.useState(containers[0] ?? "");
  const running = pod.status === "Running" && !readOnly;
  const podName = container ? `${pod.name}/${container}` : pod.name;
  const { theme: appTheme } = useTheme();
  const { instance: terminal, ref: xtermRef } = useXTerm();
  const { addLog, clearLogs } = useConnectionLog();

  // The SSH terminal's look on this host, or plain colors while it is off.
  const look = useConsoleLook(
    hostConfig as unknown as Parameters<typeof useConsoleLook>[0],
    appTheme,
  );
  const themeColors = look.colors;
  const lookRef = React.useRef<ConsoleLook>(look);
  lookRef.current = look;

  const [isConnected, setIsConnected] = React.useState(false);
  const [isConnecting, setIsConnecting] = React.useState(false);
  const [selectedShell, setSelectedShell] = React.useState<string>("bash");
  const wsRef = React.useRef<WebSocket | null>(null);
  const fitAddonRef = React.useRef<FitAddon | null>(null);
  const pingIntervalRef = React.useRef<NodeJS.Timeout | null>(null);
  const inputListenerRef = React.useRef<{ dispose: () => void } | null>(null);
  const tRef = React.useRef(t);
  tRef.current = t;

  React.useEffect(() => {
    if (!terminal) return;

    const fitAddon = new FitAddon();
    const clipboardProvider = new RobustClipboardProvider();
    const clipboardAddon = new ClipboardAddon(undefined, clipboardProvider);
    const webLinksAddon = new WebLinksAddon();

    fitAddonRef.current = fitAddon;

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(clipboardAddon);
    terminal.loadAddon(webLinksAddon);

    applyConsoleLook(terminal, lookRef.current);

    const readTextFromClipboard = async (): Promise<string> => {
      return readFromClipboard();
    };

    const writeTextToClipboard = async (text: string): Promise<void> => {
      await copyToClipboard(text);
    };

    terminal.attachCustomKeyEventHandler((e: KeyboardEvent): boolean => {
      if (e.type !== "keydown") return true;

      if (
        ((e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) ||
          (e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey)) &&
        e.key.toLowerCase() === "v"
      ) {
        e.preventDefault();
        e.stopPropagation();
        readTextFromClipboard()
          .then((text) => {
            if (text) terminal.paste(text);
          })
          .catch(() => {
            toast.error(tRef.current("terminal.clipboardReadFailed"));
          });
        return false;
      }

      if (
        e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        e.key.toLowerCase() === "c" &&
        terminal.hasSelection()
      ) {
        e.preventDefault();
        e.stopPropagation();
        const selection = terminal.getSelection();
        if (selection) {
          writeTextToClipboard(selection).catch(() => {
            toast.error(tRef.current("terminal.clipboardWriteFailed"));
          });
          terminal.clearSelection();
        }
        return false;
      }

      if (
        e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        e.key === "Insert" &&
        terminal.hasSelection()
      ) {
        e.preventDefault();
        e.stopPropagation();
        const selection = terminal.getSelection();
        if (selection) {
          writeTextToClipboard(selection).catch(() => {
            toast.error(tRef.current("terminal.clipboardWriteFailed"));
          });
        }
        return false;
      }

      if (
        e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        e.key === "Insert"
      ) {
        e.preventDefault();
        e.stopPropagation();
        readTextFromClipboard()
          .then((text) => {
            if (text) terminal.paste(text);
          })
          .catch(() => {
            toast.error(tRef.current("terminal.clipboardReadFailed"));
          });
        return false;
      }

      return true;
    });

    setTimeout(() => {
      fitAddon.fit();
    }, 100);

    const resizeHandler = () => {
      if (fitAddonRef.current) {
        fitAddonRef.current.fit();

        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          const { rows, cols } = terminal;
          wsRef.current.send(
            JSON.stringify({
              type: "resize",
              data: { rows, cols },
            }),
          );
        }
      }
    };

    window.addEventListener("resize", resizeHandler);

    return () => {
      window.removeEventListener("resize", resizeHandler);
      clipboardProvider.dispose();

      if (wsRef.current) {
        try {
          wsRef.current.send(JSON.stringify({ type: "disconnect" }));
        } catch {
          // Best-effort disconnect during cleanup.
        }
        wsRef.current.close();
        wsRef.current = null;
      }

      terminal.dispose();
    };
  }, [terminal]);

  React.useEffect(() => {
    if (!terminal) return;
    applyConsoleLook(terminal, look);
    fitAddonRef.current?.fit();
  }, [terminal, look]);

  const disconnect = React.useCallback(() => {
    if (wsRef.current) {
      try {
        wsRef.current.send(JSON.stringify({ type: "disconnect" }));
      } catch {
        // Best-effort disconnect.
      }
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsConnected(false);
    retryRef.current.reset();
    clearLogs();
    if (terminal) {
      try {
        terminal.clear();
      } catch {
        // Terminal clear can fail after disposal.
      }
    }
  }, [terminal, clearLogs]);

  const connect = React.useCallback(async () => {
    if (!terminal || !running) {
      toast.error(t("console.podMustBeRunning"));
      return;
    }

    setIsConnecting(true);
    addLog({
      type: "info",
      stage: "kube_connecting",
      message: t("console.connectingTo", { name: podName }),
    });

    try {
      if (fitAddonRef.current) {
        fitAddonRef.current.fit();
      }

      const isElectronApp = isElectron();

      const origin = isElectronApp
        ? await resolveConnectionOrigin({
            connectionOrigin: hostConfig.connectionOrigin,
          })
        : "local";

      const resolvedUrl = await pluginWsUrl("kubernetes", "/console", {
        origin,
      });
      if (!resolvedUrl) {
        setIsConnecting(false);
        toast.error(t("errors.remoteServerRequired"));
        return;
      }

      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      const ws = new WebSocket(resolvedUrl.url, resolvedUrl.protocols);

      ws.onopen = () => {
        const cols = terminal.cols || 80;
        const rows = terminal.rows || 24;

        ws.send(
          JSON.stringify({
            type: "connect",
            data: {
              hostConfig: {
                id: hostConfig.id,
                syncId: hostConfig.syncId ?? null,
                ip: hostConfig.ip,
              },
              namespace: pod.namespace,
              pod: pod.name,
              container: container || undefined,
              context,
              shell: selectedShell,
              cols,
              rows,
            },
          }),
        );
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          switch (msg.type) {
            case "output":
              terminal.write(msg.data);
              break;

            case "connected":
              setIsConnected(true);
              setIsConnecting(false);
              retryRef.current.markConnected();

              toast.success(t("console.connectedTo", { name: podName }));

              setTimeout(() => {
                if (fitAddonRef.current) {
                  fitAddonRef.current.fit();
                }

                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({
                      type: "resize",
                      data: { rows: terminal.rows, cols: terminal.cols },
                    }),
                  );
                }
              }, 100);
              break;

            case "disconnected":
              setIsConnected(false);
              setIsConnecting(false);
              retryRef.current.reset();
              terminal.write(
                `\r\n\x1b[1;33m${msg.message || t("console.disconnected")}\x1b[0m\r\n`,
              );
              if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
              }
              break;

            case "error":
              setIsConnecting(false);
              toast.error(msg.message || t("console.consoleError"));
              terminal.write(
                `\r\n\x1b[1;31m${t("console.errorMessage", { message: msg.message })}\x1b[0m\r\n`,
              );
              addLog({
                type: "error",
                stage: "error",
                message: msg.message || t("console.consoleError"),
              });
              retryRef.current.markFailed();
              break;
          }
        } catch (error) {
          console.error("Failed to parse WebSocket message:", error);
        }
      };

      ws.onerror = (error) => {
        console.error("WebSocket error:", error);
        setIsConnecting(false);
        setIsConnected(false);
        toast.error(t("console.failedToConnect"));
        addLog({
          type: "error",
          stage: "error",
          message: t("console.failedToConnect"),
        });
        retryRef.current.markFailed();
      };

      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
      }
      pingIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 30000);

      ws.onclose = () => {
        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }
        setIsConnected(false);
        setIsConnecting(false);
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
      };

      wsRef.current = ws;

      inputListenerRef.current?.dispose();
      inputListenerRef.current = terminal.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "input",
              data,
            }),
          );
        }
      });
    } catch (error) {
      setIsConnecting(false);
      const message = t("console.failedToConnectWithError", {
        error: getErrorMessage(error),
      });
      toast.error(message);
      addLog({ type: "error", stage: "error", message });
      retryRef.current.markFailed();
    }
  }, [
    terminal,
    running,
    hostConfig,
    pod,
    container,
    context,
    selectedShell,
    podName,
    t,
    addLog,
  ]);

  const retry = useConnectionRetry({
    connect,
    autoStart: false,
  });
  const retryRef = React.useRef(retry);
  retryRef.current = retry;

  React.useEffect(() => {
    return () => {
      inputListenerRef.current?.dispose();
      inputListenerRef.current = null;
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
      if (wsRef.current) {
        try {
          wsRef.current.send(JSON.stringify({ type: "disconnect" }));
        } catch {
          // Best-effort disconnect during cleanup.
        }
        wsRef.current.close();
        wsRef.current = null;
      }
      setIsConnected(false);
    };
  }, []);

  if (!running) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-2">
          <TerminalIcon className="h-12 w-12 text-muted-foreground/50 mx-auto" />
          <p className="text-muted-foreground text-lg">
            {readOnly ? t("console.readOnly") : t("console.podNotRunning")}
          </p>
          <p className="text-muted-foreground text-sm">
            {readOnly
              ? t("console.readOnlyHint")
              : t("console.podNotRunningHint")}
          </p>
        </div>
      </div>
    );
  }

  const copyBuffer = async () => {
    if (!terminal) return;
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
    }
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    if (await copyToClipboard(lines.join("\n"))) {
      toast.success(t("console.consoleCopied"));
    } else {
      toast.error(t("terminal.clipboardWriteFailed"));
    }
  };

  return (
    <div className="flex flex-col h-full gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              isConnected
                ? "bg-green-500"
                : isConnecting
                  ? "bg-warning animate-pulse"
                  : "bg-muted-foreground/40",
            )}
          />
          <span className="truncate">
            {isConnected
              ? t("console.connectedTo", { name: podName })
              : isConnecting
                ? t("console.connecting")
                : t("console.notConnected")}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {containers.length > 1 && (
            <Select2
              value={container}
              onChange={(event) => setContainer(event.target.value)}
              disabled={isConnected || isConnecting}
              title={t("logs.container")}
              className="h-8 w-32 text-xs"
              align="end"
            >
              {containers.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select2>
          )}
          <Select2
            value={selectedShell}
            onChange={(event) => setSelectedShell(event.target.value)}
            disabled={isConnected || isConnecting}
            placeholder={t("console.selectShell")}
            title={t("console.selectShell")}
            className="h-8 w-24 text-xs"
            align="end"
          >
            <option value="bash">bash</option>
            <option value="sh">sh</option>
            <option value="ash">ash</option>
            <option value="zsh">zsh</option>
          </Select2>
          <div className="flex items-center">
            <Button
              variant="ghost"
              size="icon"
              onClick={copyBuffer}
              disabled={!isConnected}
              title={t("console.copyConsole")}
              aria-label={t("console.copyConsole")}
            >
              <Copy className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => terminal?.clear()}
              disabled={!isConnected}
              title={t("console.clear")}
              aria-label={t("console.clear")}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
          {!isConnected ? (
            <Button
              variant="outline"
              onClick={connect}
              disabled={isConnecting}
              className="border-accent-brand/40 text-accent-brand hover:bg-accent-brand/10 hover:text-accent-brand dark:border-accent-brand/40 dark:bg-transparent dark:hover:bg-accent-brand/10"
            >
              <Power className="size-4" />
              {t("console.connect")}
            </Button>
          ) : (
            <Button onClick={disconnect} variant="destructive">
              <PowerOff className="size-4" />
              {t("console.disconnect")}
            </Button>
          )}
        </div>
      </div>

      <div
        className="relative flex-1 min-h-0 overflow-hidden border border-border pt-1"
        style={{ background: themeColors.background }}
      >
        <div
          ref={xtermRef}
          className="h-full w-full"
          style={{
            // Hidden but still laid out, so fit() measures the real size.
            visibility: isConnected ? "visible" : "hidden",
          }}
        />

        {!isConnected &&
          !isConnecting &&
          retry.status !== "error" &&
          retry.status !== "disconnected" && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center space-y-2">
                <TerminalIcon className="h-12 w-12 text-muted-foreground/50 mx-auto" />
                <p className="text-muted-foreground">
                  {t("console.notConnected")}
                </p>
                <p className="text-muted-foreground text-sm">
                  {t("console.clickToConnect")}
                </p>
              </div>
            </div>
          )}

        {!isConnected &&
          (isConnecting ||
            retry.status === "error" ||
            retry.status === "disconnected") && (
            <ConnectionScreen
              status={isConnecting ? "connecting" : retry.status}
              message={t("console.connectingTo", { name: podName })}
              attempt={retry.attempt}
              maxAttempts={retry.maxAttempts}
              nextRetryInMs={retry.nextRetryInMs}
              onManualRetry={() => {
                clearLogs();
                retry.retryNow();
              }}
              onClose={false}
            />
          )}
      </div>
    </div>
  );
}
