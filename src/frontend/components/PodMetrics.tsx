import React from "react";
import {
  Activity,
  Boxes,
  Cpu,
  Info,
  LineChart as LineChartIcon,
  MemoryStick,
  RefreshCw,
} from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  EmptyState,
  LineChart,
  SectionCard,
  useAdaptivePolling,
} from "@termix-ssh/plugin-sdk/ui";
import { useCluster } from "../cluster-context";
import { getErrorMessage } from "../error-message";
import { formatBytes, formatCpu } from "../kinds";
import { useKubernetesApi } from "../kubernetes-api";
import type { ResourceSummary, UsageRow } from "../types";
import { StatusBadge } from "./ResourceList";

const MAX_SAMPLES = 60;
const BRAND = "var(--accent-brand, #f59145)";
const SHADES = [
  BRAND,
  "color-mix(in oklab, var(--accent-brand, #f59145) 60%, white)",
  "color-mix(in oklab, var(--accent-brand, #f59145) 60%, black)",
  "color-mix(in oklab, var(--accent-brand, #f59145) 35%, white)",
];

interface Sample {
  at: string;
  rows: UsageRow[];
}

/** Keeps the newest samples, oldest first. */
export function pushSample(samples: Sample[], sample: Sample): Sample[] {
  const next = [...samples, sample];
  return next.length > MAX_SAMPLES ? next.slice(-MAX_SAMPLES) : next;
}

/** What usage is measured against: the containers' limits, or the node. */
export function usageBase(
  pod: ResourceSummary,
  node: ResourceSummary["capacity"] | null,
  key: "cpu" | "memory",
): { value: number; of: "limit" | "node" } | null {
  const limits = (pod.resources ?? []).map((r) =>
    key === "cpu" ? r.cpuLimit : r.memoryLimit,
  );
  if (limits.length > 0 && limits.every((v) => v !== null && v > 0)) {
    return {
      value: limits.reduce<number>((sum, v) => sum + (v ?? 0), 0),
      of: "limit",
    };
  }
  const capacity = node?.[key];
  return capacity ? { value: capacity, of: "node" } : null;
}

function percent(used: number, base: { value: number } | null): number | null {
  if (!base || base.value <= 0) return null;
  return (used / base.value) * 100;
}

function UsageCard({
  title,
  icon,
  pct,
  detail,
}: {
  title: string;
  icon: React.ReactNode;
  pct: number | null;
  detail: string;
}) {
  return (
    <SectionCard title={title} icon={icon}>
      <div className="flex flex-col gap-3 py-2">
        <div className="flex items-end justify-between gap-2">
          <span className="text-3xl font-bold text-accent-brand">
            {pct === null ? "-" : `${pct.toFixed(pct < 10 ? 1 : 0)}%`}
          </span>
          <span className="text-right text-[10px] font-bold uppercase text-muted-foreground">
            {detail}
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden bg-muted">
          <div
            className="h-full bg-accent-brand transition-all duration-500"
            style={{ width: `${Math.min(pct ?? 0, 100)}%` }}
          />
        </div>
      </div>
    </SectionCard>
  );
}

function InfoRow({
  label,
  children,
  last,
}: {
  label: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 py-1 text-xs ${last ? "" : "border-b border-border/50"}`}
    >
      <span className="font-semibold text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-mono">{children}</span>
    </div>
  );
}

export function PodMetrics({ pod }: { pod: ResourceSummary }) {
  const { t } = useTranslation();
  const kube = useKubernetesApi();
  const { sessionId, context } = useCluster();
  const [samples, setSamples] = React.useState<Sample[]>([]);
  const [available, setAvailable] = React.useState<boolean | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [node, setNode] = React.useState<ResourceSummary["capacity"] | null>(
    null,
  );
  const running = pod.status === "Running";
  const target = React.useMemo(
    () => ({ kind: "pods" as const, name: pod.name, namespace: pod.namespace }),
    [pod.name, pod.namespace],
  );
  const nodeName = pod.fields.node ? String(pod.fields.node) : null;

  React.useEffect(() => {
    if (!nodeName) return;
    kube
      .get(sessionId, { kind: "nodes", name: nodeName }, context)
      .then((detail) => setNode(detail.summary.capacity ?? null))
      .catch(() => setNode(null));
  }, [kube, sessionId, context, nodeName]);

  useAdaptivePolling(
    async () => {
      try {
        const result = await kube.containerMetrics(sessionId, target, context);
        setAvailable(result.available);
        setError(null);
        if (result.available) {
          setSamples((prev) =>
            pushSample(prev, {
              at: new Date().toISOString(),
              rows: result.rows,
            }),
          );
        }
      } catch (err) {
        setError(getErrorMessage(err));
      }
      return true;
    },
    { minIntervalMs: 5_000, maxIntervalMs: 15_000, stablePollsPerStep: 3 },
    running,
  );

  if (!running) {
    return (
      <div className="flex h-full flex-col items-center justify-center py-20 opacity-20">
        <Activity className="mb-4 size-16" />
        <span className="text-xl font-bold uppercase tracking-widest">
          {t("console.podNotRunning")}
        </span>
        <span className="text-xs font-semibold">{t("metrics.startPod")}</span>
      </div>
    );
  }

  if (available === false) {
    return (
      <EmptyState
        icon={Activity}
        title={t("metrics.unavailable")}
        hint={t("metrics.unavailableHint")}
      />
    );
  }

  if (error && samples.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center py-20 opacity-40">
        <Activity className="mb-4 size-8" />
        <span className="text-sm font-semibold text-destructive">
          {t("metrics.error")}
        </span>
        <span className="mt-1 text-xs text-muted-foreground">{error}</span>
      </div>
    );
  }

  if (samples.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center py-20 opacity-40">
        <RefreshCw className="mb-4 size-8 animate-spin" />
        <span className="text-sm font-semibold">{t("metrics.loading")}</span>
      </div>
    );
  }

  const latest = samples.at(-1)?.rows ?? [];
  const cpuUsed = latest.reduce((sum, r) => sum + (r.cpu ?? 0), 0);
  const memUsed = latest.reduce((sum, r) => sum + (r.memory ?? 0), 0);
  const cpuBase = usageBase(pod, node, "cpu");
  const memBase = usageBase(pod, node, "memory");
  const ofLabel = (base: { of: "limit" | "node" } | null) =>
    base ? t(`metrics.of.${base.of}`) : t("metrics.noLimit");

  const names = [...new Set(samples.flatMap((s) => s.rows.map((r) => r.name)))];
  const timestamps = samples.map((s) => s.at);
  const seriesFor = (pick: (row: UsageRow) => number | null) =>
    names.map((name, i) => ({
      key: name,
      label: name,
      color: SHADES[i % SHADES.length],
      data: samples.map((s) => {
        const row = s.rows.find((r) => r.name === name);
        return row ? pick(row) : null;
      }),
    }));
  const maxOf = (values: (number | null)[]) =>
    Math.max(1, ...values.filter((v): v is number => v !== null));
  const cpu = seriesFor((r) => r.cpu);
  const memory = seriesFor((r) => r.memory);
  const limitsByName = new Map((pod.resources ?? []).map((r) => [r.name, r]));

  return (
    <div className="flex flex-col gap-3 overflow-auto">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        <UsageCard
          title={t("metrics.cpuUsage")}
          icon={<Cpu className="size-3.5" />}
          pct={percent(cpuUsed, cpuBase)}
          detail={`${formatCpu(cpuUsed)} / ${cpuBase ? formatCpu(cpuBase.value) : "-"} ${ofLabel(cpuBase)}`}
        />
        <UsageCard
          title={t("metrics.memoryUsage")}
          icon={<MemoryStick className="size-3.5" />}
          pct={percent(memUsed, memBase)}
          detail={`${formatBytes(memUsed)} / ${memBase ? formatBytes(memBase.value) : "-"} ${ofLabel(memBase)}`}
        />
        <SectionCard
          title={t("metrics.podInformation")}
          icon={<Info className="size-3.5" />}
        >
          <div className="flex flex-col py-1">
            <InfoRow label={t("columns.name")}>{pod.name}</InfoRow>
            <InfoRow label={t("columns.namespace")}>{pod.namespace}</InfoRow>
            <InfoRow label={t("columns.node")}>{nodeName ?? "-"}</InfoRow>
            <InfoRow label={t("columns.ip")}>{pod.fields.ip ?? "-"}</InfoRow>
            <InfoRow label={t("columns.restarts")}>
              {pod.fields.restarts ?? 0}
            </InfoRow>
            <InfoRow label={t("columns.status")} last>
              <StatusBadge row={pod} />
            </InfoRow>
          </div>
        </SectionCard>
      </div>

      <SectionCard
        title={t("metrics.containers")}
        icon={<Boxes className="size-3.5" />}
      >
        <div className="flex flex-col py-1 text-xs">
          <div className="grid grid-cols-[minmax(0,1fr)_110px_130px] border-b border-border/50 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            <span>{t("columns.container")}</span>
            <span className="text-right">{t("metrics.cpu")}</span>
            <span className="text-right">{t("metrics.memory")}</span>
          </div>
          {latest.map((row, i) => {
            const limits = limitsByName.get(row.name);
            return (
              <div
                key={row.name}
                className={`grid grid-cols-[minmax(0,1fr)_110px_130px] items-center py-1.5 ${i < latest.length - 1 ? "border-b border-border/50" : ""}`}
              >
                <span className="truncate font-semibold">{row.name}</span>
                <span className="text-right font-mono font-bold text-accent-brand">
                  {formatCpu(row.cpu)}
                  {limits?.cpuLimit ? (
                    <span className="font-normal text-muted-foreground">
                      {" "}
                      / {formatCpu(limits.cpuLimit)}
                    </span>
                  ) : null}
                </span>
                <span className="text-right font-mono font-bold text-accent-brand">
                  {formatBytes(row.memory)}
                  {limits?.memoryLimit ? (
                    <span className="font-normal text-muted-foreground">
                      {" "}
                      / {formatBytes(limits.memoryLimit)}
                    </span>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      </SectionCard>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <SectionCard
          title={t("metrics.cpuHistory")}
          icon={<LineChartIcon className="size-3.5" />}
        >
          {samples.length > 1 ? (
            <LineChart
              series={cpu}
              timestamps={timestamps}
              domain={[0, maxOf(cpu.flatMap((s) => s.data)) * 1.2]}
              yFormatter={(v) => formatCpu(v)}
            />
          ) : (
            <p className="py-6 text-center text-xs text-muted-foreground">
              {t("metrics.collecting")}
            </p>
          )}
        </SectionCard>
        <SectionCard
          title={t("metrics.memoryHistory")}
          icon={<LineChartIcon className="size-3.5" />}
        >
          {samples.length > 1 ? (
            <LineChart
              series={memory}
              timestamps={timestamps}
              domain={[0, maxOf(memory.flatMap((s) => s.data)) * 1.2]}
              yFormatter={(v) => formatBytes(v)}
            />
          ) : (
            <p className="py-6 text-center text-xs text-muted-foreground">
              {t("metrics.collecting")}
            </p>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
