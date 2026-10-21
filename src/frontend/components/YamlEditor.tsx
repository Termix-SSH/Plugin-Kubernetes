import React from "react";
import { CheckCircle2, FileDiff, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button, cn } from "@termix-ssh/plugin-sdk/ui";
import { useCluster } from "../cluster-context";
import { getErrorMessage } from "../error-message";
import { useKubernetesApi } from "../kubernetes-api";

type Result =
  | { kind: "check"; resources: string[] }
  | { kind: "diff"; diff: string }
  | { kind: "error"; message: string };

interface YamlEditorProps {
  initial: string;
  /** replace refuses a stale copy, so it suits editing what is there. */
  mode: "apply" | "replace";
  namespace?: string;
  onSaved?: (resources: string[]) => void;
  /** Reload the resource's YAML after a save or a reset. */
  onReload?: () => void;
  saveLabel?: string;
}

function diffLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "text-green-500";
  if (line.startsWith("-") && !line.startsWith("---"))
    return "text-destructive";
  if (line.startsWith("@@")) return "text-accent-brand";
  return "text-muted-foreground";
}

export function YamlEditor({
  initial,
  mode,
  namespace,
  onSaved,
  onReload,
  saveLabel,
}: YamlEditorProps) {
  const { t } = useTranslation();
  const kube = useKubernetesApi();
  const { sessionId, context, readOnly } = useCluster();
  const [text, setText] = React.useState(initial);
  const [busy, setBusy] = React.useState<"check" | "diff" | "save" | null>(
    null,
  );
  const [result, setResult] = React.useState<Result | null>(null);
  const dirty = text !== initial;

  React.useEffect(() => {
    setText(initial);
    setResult(null);
  }, [initial]);

  const body = () => ({ yaml: text, mode, namespace, context });

  const check = async () => {
    setBusy("check");
    try {
      const out = await kube.checkManifest(sessionId, body());
      setResult({ kind: "check", resources: out.resources });
    } catch (error) {
      setResult({ kind: "error", message: getErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const diff = async () => {
    setBusy("diff");
    try {
      const out = await kube.diffManifest(sessionId, body());
      setResult({ kind: "diff", diff: out.diff });
    } catch (error) {
      setResult({ kind: "error", message: getErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (readOnly || !text.trim()) return;
    setBusy("save");
    try {
      const out = await kube.applyManifest(sessionId, body());
      toast.success(t("yaml.saved", { count: out.resources.length }));
      setResult({ kind: "check", resources: out.resources });
      onSaved?.(out.resources);
    } catch (error) {
      setResult({ kind: "error", message: getErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const saveRef = React.useRef(save);
  saveRef.current = save;

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void saveRef.current();
      return;
    }
    if (event.key === "Tab" && !event.shiftKey) {
      // Two spaces, so tabs don't break the YAML.
      event.preventDefault();
      const el = event.currentTarget;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const next = `${text.slice(0, start)}  ${text.slice(end)}`;
      setText(next);
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + 2;
      });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {dirty && (
          <span className="text-xs text-warning">{t("yaml.unsaved")}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {onReload && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onReload}
              disabled={busy !== null}
            >
              <RotateCcw />
              {t("yaml.reload")}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void check()}
            disabled={busy !== null || !text.trim()}
          >
            <CheckCircle2 className={cn(busy === "check" && "animate-pulse")} />
            {t("yaml.check")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void diff()}
            disabled={busy !== null || !text.trim()}
          >
            <FileDiff className={cn(busy === "diff" && "animate-pulse")} />
            {t("yaml.diff")}
          </Button>
          {!readOnly && (
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={busy !== null || !text.trim()}
            >
              <Save className={cn(busy === "save" && "animate-pulse")} />
              {saveLabel ?? t("yaml.save")}
            </Button>
          )}
        </div>
      </div>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
        aria-label={t("yaml.editor")}
        className="min-h-48 flex-1 resize-none border border-border bg-background p-3 font-mono text-xs leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      {result && (
        <div className="max-h-56 overflow-auto border border-border bg-card p-3 font-mono text-xs">
          {result.kind === "error" && (
            <pre className="whitespace-pre-wrap text-destructive">
              {result.message}
            </pre>
          )}
          {result.kind === "check" && (
            <>
              <div className="mb-1 font-sans text-green-500">
                {t("yaml.valid")}
              </div>
              {result.resources.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </>
          )}
          {result.kind === "diff" &&
            (result.diff.trim() ? (
              result.diff.split("\n").map((line, index) => (
                <div
                  key={index}
                  className={cn("whitespace-pre", diffLineClass(line))}
                >
                  {line}
                </div>
              ))
            ) : (
              <span className="font-sans text-muted-foreground">
                {t("yaml.noChanges")}
              </span>
            ))}
        </div>
      )}
    </div>
  );
}
