import React from "react";
import { Copy, Eye, EyeOff, History, Inbox, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  EmptyState,
  copyToClipboard,
  useAdaptivePolling,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";
import { useCluster } from "../cluster-context";
import { getErrorMessage } from "../error-message";
import { useKubernetesApi } from "../kubernetes-api";
import type { ResourceRef, ResourceSummary, RolloutRevision } from "../types";
import { ResourceList } from "./ResourceList";
import { YamlEditor } from "./YamlEditor";

/** Pods a workload, service or node owns. */
export function PodsTab({ target }: { target: ResourceRef }) {
  const { t } = useTranslation();
  const kube = useKubernetesApi();
  const { sessionId, context, open } = useCluster();
  const [rows, setRows] = React.useState<ResourceSummary[] | null>(null);

  const load = React.useCallback(async () => {
    const next = await kube.pods(sessionId, target, context);
    setRows(next);
    return true;
  }, [kube, sessionId, target, context]);

  useAdaptivePolling(load, {
    minIntervalMs: 5_000,
    maxIntervalMs: 20_000,
    stablePollsPerStep: 3,
  });

  if (!rows) return <Loading />;
  return (
    <ResourceList
      kind="pods"
      rows={rows}
      view="list"
      showNamespace={target.kind === "nodes"}
      empty={<EmptyState icon={Inbox} title={t("detail.noPods")} />}
      onOpen={(row) =>
        open({ kind: "pods", name: row.name, namespace: row.namespace })
      }
      onChanged={() => void load()}
    />
  );
}

export function EventsTab({ target }: { target: ResourceRef }) {
  const { t } = useTranslation();
  const kube = useKubernetesApi();
  const { sessionId, context } = useCluster();
  const [rows, setRows] = React.useState<ResourceSummary[] | null>(null);

  useAdaptivePolling(
    async () => {
      setRows(await kube.events(sessionId, target, context));
      return true;
    },
    { minIntervalMs: 10_000, maxIntervalMs: 30_000, stablePollsPerStep: 2 },
  );

  if (!rows) return <Loading />;
  return (
    <ResourceList
      kind="events"
      rows={rows}
      view="list"
      showNamespace={false}
      empty={<EmptyState icon={Inbox} title={t("detail.noEvents")} />}
      onOpen={() => {}}
      onChanged={() => {}}
    />
  );
}

export function YamlTab({ target }: { target: ResourceRef }) {
  const kube = useKubernetesApi();
  const { sessionId, context } = useCluster();
  const [yaml, setYaml] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    kube
      .yaml(sessionId, target, context)
      .then((out) => {
        setYaml(out.yaml);
        setError(null);
      })
      .catch((err) => setError(getErrorMessage(err)));
  }, [kube, sessionId, target, context]);

  React.useEffect(load, [load]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (yaml === null) return <Loading />;
  return (
    <YamlEditor
      initial={yaml}
      mode="replace"
      namespace={target.namespace}
      onSaved={load}
      onReload={load}
    />
  );
}

export function HistoryTab({
  target,
  onChanged,
}: {
  target: ResourceRef;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const kube = useKubernetesApi();
  const confirm = useConfirm();
  const { sessionId, context, readOnly } = useCluster();
  const [rows, setRows] = React.useState<RolloutRevision[] | null>(null);
  const [details, setDetails] = React.useState<Record<number, string>>({});
  const [openRevision, setOpenRevision] = React.useState<number | null>(null);

  const load = React.useCallback(() => {
    kube
      .history(sessionId, target, context)
      .then(setRows)
      .catch((error) => {
        toast.error(getErrorMessage(error));
        setRows([]);
      });
  }, [kube, sessionId, target, context]);

  React.useEffect(load, [load]);

  const toggle = async (revision: number) => {
    if (openRevision === revision) return setOpenRevision(null);
    setOpenRevision(revision);
    if (details[revision]) return;
    try {
      const out = await kube.revision(sessionId, target, revision, context);
      setDetails((prev) => ({ ...prev, [revision]: out.details }));
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  const rollBack = async (revision: number) => {
    const ok = await confirm({
      title: t("history.confirmTitle", { revision }),
      description: t("history.confirmText", { name: target.name }),
      confirmLabel: t("history.rollBack"),
      destructive: false,
    });
    if (!ok) return;
    try {
      await kube.action(sessionId, target, "undo", { revision }, context);
      toast.success(t("history.rolledBack", { revision }));
      load();
      onChanged();
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  if (!rows) return <Loading />;
  if (rows.length === 0) {
    return <EmptyState icon={History} title={t("history.none")} />;
  }
  const newest = rows[0]?.revision;
  return (
    <div className="flex flex-col border border-border bg-card text-xs">
      {rows.map((row) => (
        <div
          key={row.revision}
          className="border-b border-border/50 last:border-0"
        >
          <div className="flex items-center gap-3 px-3 py-2">
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
              onClick={() => void toggle(row.revision)}
            >
              <span className="w-10 shrink-0 tabular-nums font-medium">
                #{row.revision}
              </span>
              <span className="truncate text-muted-foreground">
                {row.changeCause ?? t("history.noCause")}
              </span>
            </button>
            {row.revision === newest ? (
              <span className="text-[10px] uppercase tracking-wider text-green-500">
                {t("history.current")}
              </span>
            ) : (
              !readOnly && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void rollBack(row.revision)}
                >
                  <RotateCcw />
                  {t("history.rollBack")}
                </Button>
              )
            )}
          </div>
          {openRevision === row.revision && (
            <pre className="max-h-72 overflow-auto border-t border-border/50 bg-background px-3 py-2 font-mono text-[11px] whitespace-pre-wrap">
              {details[row.revision] ?? t("detail.loading")}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

/** Configmap values, or secret keys with a reveal button. */
export function DataTab({
  target,
  data,
  keys,
}: {
  target: ResourceRef;
  data?: Record<string, string>;
  keys: string[];
}) {
  const { t } = useTranslation();
  const kube = useKubernetesApi();
  const { sessionId, context, validation } = useCluster();
  const [revealed, setRevealed] = React.useState<Record<string, string> | null>(
    null,
  );
  const [busy, setBusy] = React.useState(false);
  const isSecret = target.kind === "secrets";
  const values = isSecret ? revealed : (data ?? {});

  const reveal = async () => {
    if (revealed) return setRevealed(null);
    setBusy(true);
    try {
      setRevealed((await kube.revealSecret(sessionId, target, context)).data);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (value: string) => {
    if (await copyToClipboard(value)) toast.success(t("data.copied"));
  };

  const allKeys = isSecret ? keys : Object.keys(data ?? {});
  if (allKeys.length === 0) {
    return <EmptyState icon={Inbox} title={t("data.empty")} />;
  }

  return (
    <div className="flex flex-col gap-2">
      {isSecret && (
        <div className="flex items-center gap-2">
          <p className="text-xs text-muted-foreground">
            {validation.canRevealSecrets
              ? t("data.secretHint")
              : t("data.secretNoPermission")}
          </p>
          {validation.canRevealSecrets && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => void reveal()}
              disabled={busy}
            >
              {revealed ? <EyeOff /> : <Eye />}
              {revealed ? t("data.hide") : t("data.reveal")}
            </Button>
          )}
        </div>
      )}
      <div className="flex flex-col border border-border bg-card text-xs">
        {allKeys.map((key) => {
          const value = values?.[key];
          return (
            <div
              key={key}
              className="flex flex-col gap-1 border-b border-border/50 px-3 py-2 last:border-0"
            >
              <div className="flex items-center gap-2">
                <span className="font-medium">{key}</span>
                {value !== undefined && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ml-auto size-6 [&_svg]:size-3"
                    title={t("data.copy")}
                    aria-label={t("data.copy")}
                    onClick={() => void copy(value)}
                  >
                    <Copy />
                  </Button>
                )}
              </div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">
                {value ?? "••••••••"}
              </pre>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Loading() {
  const { t } = useTranslation();
  return (
    <p className="py-6 text-center text-xs text-muted-foreground">
      {t("detail.loading")}
    </p>
  );
}
