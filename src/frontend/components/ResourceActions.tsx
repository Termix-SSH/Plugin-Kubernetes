import React from "react";
import {
  Ban,
  CirclePlay,
  FileText,
  ImageUp,
  Pause,
  Play,
  RotateCw,
  Scaling,
  ShieldOff,
  Terminal,
  Trash2,
  Unlock,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  FormFooter,
  InlineView,
  NumberField,
  SelectField,
  SwitchRow,
  TextField,
  cn,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";
import { useCluster } from "../cluster-context";
import { getErrorMessage } from "../error-message";
import { supports } from "../kinds";
import { useKubernetesApi } from "../kubernetes-api";
import type { ResourceAction, ResourceSummary } from "../types";

type FormKind = "scale" | "setImage" | "drain";

interface ResourceActionsProps {
  row: ResourceSummary;
  onChanged: () => void;
  /** Called after the resource itself was deleted. */
  onDeleted?: () => void;
  size?: "row" | "header";
}

export function ResourceActions({
  row,
  onChanged,
  onDeleted,
  size = "header",
}: ResourceActionsProps) {
  const { t } = useTranslation();
  const kube = useKubernetesApi();
  const confirm = useConfirm();
  const { sessionId, context, readOnly, open } = useCluster();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<FormKind | null>(null);
  const ref = { kind: row.kind, name: row.name, namespace: row.namespace };
  const kindLabel = t(`kinds.${row.kind}.one`);

  const run = async (
    id: string,
    work: () => Promise<unknown>,
    done: string,
  ): Promise<boolean> => {
    setBusy(id);
    try {
      await work();
      toast.success(done);
      onChanged();
      return true;
    } catch (error) {
      toast.error(getErrorMessage(error));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const action = (
    name: ResourceAction,
    options: Record<string, unknown> = {},
  ) =>
    run(
      name,
      () => kube.action(sessionId, ref, name, options, context),
      t(`actions.${name}.done`, { name: row.name }),
    );

  const confirmed = async (name: ResourceAction, destructive = false) => {
    const ok = await confirm({
      title: t(`actions.${name}.confirmTitle`, { name: row.name }),
      description: t(`actions.${name}.confirmText`, { kind: kindLabel }),
      confirmLabel: t(`actions.${name}.label`),
      destructive,
    });
    if (ok) await action(name);
  };

  const remove = async () => {
    const ok = await confirm({
      title: t("actions.delete.confirmTitle", { name: row.name }),
      description:
        row.kind === "namespaces"
          ? t("actions.delete.namespaceText")
          : row.kind === "pods" && row.fields.owner
            ? t("actions.delete.managedPodText")
            : t("actions.delete.confirmText", { kind: kindLabel }),
      confirmLabel: t("actions.delete.label"),
    });
    if (!ok) return;
    const deleted = await run(
      "delete",
      () => kube.remove(sessionId, ref, context),
      t("actions.delete.done", { name: row.name }),
    );
    if (deleted) onDeleted?.();
  };

  const buttons: {
    id: string;
    icon: React.ReactNode;
    label: string;
    onClick: () => void;
    write?: boolean;
    danger?: boolean;
  }[] = [];

  if (row.kind === "pods") {
    buttons.push({
      id: "logs",
      icon: <FileText />,
      label: t("actions.logs"),
      onClick: () => open(ref, "logs"),
    });
    if (row.status === "Running" && !readOnly) {
      buttons.push({
        id: "console",
        icon: <Terminal />,
        label: t("actions.console"),
        onClick: () => open(ref, "console"),
      });
    }
  }
  if (supports(row.kind, "scale")) {
    buttons.push({
      id: "scale",
      icon: <Scaling />,
      label: t("actions.scale.label"),
      onClick: () => setForm("scale"),
      write: true,
    });
  }
  if (supports(row.kind, "restart")) {
    buttons.push({
      id: "restart",
      icon: <RotateCw />,
      label: t("actions.restart.label"),
      onClick: () => void confirmed("restart"),
      write: true,
    });
  }
  if (supports(row.kind, "setImage") && (row.containers?.length ?? 0) > 0) {
    buttons.push({
      id: "setImage",
      icon: <ImageUp />,
      label: t("actions.setImage.label"),
      onClick: () => setForm("setImage"),
      write: true,
    });
  }
  if (supports(row.kind, "trigger")) {
    buttons.push({
      id: "trigger",
      icon: <CirclePlay />,
      label: t("actions.trigger.label"),
      onClick: () => void action("trigger"),
      write: true,
    });
  }
  if (supports(row.kind, "suspend")) {
    buttons.push(
      row.suspended
        ? {
            id: "resume",
            icon: <Play />,
            label: t("actions.resume.label"),
            onClick: () => void action("resume"),
            write: true,
          }
        : {
            id: "suspend",
            icon: <Pause />,
            label: t("actions.suspend.label"),
            onClick: () => void confirmed("suspend"),
            write: true,
          },
    );
  }
  if (row.kind === "nodes") {
    buttons.push(
      row.unschedulable
        ? {
            id: "uncordon",
            icon: <Unlock />,
            label: t("actions.uncordon.label"),
            onClick: () => void action("uncordon"),
            write: true,
          }
        : {
            id: "cordon",
            icon: <Ban />,
            label: t("actions.cordon.label"),
            onClick: () => void confirmed("cordon"),
            write: true,
          },
      {
        id: "drain",
        icon: <ShieldOff />,
        label: t("actions.drain.label"),
        onClick: () => setForm("drain"),
        write: true,
        danger: true,
      },
    );
  }
  if (row.kind !== "events" && row.kind !== "nodes") {
    buttons.push({
      id: "delete",
      icon: <Trash2 />,
      label: t("actions.delete.label"),
      onClick: () => void remove(),
      write: true,
      danger: true,
    });
  }

  const visible = buttons.filter((button) => !(button.write && readOnly));
  if (visible.length === 0) return null;

  return (
    <>
      <div className="flex items-center">
        {visible.map((button) => (
          <Button
            key={button.id}
            variant="ghost"
            size="icon"
            title={button.label}
            aria-label={button.label}
            disabled={busy !== null}
            onClick={button.onClick}
            className={cn(
              size === "row" ? "size-7 [&_svg]:size-3.5" : "[&_svg]:size-4",
              button.danger
                ? "text-muted-foreground hover:text-destructive"
                : "text-muted-foreground hover:text-foreground",
              busy === button.id && "animate-pulse",
            )}
          >
            {button.icon}
          </Button>
        ))}
      </div>
      {form && (
        <ActionForm
          form={form}
          row={row}
          onClose={() => setForm(null)}
          onSubmit={async (options) => {
            if (await action(form, options)) setForm(null);
          }}
          busy={busy !== null}
        />
      )}
    </>
  );
}

function ActionForm({
  form,
  row,
  busy,
  onClose,
  onSubmit,
}: {
  form: FormKind;
  row: ResourceSummary;
  busy: boolean;
  onClose: () => void;
  onSubmit: (options: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const containers = row.containers ?? [];
  const [replicas, setReplicas] = React.useState(row.replicas ?? 1);
  const [container, setContainer] = React.useState(containers[0] ?? "");
  const [image, setImage] = React.useState(row.images?.[0] ?? "");
  const [emptyDir, setEmptyDir] = React.useState(false);
  const [force, setForce] = React.useState(false);

  React.useEffect(() => {
    const index = containers.indexOf(container);
    if (index >= 0) setImage(row.images?.[index] ?? "");
    // Only when the picked container changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container]);

  const submit = () => {
    if (form === "scale") return onSubmit({ replicas });
    if (form === "setImage")
      return onSubmit({ container, image: image.trim() });
    return onSubmit({ deleteEmptyDirData: emptyDir, force });
  };

  return (
    <InlineView
      open
      onOpenChange={(next) => !next && onClose()}
      title={t(`actions.${form}.title`, { name: row.name })}
      footer={
        <FormFooter
          onCancel={onClose}
          onSave={() => void submit()}
          saveLabel={t(`actions.${form}.label`)}
          saving={busy}
          disabled={form === "setImage" && !image.trim()}
        />
      }
    >
      {form === "scale" && (
        <NumberField
          label={t("actions.scale.replicas")}
          value={replicas}
          onChange={setReplicas}
          min={0}
          max={1000}
          hint={t("actions.scale.hint", { current: row.replicas ?? 0 })}
        />
      )}
      {form === "setImage" && (
        <>
          {containers.length > 1 && (
            <SelectField
              label={t("logs.container")}
              value={container}
              onChange={setContainer}
              options={containers.map((name) => ({ value: name, label: name }))}
            />
          )}
          <TextField
            label={t("actions.setImage.image")}
            value={image}
            onChange={setImage}
            placeholder="nginx:1.27"
            hint={t("actions.setImage.hint")}
            mono
          />
        </>
      )}
      {form === "drain" && (
        <>
          <p className="text-sm text-muted-foreground">
            {t("actions.drain.text", { name: row.name })}
          </p>
          <SwitchRow
            label={t("actions.drain.emptyDir")}
            description={t("actions.drain.emptyDirHint")}
            checked={emptyDir}
            onChange={setEmptyDir}
          />
          <SwitchRow
            label={t("actions.drain.force")}
            description={t("actions.drain.forceHint")}
            checked={force}
            onChange={setForce}
          />
        </>
      )}
    </InlineView>
  );
}
