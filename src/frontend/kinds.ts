import type { KindId, ResourceAction, Tone } from "./types";

export type SectionId = "workloads" | "network" | "config" | "cluster" | "helm";

export const SECTIONS: { id: SectionId; kinds: KindId[] }[] = [
  {
    id: "workloads",
    kinds: [
      "pods",
      "deployments",
      "statefulsets",
      "daemonsets",
      "replicasets",
      "jobs",
      "cronjobs",
    ],
  },
  { id: "network", kinds: ["services", "ingresses"] },
  { id: "config", kinds: ["configmaps", "secrets", "pvcs"] },
  { id: "cluster", kinds: ["nodes", "namespaces", "pvs", "events"] },
  { id: "helm", kinds: [] },
];

export const CLUSTER_KINDS: KindId[] = ["nodes", "namespaces", "pvs"];

export function isNamespaced(kind: KindId): boolean {
  return !CLUSTER_KINDS.includes(kind);
}

export interface ColumnDef {
  key: string;
  width: string;
  hideBelow?: "md" | "lg";
  format?: "seconds" | "date";
}

/** Extra table columns per kind, after name and status. */
export const COLUMNS: Record<KindId, ColumnDef[]> = {
  pods: [
    { key: "ready", width: "70px" },
    { key: "restarts", width: "80px" },
    { key: "node", width: "minmax(0,1fr)", hideBelow: "lg" },
    { key: "ip", width: "120px", hideBelow: "lg" },
  ],
  deployments: [
    { key: "ready", width: "70px" },
    { key: "upToDate", width: "80px", hideBelow: "md" },
    { key: "available", width: "80px", hideBelow: "md" },
    { key: "images", width: "minmax(0,1.5fr)", hideBelow: "lg" },
  ],
  statefulsets: [
    { key: "ready", width: "70px" },
    { key: "images", width: "minmax(0,1.5fr)", hideBelow: "lg" },
  ],
  daemonsets: [
    { key: "ready", width: "70px" },
    { key: "upToDate", width: "80px", hideBelow: "md" },
    { key: "available", width: "80px", hideBelow: "md" },
    { key: "images", width: "minmax(0,1.5fr)", hideBelow: "lg" },
  ],
  replicasets: [
    { key: "ready", width: "70px" },
    { key: "images", width: "minmax(0,1.5fr)", hideBelow: "lg" },
  ],
  jobs: [
    { key: "completions", width: "100px" },
    { key: "duration", width: "90px", format: "seconds", hideBelow: "md" },
  ],
  cronjobs: [
    { key: "schedule", width: "120px" },
    { key: "active", width: "70px" },
    { key: "lastSchedule", width: "110px", format: "date", hideBelow: "md" },
  ],
  services: [
    { key: "type", width: "110px" },
    { key: "clusterIP", width: "120px", hideBelow: "md" },
    { key: "externalIP", width: "minmax(0,1fr)", hideBelow: "lg" },
    { key: "ports", width: "minmax(0,1fr)" },
  ],
  ingresses: [
    { key: "class", width: "100px", hideBelow: "md" },
    { key: "hosts", width: "minmax(0,1.5fr)" },
    { key: "address", width: "minmax(0,1fr)", hideBelow: "md" },
    { key: "tls", width: "50px", hideBelow: "lg" },
  ],
  configmaps: [{ key: "keys", width: "70px" }],
  secrets: [
    { key: "type", width: "minmax(0,1.5fr)" },
    { key: "keys", width: "70px" },
  ],
  pvcs: [
    { key: "capacity", width: "90px" },
    { key: "access", width: "100px", hideBelow: "md" },
    { key: "storageClass", width: "minmax(0,1fr)", hideBelow: "md" },
    { key: "volume", width: "minmax(0,1fr)", hideBelow: "lg" },
  ],
  pvs: [
    { key: "capacity", width: "90px" },
    { key: "access", width: "100px", hideBelow: "md" },
    { key: "reclaim", width: "90px", hideBelow: "lg" },
    { key: "claim", width: "minmax(0,1fr)" },
  ],
  nodes: [
    { key: "roles", width: "minmax(0,1fr)" },
    { key: "version", width: "110px", hideBelow: "md" },
    { key: "internalIP", width: "120px", hideBelow: "md" },
    { key: "cpu", width: "60px", hideBelow: "lg" },
    { key: "memory", width: "100px", hideBelow: "lg" },
  ],
  namespaces: [],
  events: [
    { key: "reason", width: "130px" },
    { key: "object", width: "minmax(0,1fr)", hideBelow: "md" },
    { key: "message", width: "minmax(0,2fr)" },
    { key: "count", width: "60px", hideBelow: "lg" },
  ],
};

const SCALE: KindId[] = ["deployments", "statefulsets", "replicasets"];
const ROLLOUT: KindId[] = ["deployments", "statefulsets", "daemonsets"];

/** Mirrors the backend's ACTION_KINDS. */
export const ACTION_KINDS: Record<ResourceAction, KindId[]> = {
  scale: SCALE,
  restart: ROLLOUT,
  undo: ROLLOUT,
  setImage: ROLLOUT,
  suspend: ["cronjobs", "jobs"],
  resume: ["cronjobs", "jobs"],
  trigger: ["cronjobs"],
  cordon: ["nodes"],
  uncordon: ["nodes"],
  drain: ["nodes"],
};

export function supports(kind: KindId, action: ResourceAction): boolean {
  return ACTION_KINDS[action].includes(kind);
}

export const LOG_KINDS: KindId[] = [
  "pods",
  "deployments",
  "statefulsets",
  "daemonsets",
  "replicasets",
  "jobs",
];

export const POD_LIST_KINDS: KindId[] = [
  "deployments",
  "statefulsets",
  "daemonsets",
  "replicasets",
  "jobs",
  "services",
  "nodes",
];

export type DetailTab =
  | "overview"
  | "pods"
  | "logs"
  | "console"
  | "metrics"
  | "history"
  | "data"
  | "yaml"
  | "events";

export function detailTabs(kind: KindId): DetailTab[] {
  const tabs: DetailTab[] = ["overview"];
  if (POD_LIST_KINDS.includes(kind)) tabs.push("pods");
  if (LOG_KINDS.includes(kind)) tabs.push("logs");
  if (kind === "pods") tabs.push("console", "metrics");
  if (ROLLOUT.includes(kind)) tabs.push("history");
  if (kind === "configmaps" || kind === "secrets") tabs.push("data");
  if (kind !== "events") tabs.push("yaml", "events");
  return tabs;
}

export const TONE_BADGE: Record<
  Tone,
  "success" | "warning" | "destructive" | "muted"
> = {
  ok: "success",
  warn: "warning",
  error: "destructive",
  idle: "muted",
};

export const TONE_DOT: Record<Tone, string> = {
  ok: "bg-green-500",
  warn: "bg-warning",
  error: "bg-destructive",
  idle: "bg-muted-foreground/50",
};

/** "3d", "4h", "12m", "40s" from an ISO date. */
export function age(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatCpu(millicores: number | null): string {
  if (millicores === null) return "";
  return millicores >= 1000
    ? `${(millicores / 1000).toFixed(2)}`
    : `${Math.round(millicores)}m`;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Which status filter a row falls under. */
export function toneFilter(tone: Tone): "healthy" | "problem" | "idle" {
  if (tone === "ok") return "healthy";
  if (tone === "idle") return "idle";
  return "problem";
}

export function refKey(row: {
  kind: string;
  name: string;
  namespace?: string;
}) {
  return `${row.kind}/${row.namespace ?? ""}/${row.name}`;
}
