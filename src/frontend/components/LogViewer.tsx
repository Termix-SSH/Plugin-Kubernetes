import { getErrorMessage } from "../error-message";
import {
  Button,
  Select2,
  cn,
  copyToClipboard,
  useAdaptivePolling,
  PanelSearch,
} from "@termix-ssh/plugin-sdk/ui";
import type { LogQuery, ResourceRef } from "../types";
import React from "react";
import {
  Clock,
  Copy,
  Download,
  History,
  Radio,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { useKubernetesApi } from "../kubernetes-api";

interface LogViewerProps {
  sessionId: string;
  context?: string;
  target: ResourceRef;
  /** Container names; a picker shows when there is more than one. */
  containers?: string[];
}

const MAX_TAIL = 10_000;

function ToolbarToggle({
  active,
  onClick,
  title,
  bordered,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  bordered?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        "flex size-8 items-center justify-center transition-colors focus-visible:relative focus-visible:z-10 focus-visible:ring-1 focus-visible:ring-ring",
        bordered && "border-l border-border",
        active
          ? "bg-accent-brand/10 text-accent-brand"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function getLogColor(line: string): string {
  if (line.includes(" WARN") || line.includes(" warn"))
    return "text-warning/90";
  if (line.includes(" ERROR") || line.includes(" error"))
    return "text-destructive";
  if (line.includes(" DEBUG") || line.includes(" debug"))
    return "text-muted-foreground/60";
  return "text-foreground/90";
}

export function LogViewer({
  sessionId,
  context,
  target,
  containers = [],
}: LogViewerProps): React.ReactElement {
  const { t } = useTranslation();
  const kube = useKubernetesApi();
  const isPod = target.kind === "pods";
  const [container, setContainer] = React.useState(
    isPod && containers.length > 0 ? containers[0] : "",
  );
  const [previous, setPrevious] = React.useState(false);
  const [rawLogs, setRawLogs] = React.useState<string[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isDownloading, setIsDownloading] = React.useState(false);
  const [tailLines, setTailLines] = React.useState("100");
  const [showTimestamps, setShowTimestamps] = React.useState(false);
  const [autoRefresh, setAutoRefresh] = React.useState(false);
  const [logSearch, setLogSearch] = React.useState("");
  const logsEndRef = React.useRef<HTMLDivElement>(null);
  const rawLogsRef = React.useRef(rawLogs);
  rawLogsRef.current = rawLogs;

  const fetchLogs = React.useCallback(async () => {
    setIsLoading(true);
    try {
      const query: LogQuery = {
        tail: tailLines === "all" ? MAX_TAIL : parseInt(tailLines, 10),
        timestamps: showTimestamps,
        ...(container ? { container } : {}),
        ...(previous ? { previous } : {}),
      };
      const data = await kube.logs(sessionId, target, query, context);
      const next = data.logs.split("\n").filter(Boolean);
      const changed =
        next.length !== rawLogsRef.current.length ||
        next.some((line, index) => line !== rawLogsRef.current[index]);
      if (changed) {
        rawLogsRef.current = next;
        setRawLogs(next);
      }
      return changed;
    } catch (error) {
      toast.error(t("logs.failedToFetch", { error: getErrorMessage(error) }));
    } finally {
      setIsLoading(false);
    }
  }, [
    sessionId,
    context,
    target,
    container,
    previous,
    tailLines,
    showTimestamps,
    kube,
    t,
  ]);

  React.useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  useAdaptivePolling(
    fetchLogs,
    {
      minIntervalMs: 3_000,
      maxIntervalMs: 18_000,
      stablePollsPerStep: 2,
      maxRequestDutyCycle: 0.2,
    },
    autoRefresh,
    { runImmediately: false },
  );

  React.useEffect(() => {
    if (autoRefresh && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [rawLogs, autoRefresh]);

  const handleDownload = async () => {
    setIsDownloading(true);
    try {
      const data = await kube.logs(
        sessionId,
        target,
        {
          tail: MAX_TAIL,
          timestamps: showTimestamps,
          ...(container ? { container } : {}),
          ...(previous ? { previous } : {}),
        },
        context,
      );
      const blob = new Blob([data.logs], { type: "text/plain" });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${[target.name, container]
        .filter(Boolean)
        .join("_")
        .replace(/[^a-z0-9]/gi, "_")}_logs.txt`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      toast.success(t("logs.downloaded"));
    } catch (error) {
      toast.error(
        t("logs.failedToDownload", { error: getErrorMessage(error) }),
      );
    } finally {
      setIsDownloading(false);
    }
  };

  const filteredLogs = logSearch
    ? rawLogs.filter((l) => l.toLowerCase().includes(logSearch.toLowerCase()))
    : rawLogs;

  const handleCopy = async () => {
    if (await copyToClipboard(filteredLogs.join("\n"))) {
      toast.success(t("logs.copied", { count: filteredLogs.length }));
    } else {
      toast.error(t("logs.failedToCopy"));
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <PanelSearch
          value={logSearch}
          onChange={setLogSearch}
          placeholder={t("logs.filter")}
          className="min-w-40 flex-1 md:max-w-72"
        />
        <span className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">
          {logSearch
            ? `${filteredLogs.length}/${rawLogs.length}`
            : rawLogs.length}{" "}
          {t("logs.lines")}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {containers.length > 1 && (
            <Select2
              value={container}
              onChange={(e) => setContainer(e.target.value)}
              className="h-8 w-36 text-xs"
              align="end"
              aria-label={t("logs.container")}
            >
              {!isPod && <option value="">{t("logs.allContainers")}</option>}
              {containers.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select2>
          )}
          <Select2
            value={tailLines}
            onChange={(e) => setTailLines(e.target.value)}
            className="h-8 w-28 text-xs"
            align="end"
          >
            <option value="50">{t("logs.last50")}</option>
            <option value="100">{t("logs.last100")}</option>
            <option value="500">{t("logs.last500")}</option>
            <option value="1000">{t("logs.last1000")}</option>
            <option value="all">{t("logs.all")}</option>
          </Select2>
          <div className="flex items-center border border-border">
            <ToolbarToggle
              active={showTimestamps}
              onClick={() => setShowTimestamps(!showTimestamps)}
              title={t("logs.timestamps")}
            >
              <Clock className="size-4" />
            </ToolbarToggle>
            <ToolbarToggle
              active={autoRefresh}
              onClick={() => setAutoRefresh(!autoRefresh)}
              title={t("logs.autoRefresh")}
              bordered
            >
              <Radio className="size-4" />
            </ToolbarToggle>
            {isPod && (
              <ToolbarToggle
                active={previous}
                onClick={() => setPrevious(!previous)}
                title={t("logs.previous")}
                bordered
              >
                <History className="size-4" />
              </ToolbarToggle>
            )}
          </div>
          <div className="flex items-center">
            <Button
              variant="ghost"
              size="icon"
              onClick={fetchLogs}
              disabled={isLoading}
              title={t("kube.refresh")}
              aria-label={t("kube.refresh")}
            >
              <RefreshCw
                className={cn("size-4", isLoading && "animate-spin")}
              />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleCopy}
              disabled={filteredLogs.length === 0}
              title={t("logs.copy")}
              aria-label={t("logs.copy")}
            >
              <Copy className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleDownload}
              disabled={isDownloading}
              title={t("logs.download")}
              aria-label={t("logs.download")}
            >
              <Download className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setRawLogs([])}
              disabled={rawLogs.length === 0}
              title={t("logs.clear")}
              aria-label={t("logs.clear")}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 bg-background border border-border p-3 overflow-auto font-mono text-xs leading-relaxed scrollbar-thin min-h-0">
        {filteredLogs.length > 0 ? (
          filteredLogs.map((line, i) => {
            const tsEnd = line.indexOf(" ", 1);
            const maybeTs = tsEnd > 10 ? line.substring(0, tsEnd) : null;
            const rest = maybeTs ? line.substring(tsEnd) : line;
            return (
              <div key={i} className="whitespace-pre-wrap break-all">
                {maybeTs && (
                  <span className="text-accent-brand/50">{maybeTs}</span>
                )}
                <span className={getLogColor(rest)}>{rest}</span>
              </div>
            );
          })
        ) : (
          <span className="text-muted-foreground italic">
            {logSearch
              ? t("logs.noneMatching", { query: logSearch })
              : t("logs.none")}
          </span>
        )}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}
