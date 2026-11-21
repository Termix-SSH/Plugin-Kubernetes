import React from "react";
import { FileCode, Inbox, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  DataView,
  EmptyState,
  InlineView,
  ListBadge,
  LoadingState,
  NoticePanel,
  Select2,
  ToolbarBand,
  cn,
  useAdaptivePolling,
  useConfirm,
  type DataColumn,
} from "@termix-ssh/plugin-sdk/ui";
import { useCluster } from "../cluster-context";
import { getErrorMessage } from "../error-message";
import { TONE_BADGE, TONE_DOT, age } from "../kinds";
import { useKubernetesApi } from "../kubernetes-api";
import type { CrdSummary, CustomRow } from "../types";
import { YamlEditor } from "./YamlEditor";

interface CustomResourcesProps {
  namespace: string;
  search: string;
  showNamespace: boolean;
}

export function CustomResources({
  namespace,
  search,
  showNamespace,
}: CustomResourcesProps) {
  const { t } = useTranslation();
  const kube = useKubernetesApi();
  const confirm = useConfirm();
  const { sessionId, context, readOnly } = useCluster();
  const [crds, setCrds] = React.useState<CrdSummary[] | null>(null);
  const [crdError, setCrdError] = React.useState<string | null>(null);
  const [picked, setPicked] = React.useState("");
  const [rows, setRows] = React.useState<CustomRow[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<{
    row: CustomRow;
    yaml: string;
  } | null>(null);

  React.useEffect(() => {
    setCrds(null);
    kube
      .crds(sessionId, context)
      .then((list) => {
        setCrds(list);
        setCrdError(null);
        setPicked((current) =>
          list.some((crd) => crd.name === current)
            ? current
            : (list[0]?.name ?? ""),
        );
      })
      .catch((err) => {
        setCrds([]);
        setCrdError(getErrorMessage(err));
      });
  }, [kube, sessionId, context]);

  const crd = crds?.find((entry) => entry.name === picked) ?? null;
  const listKey = `${picked}|${namespace}|${context ?? ""}`;
  const listKeyRef = React.useRef(listKey);
  listKeyRef.current = listKey;

  React.useEffect(() => {
    setRows([]);
    setLoaded(false);
    setError(null);
  }, [listKey]);

  const load = React.useCallback(async () => {
    if (!crd) return false;
    const key = listKeyRef.current;
    try {
      const next = await kube.customList(sessionId, crd, {
        context,
        namespace: namespace || undefined,
      });
      if (key !== listKeyRef.current) return false;
      setRows(next);
      setError(null);
      return true;
    } catch (err) {
      if (key === listKeyRef.current) setError(getErrorMessage(err));
      return false;
    } finally {
      if (key === listKeyRef.current) setLoaded(true);
    }
  }, [kube, sessionId, crd, context, namespace]);

  useAdaptivePolling(
    load,
    { minIntervalMs: 5_000, maxIntervalMs: 30_000, stablePollsPerStep: 3 },
    !!crd && !editing,
  );

  const openYaml = async (row: CustomRow) => {
    try {
      const { yaml } = await kube.customYaml(sessionId, picked, row, context);
      setEditing({ row, yaml });
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const remove = async (row: CustomRow) => {
    const ok = await confirm({
      title: t("actions.delete.confirmTitle", { name: row.name }),
      description: t("actions.delete.confirmText", {
        kind: crd?.kind ?? picked,
      }),
      confirmLabel: t("actions.delete.label"),
    });
    if (!ok) return;
    try {
      await kube.customDelete(sessionId, picked, row, context);
      toast.success(t("actions.delete.done", { name: row.name }));
      void load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const query = search.trim().toLowerCase();
  const visible = rows.filter(
    (row) =>
      !query ||
      row.name.toLowerCase().includes(query) ||
      (row.namespace ?? "").includes(query) ||
      row.status.toLowerCase().includes(query),
  );

  const columns: DataColumn<CustomRow>[] = [
    {
      key: "name",
      header: t("columns.name"),
      width: "minmax(0,2fr)",
      cell: (row) => (
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[row.tone])}
          />
          <span className="truncate font-medium" title={row.name}>
            {row.name}
          </span>
        </span>
      ),
    },
    ...(showNamespace && crd?.namespaced
      ? [
          {
            key: "namespace",
            header: t("columns.namespace"),
            width: "minmax(0,1fr)",
            hideBelow: "md" as const,
            cell: (row: CustomRow) => (
              <span className="truncate text-muted-foreground">
                {row.namespace}
              </span>
            ),
          },
        ]
      : []),
    {
      key: "status",
      header: t("columns.status"),
      width: "160px",
      cell: (row) =>
        row.status ? (
          <ListBadge tone={TONE_BADGE[row.tone]}>{row.status}</ListBadge>
        ) : null,
    },
    {
      key: "age",
      header: t("columns.age"),
      width: "50px",
      align: "end",
      cell: (row) => (
        <span className="tabular-nums text-muted-foreground">
          {age(row.created)}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      width: "auto",
      align: "end",
      cell: (row) => (
        <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground [&_svg]:size-3.5"
            title={t("custom.yaml")}
            aria-label={t("custom.yaml")}
            onClick={() => void openYaml(row)}
          >
            <FileCode />
          </Button>
          {!readOnly && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-destructive [&_svg]:size-3.5"
              title={t("actions.delete.label")}
              aria-label={t("actions.delete.label")}
              onClick={() => void remove(row)}
            >
              <Trash2 />
            </Button>
          )}
        </div>
      ),
    },
  ];

  if (crds === null) return <LoadingState label={t("custom.loadingTypes")} />;
  if (crdError) {
    return (
      <NoticePanel tone="destructive" title={t("cluster.error")}>
        {crdError}
      </NoticePanel>
    );
  }
  if (crds.length === 0) {
    return <EmptyState icon={Inbox} title={t("custom.noTypes")} />;
  }

  return (
    <>
      <ToolbarBand>
        <Select2
          value={picked}
          onChange={(e) => setPicked(e.target.value)}
          aria-label={t("custom.type")}
          title={t("custom.type")}
          className="h-8 w-72 text-xs"
        >
          {crds.map((entry) => (
            <option key={entry.name} value={entry.name}>
              {entry.kind} ({entry.group})
            </option>
          ))}
        </Select2>
        {crd && !crd.namespaced && (
          <span className="text-xs text-muted-foreground">
            {t("custom.clusterScoped")}
          </span>
        )}
      </ToolbarBand>
      {!loaded ? (
        <LoadingState label={t("cluster.loading")} />
      ) : error ? (
        <NoticePanel tone="destructive" title={t("cluster.error")}>
          {error}
        </NoticePanel>
      ) : (
        <DataView<CustomRow>
          items={visible}
          view="list"
          getKey={(row) => `${row.namespace ?? ""}/${row.name}`}
          columns={{ base: 1 }}
          listColumns={columns}
          onRowClick={(row) => void openYaml(row)}
          empty={
            <EmptyState
              icon={Inbox}
              title={
                query
                  ? t("cluster.noMatches")
                  : t("cluster.empty", { kind: crd?.kind ?? picked })
              }
            />
          }
          renderCard={() => null}
        />
      )}
      {editing && (
        <InlineView
          open
          onOpenChange={(next) => !next && setEditing(null)}
          title={`${crd?.kind ?? ""} ${editing.row.name}`}
          icon={<FileCode className="size-4" />}
        >
          <YamlEditor
            initial={editing.yaml}
            mode="replace"
            namespace={editing.row.namespace ?? undefined}
            onReload={() => void openYaml(editing.row)}
            onSaved={() => void load()}
          />
        </InlineView>
      )}
    </>
  );
}
