import React from "react";
import { ShipWheel } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  BackButton,
  Facts,
  PanelShell,
  TabStrip,
  useAdaptivePolling,
} from "@termix-ssh/plugin-sdk/ui";
import { useCluster } from "../cluster-context";
import { getErrorMessage } from "../error-message";
import { age, detailTabs, type DetailTab } from "../kinds";
import { useKubernetesApi } from "../kubernetes-api";
import type { ResourceDetailData, ResourceRef } from "../types";
import { ConsoleTerminal } from "./ConsoleTerminal";
import {
  DataTab,
  EventsTab,
  HistoryTab,
  Loading,
  PodsTab,
  YamlTab,
} from "./DetailTabs";
import { LogViewer } from "./LogViewer";
import { PodMetrics } from "./PodMetrics";
import { ResourceActions } from "./ResourceActions";
import { StatusBadge } from "./ResourceList";

interface ResourceDetailProps {
  target: ResourceRef;
  initialTab?: DetailTab;
  onBack: () => void;
}

export function ResourceDetail({
  target,
  initialTab,
  onBack,
}: ResourceDetailProps) {
  const { t } = useTranslation();
  const kube = useKubernetesApi();
  const { sessionId, context, host, readOnly } = useCluster();
  const tabs = detailTabs(target.kind);
  const [tab, setTab] = React.useState<DetailTab>(
    initialTab && tabs.includes(initialTab) ? initialTab : "overview",
  );
  const [detail, setDetail] = React.useState<ResourceDetailData | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setTab(initialTab && tabs.includes(initialTab) ? initialTab : "overview");
    setDetail(null);
    // A new target starts over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.kind, target.name, target.namespace, initialTab]);

  const load = React.useCallback(async () => {
    try {
      setDetail(await kube.get(sessionId, target, context));
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    }
    return true;
  }, [kube, sessionId, target, context]);

  useAdaptivePolling(load, {
    minIntervalMs: 10_000,
    maxIntervalMs: 30_000,
    stablePollsPerStep: 2,
  });

  const summary = detail?.summary;

  return (
    <PanelShell
      leading={<BackButton onClick={onBack} />}
      icon={<ShipWheel className="size-4" />}
      title={target.name}
      status={
        <Facts>
          {t(`kinds.${target.kind}.one`)}
          {target.namespace}
          {summary && age(summary.created)}
        </Facts>
      }
      actions={
        summary && (
          <div className="flex items-center gap-2">
            <StatusBadge row={summary} />
            <ResourceActions
              row={summary}
              onChanged={() => void load()}
              onDeleted={onBack}
            />
          </div>
        )
      }
      tabs={
        <TabStrip
          tabs={tabs.map((id) => ({ id, label: t(`detail.tabs.${id}`) }))}
          activeTab={tab}
          onTabChange={(id) => setTab(id as DetailTab)}
        />
      }
      scroll={false}
      className="p-2.5 gap-2"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {error && !detail ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : !summary ? (
          <Loading />
        ) : tab === "overview" ? (
          <Overview detail={detail} />
        ) : tab === "pods" ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <PodsTab target={target} />
          </div>
        ) : tab === "logs" ? (
          <LogViewer
            sessionId={sessionId}
            context={context}
            target={target}
            containers={summary.containers}
          />
        ) : tab === "console" ? (
          <ConsoleTerminal
            pod={summary}
            context={context}
            hostConfig={host}
            readOnly={readOnly}
          />
        ) : tab === "metrics" ? (
          <PodMetrics pod={summary} />
        ) : tab === "history" ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <HistoryTab target={target} onChanged={() => void load()} />
          </div>
        ) : tab === "data" ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <DataTab
              target={target}
              data={detail.data}
              keys={summary.keys ?? []}
            />
          </div>
        ) : tab === "yaml" ? (
          <YamlTab target={target} />
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <EventsTab target={target} />
          </div>
        )}
      </div>
    </PanelShell>
  );
}

function Overview({ detail }: { detail: ResourceDetailData }) {
  const { t } = useTranslation();
  const { summary } = detail;
  const facts: [string, string][] = Object.entries(summary.fields)
    .filter(([, value]) => value !== null && value !== "")
    .map(([key, value]) => [t(`columns.${key}`), String(value)]);
  const labels = Object.entries(summary.labels ?? {});
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
      {facts.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 border border-border bg-card p-3 text-xs">
          {facts.map(([label, value]) => (
            <React.Fragment key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="truncate" title={value}>
                {value}
              </dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      {labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {labels.map(([key, value]) => (
            <span
              key={key}
              className="border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            >
              {key}={value}
            </span>
          ))}
        </div>
      )}
      <pre className="min-h-40 flex-1 overflow-auto border border-border bg-background p-3 font-mono text-[11px] leading-relaxed whitespace-pre">
        {detail.describe || t("detail.noDescribe")}
      </pre>
    </div>
  );
}
