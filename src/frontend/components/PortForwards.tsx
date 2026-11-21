import React from "react";
import { Copy, Inbox, Plus, Square } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  DataView,
  EmptyState,
  FormFooter,
  InlineView,
  ListBadge,
  LoadingState,
  NoticePanel,
  NumberField,
  SelectField,
  TextField,
  ToolbarBand,
  useAdaptivePolling,
  useConfirm,
  type DataColumn,
} from "@termix-ssh/plugin-sdk/ui";
import { useCluster } from "../cluster-context";
import { getErrorMessage } from "../error-message";
import { age } from "../kinds";
import { useKubernetesApi } from "../kubernetes-api";
import type { ForwardKind, ForwardRow, ForwardSpec } from "../types";

const NAME_RE = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

/** The first port number in a field like "80/TCP,443:30443/TCP". */
export function firstPort(text: unknown): number | null {
  const match = /\d{1,5}/.exec(String(text ?? ""));
  const port = match ? Number(match[0]) : NaN;
  return port >= 1 && port <= 65535 ? port : null;
}

/** Ports under 1024 need root, so suggest one above it. */
export function localPortFor(remote: number): number {
  return remote >= 1024 ? remote : remote + 8000;
}

interface ForwardFormProps {
  initial: Partial<ForwardSpec>;
  /** Kind and name are fixed when started from a resource. */
  fixedTarget?: boolean;
  onClose: () => void;
  onStarted: () => void;
}

export function ForwardForm({
  initial,
  fixedTarget = false,
  onClose,
  onStarted,
}: ForwardFormProps) {
  const { t } = useTranslation();
  const kube = useKubernetesApi();
  const { sessionId, context, host } = useCluster();
  const remoteDefault = initial.remotePort ?? 80;
  const [kind, setKind] = React.useState<ForwardKind>(initial.kind ?? "pods");
  const [name, setName] = React.useState(initial.name ?? "");
  const [namespace, setNamespace] = React.useState(
    initial.namespace ?? "default",
  );
  const [remotePort, setRemotePort] = React.useState(remoteDefault);
  const [localPort, setLocalPort] = React.useState(
    initial.localPort ?? localPortFor(remoteDefault),
  );
  const [address, setAddress] =
    React.useState<ForwardSpec["address"]>("127.0.0.1");
  const [saving, setSaving] = React.useState(false);

  const valid = NAME_RE.test(name) && NAME_RE.test(namespace);

  const start = async () => {
    setSaving(true);
    try {
      await kube.startForward(
        sessionId,
        { kind, name, namespace, localPort, remotePort, address },
        context,
      );
      toast.success(
        t("forwards.started", {
          address: `${address === "0.0.0.0" ? host.ip : "127.0.0.1"}:${localPort}`,
        }),
      );
      onStarted();
      onClose();
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <InlineView
      open
      onOpenChange={(next) => !next && onClose()}
      title={fixedTarget ? t("forwards.titleFor", { name }) : t("forwards.new")}
      footer={
        <FormFooter
          onCancel={onClose}
          onSave={() => void start()}
          saveLabel={t("forwards.start")}
          saving={saving}
          disabled={!valid}
        />
      }
    >
      {!fixedTarget && (
        <>
          <SelectField
            label={t("forwards.kind")}
            value={kind}
            onChange={(value) => setKind(value as ForwardKind)}
            options={(["pods", "services", "deployments"] as const).map(
              (value) => ({ value, label: t(`kinds.${value}.one`) }),
            )}
          />
          <TextField
            label={t("columns.name")}
            value={name}
            onChange={setName}
            mono
          />
          <TextField
            label={t("columns.namespace")}
            value={namespace}
            onChange={setNamespace}
            mono
          />
        </>
      )}
      <NumberField
        label={t("forwards.remotePort")}
        value={remotePort}
        onChange={setRemotePort}
        min={1}
        max={65535}
      />
      <NumberField
        label={t("forwards.localPort")}
        value={localPort}
        onChange={setLocalPort}
        min={1}
        max={65535}
        hint={t("forwards.localPortHint")}
      />
      <SelectField
        label={t("forwards.address")}
        value={address}
        onChange={(value) => setAddress(value as ForwardSpec["address"])}
        options={[
          { value: "127.0.0.1", label: t("forwards.addressLocal") },
          { value: "0.0.0.0", label: t("forwards.addressAll") },
        ]}
      />
      {address === "0.0.0.0" && (
        <p className="text-xs text-warning">{t("forwards.addressAllHint")}</p>
      )}
    </InlineView>
  );
}

export function PortForwards({ search }: { search: string }) {
  const { t } = useTranslation();
  const kube = useKubernetesApi();
  const confirm = useConfirm();
  const { sessionId, host, readOnly } = useCluster();
  const [rows, setRows] = React.useState<ForwardRow[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      setRows(await kube.forwards(sessionId));
      setError(null);
      return true;
    } catch (err) {
      setError(getErrorMessage(err));
      return false;
    } finally {
      setLoaded(true);
    }
  }, [kube, sessionId]);

  useAdaptivePolling(
    load,
    { minIntervalMs: 5_000, maxIntervalMs: 30_000, stablePollsPerStep: 3 },
    true,
  );

  const where = (row: ForwardRow) =>
    `${row.address === "0.0.0.0" ? host.ip : "127.0.0.1"}:${row.localPort}`;

  const stop = async (row: ForwardRow) => {
    const ok = await confirm({
      title: t("forwards.stopTitle", { name: row.name }),
      confirmLabel: t("forwards.stop"),
    });
    if (!ok) return;
    try {
      await kube.stopForward(sessionId, row.id);
      void load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const query = search.trim().toLowerCase();
  const visible = rows.filter(
    (row) =>
      !query ||
      row.name.includes(query) ||
      row.namespace.includes(query) ||
      String(row.localPort).includes(query),
  );

  const columns: DataColumn<ForwardRow>[] = [
    {
      key: "name",
      header: t("columns.name"),
      width: "minmax(0,2fr)",
      cell: (row) => (
        <span className="truncate font-medium">
          {t(`kinds.${row.kind}.one`)} {row.name}
        </span>
      ),
    },
    {
      key: "namespace",
      header: t("columns.namespace"),
      width: "minmax(0,1fr)",
      hideBelow: "md",
      cell: (row) => (
        <span className="truncate text-muted-foreground">{row.namespace}</span>
      ),
    },
    {
      key: "ports",
      header: t("forwards.ports"),
      width: "minmax(0,1.5fr)",
      cell: (row) => (
        <span className="truncate font-mono text-xs">
          {where(row)} {"->"} {row.remotePort}
        </span>
      ),
    },
    {
      key: "status",
      header: t("columns.status"),
      width: "minmax(0,1.5fr)",
      cell: (row) => (
        <span className="flex min-w-0 items-center gap-2">
          <ListBadge tone={row.running ? "success" : "destructive"}>
            {row.running ? t("forwards.running") : t("forwards.stopped")}
          </ListBadge>
          {!row.running && row.lastLine && (
            <span
              className="truncate text-xs text-muted-foreground"
              title={row.lastLine}
            >
              {row.lastLine}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "age",
      header: t("columns.age"),
      width: "50px",
      align: "end",
      hideBelow: "md",
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
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground [&_svg]:size-3.5"
            title={t("forwards.copy")}
            aria-label={t("forwards.copy")}
            onClick={() => {
              void navigator.clipboard?.writeText(where(row));
              toast.success(t("forwards.copied"));
            }}
          >
            <Copy />
          </Button>
          {!readOnly && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-destructive [&_svg]:size-3.5"
              title={t("forwards.stop")}
              aria-label={t("forwards.stop")}
              onClick={() => void stop(row)}
            >
              <Square />
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <ToolbarBand>
        <p className="flex-1 text-xs text-muted-foreground">
          {t("forwards.hint")}
        </p>
        {!readOnly && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            {t("forwards.new")}
          </Button>
        )}
      </ToolbarBand>
      {!loaded ? (
        <LoadingState label={t("forwards.loading")} />
      ) : error ? (
        <NoticePanel tone="destructive" title={t("cluster.error")}>
          {error}
        </NoticePanel>
      ) : (
        <DataView<ForwardRow>
          items={visible}
          view="list"
          getKey={(row) => row.id}
          columns={{ base: 1 }}
          listColumns={columns}
          empty={<EmptyState icon={Inbox} title={t("forwards.empty")} />}
          renderCard={() => null}
        />
      )}
      {adding && (
        <ForwardForm
          initial={{}}
          onClose={() => setAdding(false)}
          onStarted={() => void load()}
        />
      )}
    </>
  );
}
