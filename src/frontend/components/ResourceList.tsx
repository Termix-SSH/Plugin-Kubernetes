import React from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  DataView,
  ListBadge,
  cn,
  type DataColumn,
  type PanelViewMode,
} from "@termix-ssh/plugin-sdk/ui";
import {
  COLUMNS,
  TONE_BADGE,
  TONE_DOT,
  age,
  duration,
  formatBytes,
  formatCpu,
  isNamespaced,
  refKey,
} from "../kinds";
import type { KindId, ResourceSummary, UsageRow } from "../types";
import { ResourceActions } from "./ResourceActions";

export function StatusBadge({ row }: { row: ResourceSummary }) {
  return <ListBadge tone={TONE_BADGE[row.tone]}>{row.status}</ListBadge>;
}

function cellValue(
  row: ResourceSummary,
  key: string,
  format?: "seconds" | "date",
): string {
  const value = row.fields[key];
  if (value === null || value === undefined || value === "") return "";
  if (format === "seconds" && typeof value === "number") return duration(value);
  if (format === "date" && typeof value === "string") return age(value);
  return String(value);
}

interface ResourceListProps {
  kind: KindId;
  rows: ResourceSummary[];
  view: PanelViewMode;
  /** Shows the namespace column, for an all namespaces list. */
  showNamespace: boolean;
  /** Pod or node usage by name (namespace/name for pods). */
  usage?: Map<string, UsageRow>;
  compact?: boolean;
  empty: React.ReactNode;
  onOpen: (row: ResourceSummary) => void;
  onChanged: () => void;
}

export function usageKey(
  kind: KindId,
  row: { name: string; namespace?: string },
) {
  return kind === "pods" ? `${row.namespace ?? ""}/${row.name}` : row.name;
}

export function ResourceList({
  kind,
  rows,
  view,
  showNamespace,
  usage,
  compact = false,
  empty,
  onOpen,
  onChanged,
}: ResourceListProps) {
  const { t } = useTranslation();
  const hasUsage = !!usage && usage.size > 0;

  const columns = React.useMemo(() => {
    const list: DataColumn<ResourceSummary>[] = [
      {
        key: "name",
        header: t("columns.name"),
        width: compact ? "minmax(0,1fr)" : "minmax(0,2fr)",
        cell: (row) => (
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                TONE_DOT[row.tone],
              )}
            />
            <span className="truncate font-medium" title={row.name}>
              {row.name}
            </span>
          </span>
        ),
      },
    ];
    if (showNamespace && isNamespaced(kind) && !compact) {
      list.push({
        key: "namespace",
        header: t("columns.namespace"),
        width: "minmax(0,1fr)",
        hideBelow: "md",
        cell: (row) => (
          <span className="truncate text-muted-foreground">
            {row.namespace}
          </span>
        ),
      });
    }
    list.push({
      key: "status",
      header: t("columns.status"),
      width: compact ? "auto" : "130px",
      cell: (row) => <StatusBadge row={row} />,
    });
    const extra = compact
      ? COLUMNS[kind].filter((c) => c.key === "ready" || c.key === "restarts")
      : COLUMNS[kind];
    for (const column of extra) {
      list.push({
        key: column.key,
        header: t(`columns.${column.key}`),
        width: column.width,
        hideBelow: column.hideBelow,
        cell: (row) => (
          <span
            className="truncate text-muted-foreground"
            title={cellValue(row, column.key, column.format)}
          >
            {cellValue(row, column.key, column.format)}
          </span>
        ),
      });
    }
    if (hasUsage && !compact) {
      list.push(
        {
          key: "cpuUsage",
          header: t("columns.cpuUsage"),
          width: "80px",
          hideBelow: "md",
          align: "end",
          cell: (row) => {
            const u = usage?.get(usageKey(kind, row));
            return (
              <span className="font-mono font-bold tabular-nums text-accent-brand">
                {u ? formatCpu(u.cpu) : ""}
              </span>
            );
          },
        },
        {
          key: "memoryUsage",
          header: t("columns.memoryUsage"),
          width: "90px",
          hideBelow: "md",
          align: "end",
          cell: (row) => {
            const u = usage?.get(usageKey(kind, row));
            return (
              <span className="font-mono font-bold tabular-nums text-accent-brand">
                {u ? formatBytes(u.memory) : ""}
              </span>
            );
          },
        },
      );
    }
    list.push({
      key: "age",
      header: t("columns.age"),
      width: "50px",
      align: "end",
      hideBelow: compact ? undefined : "md",
      cell: (row) => (
        <span className="tabular-nums text-muted-foreground">
          {age(row.created)}
        </span>
      ),
    });
    if (kind !== "events" && !compact) {
      list.push({
        key: "actions",
        header: "",
        width: "auto",
        align: "end",
        cell: (row) => (
          <div onClick={(e) => e.stopPropagation()}>
            <ResourceActions row={row} onChanged={onChanged} size="row" />
          </div>
        ),
      });
    }
    return list;
  }, [kind, showNamespace, compact, hasUsage, usage, onChanged, t]);

  return (
    <DataView<ResourceSummary>
      items={rows}
      view={compact ? "list" : view}
      density={compact ? "compact" : undefined}
      getKey={refKey}
      columns={{ base: 1, md: 2, xl: 3 }}
      listColumns={columns}
      onRowClick={kind === "events" ? undefined : onOpen}
      empty={empty}
      renderCard={(row) => (
        <ResourceCard
          row={row}
          kind={kind}
          usage={usage?.get(usageKey(kind, row))}
          onOpen={() => onOpen(row)}
          onChanged={onChanged}
        />
      )}
    />
  );
}

function ResourceCard({
  row,
  kind,
  usage,
  onOpen,
  onChanged,
}: {
  row: ResourceSummary;
  kind: KindId;
  usage?: UsageRow;
  onOpen: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const facts = COLUMNS[kind]
    .map((column) => ({
      key: column.key,
      value: cellValue(row, column.key, column.format),
    }))
    .filter((fact) => fact.value);
  return (
    <div
      onClick={kind === "events" ? undefined : onOpen}
      className={cn(
        "flex h-full flex-col gap-2 border border-border bg-card p-3 text-xs transition-colors",
        kind !== "events" && "cursor-pointer hover:border-accent-brand/40",
      )}
    >
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "mt-1 size-2 shrink-0 rounded-full",
            TONE_DOT[row.tone],
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={row.name}>
            {row.name}
          </div>
          {row.namespace && (
            <div className="truncate text-muted-foreground">
              {row.namespace}
            </div>
          )}
        </div>
        <StatusBadge row={row} />
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        {facts.map((fact) => (
          <React.Fragment key={fact.key}>
            <dt className="text-muted-foreground">
              {t(`columns.${fact.key}`)}
            </dt>
            <dd className="truncate" title={fact.value}>
              {fact.value}
            </dd>
          </React.Fragment>
        ))}
        {usage && (
          <>
            <dt className="text-muted-foreground">{t("columns.cpuUsage")}</dt>
            <dd className="font-mono font-bold tabular-nums text-accent-brand">
              {formatCpu(usage.cpu)}
            </dd>
            <dt className="text-muted-foreground">
              {t("columns.memoryUsage")}
            </dt>
            <dd className="font-mono font-bold tabular-nums text-accent-brand">
              {formatBytes(usage.memory)}
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">{t("columns.age")}</dt>
        <dd>{age(row.created)}</dd>
      </dl>
      {kind !== "events" && (
        <div
          className="mt-auto flex justify-end border-t border-border/50 pt-2"
          onClick={(e) => e.stopPropagation()}
        >
          <ResourceActions row={row} onChanged={onChanged} size="row" />
        </div>
      )}
    </div>
  );
}
