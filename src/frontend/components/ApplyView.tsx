import { FilePlus2 } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { InlineView } from "@termix-ssh/plugin-sdk/ui";
import { YamlEditor } from "./YamlEditor";

export const MANIFEST_TEMPLATE = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello
spec:
  replicas: 1
  selector:
    matchLabels:
      app: hello
  template:
    metadata:
      labels:
        app: hello
    spec:
      containers:
        - name: hello
          image: nginx:1.27
          ports:
            - containerPort: 80
`;

interface ApplyViewProps {
  open: boolean;
  onClose: () => void;
  /** Applied to resources that name no namespace of their own. */
  namespace?: string;
  onApplied: () => void;
}

export function ApplyView({
  open,
  onClose,
  namespace,
  onApplied,
}: ApplyViewProps) {
  const { t } = useTranslation();
  return (
    <InlineView
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={t("apply.title")}
      icon={<FilePlus2 className="size-4" />}
      status={
        namespace
          ? t("apply.namespace", { namespace })
          : t("apply.defaultNamespace")
      }
      scroll={false}
    >
      <p className="text-xs text-muted-foreground">{t("apply.hint")}</p>
      <YamlEditor
        initial={MANIFEST_TEMPLATE}
        mode="apply"
        namespace={namespace}
        saveLabel={t("apply.apply")}
        onSaved={onApplied}
      />
    </InlineView>
  );
}
