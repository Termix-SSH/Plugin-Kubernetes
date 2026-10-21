import React from "react";
import { Package, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  BackButton,
  Button,
  DataView,
  EmptyState,
  Facts,
  ListBadge,
  PanelShell,
  SwitchRow,
  TabStrip,
  useConfirm,
  type DataColumn,
  type PanelViewMode,
} from "@termix-ssh/plugin-sdk/ui";
import { useCluster } from "../cluster-context";
import { getErrorMessage } from "../error-message";
import { age } from "../kinds";
import { useKubernetesApi } from "../kubernetes-api";
import type { HelmRelease, HelmRevision } from "../types";
import { Loading } from "./DetailTabs";

export function helmTone(
  status: string,
): "success" | "warning" | "destructive" | "muted" {
  if (status === "deployed") return "success";
  if (status === "failed") return "destructive";
  if (status.startsWith("pending") || status === "uninstalling")
    return "warning";
  return "muted";
}

export function HelmList({
  releases,
  view,
  showNamespace,
  onOpen,
}: {
  releases: HelmRelease[];
  view: PanelViewMode;
  showNamespace: boolean;
  onOpen: (release: HelmRelease) => void;
}) {
  const { t } = useTranslation();
  const columns: DataColumn<HelmRelease>[] = [
    {
      key: "name",
      header: t("columns.name"),
      width: "minmax(0,1.5fr)",
      cell: (r) => <span className="truncate font-medium">{r.name}</span>,
    },
    ...(showNamespace
      ? [
          {
            key: "namespace",
            header: t("columns.namespace"),
            width: "minmax(0,1fr)",
            hideBelow: "md" as const,
            cell: (r: HelmRelease) => (
              <span className="truncate text-muted-foreground">
                {r.namespace}
              </span>
            ),
          },
        ]
      : []),
    {
      key: "status",
      header: t("columns.status"),
      width: "110px",
      cell: (r) => <ListBadge tone={helmTone(r.status)}>{r.status}</ListBadge>,
    },
    {
      key: "chart",
      header: t("columns.chart"),
      width: "minmax(0,1.5fr)",
      cell: (r) => (
        <span className="truncate text-muted-foreground">{r.chart}</span>
      ),
    },
    {
      key: "appVersion",
      header: t("columns.appVersion"),
      width: "100px",
      hideBelow: "md",
      cell: (r) => (
        <span className="truncate text-muted-foreground">{r.appVersion}</span>
      ),
    },
    {
      key: "revision",
      header: t("columns.revision"),
      width: "70px",
      align: "end",
      cell: (r) => <span className="tabular-nums">{r.revision}</span>,
    },
  ];
  return (
    <DataView
      items={releases}
      view={view}
      getKey={(r) => `${r.namespace}/${r.name}`}
      columns={{ base: 1, md: 2, xl: 3 }}
      listColumns={columns}
      onRowClick={onOpen}
      empty={<EmptyState icon={Package} title={t("helm.none")} />}
      renderCard={(r) => (
        <div
          onClick={() => onOpen(r)}
          className="flex h-full cursor-pointer flex-col gap-2 border border-border bg-card p-3 text-xs transition-colors hover:border-accent-brand/40"
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{r.name}</div>
              <div className="truncate text-muted-foreground">
                {r.namespace}
              </div>
            </div>
            <ListBadge tone={helmTone(r.status)}>{r.status}</ListBadge>
          </div>
          <Facts className="text-muted-foreground">
            {r.chart}
            {r.appVersion}
            {t("helm.revision", { revision: r.revision })}
          </Facts>
        </div>
      )}
    />
  );
}

type HelmTab = "history" | "values" | "manifest";

export function HelmDetail({
  release,
  onBack,
  onChanged,
}: {
  release: HelmRelease;
  onBack: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const kube = useKubernetesApi();
  const confirm = useConfirm();
  const { sessionId, context, readOnly } = useCluster();
  const [tab, setTab] = React.useState<HelmTab>("history");
  const [history, setHistory] = React.useState<HelmRevision[] | null>(null);
  const [values, setValues] = React.useState<string | null>(null);
  const [allValues, setAllValues] = React.useState(false);
  const [manifest, setManifest] = React.useState<string | null>(null);

  const loadHistory = React.useCallback(() => {
    kube
      .helmHistory(sessionId, release, context)
      .then(setHistory)
      .catch((error) => toast.error(getErrorMessage(error)));
  }, [kube, sessionId, release, context]);

  React.useEffect(loadHistory, [loadHistory]);

  React.useEffect(() => {
    if (tab !== "values") return;
    setValues(null);
    kube
      .helmValues(sessionId, release, allValues, context)
      .then((out) => setValues(out.values))
      .catch((error) => setValues(getErrorMessage(error)));
  }, [tab, allValues, kube, sessionId, release, context]);

  React.useEffect(() => {
    if (tab !== "manifest" || manifest !== null) return;
    kube
      .helmManifest(sessionId, release, context)
      .then((out) => setManifest(out.manifest))
      .catch((error) => setManifest(getErrorMessage(error)));
  }, [tab, manifest, kube, sessionId, release, context]);

  const rollBack = async (revision: number) => {
    const ok = await confirm({
      title: t("helm.rollbackTitle", { name: release.name, revision }),
      description: t("helm.rollbackText"),
      confirmLabel: t("history.rollBack"),
      destructive: false,
    });
    if (!ok) return;
    try {
      await kube.helmRollback(sessionId, release, revision, context);
      toast.success(t("helm.rolledBack", { name: release.name, revision }));
      loadHistory();
      onChanged();
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  const uninstall = async () => {
    const ok = await confirm({
      title: t("helm.uninstallTitle", { name: release.name }),
      description: t("helm.uninstallText"),
      confirmLabel: t("helm.uninstall"),
    });
    if (!ok) return;
    try {
      await kube.helmUninstall(sessionId, release, context);
      toast.success(t("helm.uninstalled", { name: release.name }));
      onChanged();
      onBack();
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  return (
    <PanelShell
      leading={<BackButton onClick={onBack} />}
      icon={<Package className="size-4" />}
      title={release.name}
      status={
        <Facts>
          {release.namespace}
          {release.chart}
          {age(release.updated)}
        </Facts>
      }
      actions={
        <div className="flex items-center gap-2">
          <ListBadge tone={helmTone(release.status)}>
            {release.status}
          </ListBadge>
          {!readOnly && (
            <Button
              variant="ghost"
              size="icon"
              title={t("helm.uninstall")}
              aria-label={t("helm.uninstall")}
              onClick={() => void uninstall()}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      }
      tabs={
        <TabStrip
          tabs={(["history", "values", "manifest"] as const).map((id) => ({
            id,
            label: t(`helm.tabs.${id}`),
          }))}
          activeTab={tab}
          onTabChange={(id) => setTab(id as HelmTab)}
        />
      }
      scroll={false}
      className="p-2.5 gap-2"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {tab === "history" &&
          (!history ? (
            <Loading />
          ) : (
            <div className="flex flex-col border border-border bg-card text-xs">
              {history.map((rev, index) => (
                <div
                  key={rev.revision}
                  className="flex items-center gap-3 border-b border-border/50 px-3 py-2 last:border-0"
                >
                  <span className="w-10 shrink-0 font-medium tabular-nums">
                    #{rev.revision}
                  </span>
                  <ListBadge tone={helmTone(rev.status)}>
                    {rev.status}
                  </ListBadge>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {[rev.chart, rev.description].filter(Boolean).join(" | ")}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {age(rev.updated)}
                  </span>
                  {index > 0 && !readOnly && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void rollBack(rev.revision)}
                    >
                      <RotateCcw />
                      {t("history.rollBack")}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ))}
        {tab === "values" && (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <SwitchRow
              label={t("helm.allValues")}
              description={t("helm.allValuesHint")}
              checked={allValues}
              onChange={setAllValues}
            />
            <pre className="min-h-40 flex-1 overflow-auto border border-border bg-background p-3 font-mono text-[11px] whitespace-pre">
              {values ?? t("detail.loading")}
            </pre>
          </div>
        )}
        {tab === "manifest" && (
          <pre className="min-h-40 flex-1 overflow-auto border border-border bg-background p-3 font-mono text-[11px] whitespace-pre">
            {manifest ?? t("detail.loading")}
          </pre>
        )}
      </div>
    </PanelShell>
  );
}
