/* eslint-disable react-hooks/exhaustive-deps */
import React from "react";
import {
  useConnectionRetry,
  useHost,
  useTranslation,
  logActivity,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  ConnectionLogProvider,
  ConnectionScreen,
  SSHAuthDialog,
  TOTPDialog,
  BrowserSignInDialog,
  useConnectionLog,
  useTabsSafe,
} from "@termix-ssh/plugin-sdk/ui";
import {
  KubeApiError,
  useKubernetesApi,
  type ConnectResult,
} from "./kubernetes-api";
import {
  kubernetesEnabled,
  hostTitle,
  toKubeHost,
  type KubeHost,
  type KubeValidation,
} from "./types";
import { ClusterView } from "./ClusterView";

interface KubernetesManagerProps {
  host?: KubeHost;
  title?: string;
  isVisible?: boolean;
  isTopbarOpen?: boolean;
  embedded?: boolean;
  /** Narrow side panel: one column list and a short toolbar. */
  compact?: boolean;
  onClose?: () => void;
}

interface PromptState {
  kind: "totp" | "browser";
  sessionId: string;
  prompt?: string;
  isPassword?: boolean;
  url?: string;
  code?: string;
  label?: string;
}

function newSessionId(): string {
  return `kubernetes-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function KubernetesManagerInner({
  host,
  title,
  isVisible = true,
  isTopbarOpen = true,
  embedded = false,
  compact = false,
  onClose,
}: KubernetesManagerProps): React.ReactElement {
  const { t } = useTranslation();
  const kube = useKubernetesApi();
  const { addLog, setLogs, clearLogs } = useConnectionLog();
  const { currentTab, removeTab } = useTabsSafe();
  // The shell's host list keeps the host current after an edit; a
  // standalone window has no shell, so it keeps the host it was given.
  const liveRecord = useHost(host?.id);
  const currentHost = React.useMemo(
    () => (liveRecord ? toKubeHost(liveRecord) : host),
    [liveRecord, host],
  );
  const enabled = kubernetesEnabled(currentHost);

  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [isConnecting, setIsConnecting] = React.useState(false);
  const [validation, setKubeValidation] = React.useState<KubeValidation | null>(
    null,
  );
  const [isValidating, setIsValidating] = React.useState(false);
  const [prompt, setPrompt] = React.useState<PromptState | null>(null);
  const [showAuthDialog, setShowAuthDialog] = React.useState(false);
  const [authReason, setAuthReason] = React.useState<
    "no_keyboard" | "auth_failed" | "timeout"
  >("no_keyboard");
  const [retryCount, setRetryCount] = React.useState(0);

  const activityLoggedRef = React.useRef(false);

  const logKubeActivity = () => {
    if (!currentHost?.id || activityLoggedRef.current) return;
    activityLoggedRef.current = true;
    logActivity("kubernetes", currentHost.id, hostTitle(currentHost)).catch(
      () => {
        activityLoggedRef.current = false;
      },
    );
  };

  React.useEffect(() => {
    setSessionId(null);
    setKubeValidation(null);
  }, [host?.id]);

  const retryRef = React.useRef<ReturnType<typeof useConnectionRetry> | null>(
    null,
  );

  const validate = async (sid: string, clearAfter: boolean) => {
    setSessionId(sid);
    setIsValidating(true);
    try {
      const validation = await kube.validate(sid);
      setKubeValidation(validation);
      if (!validation.available) {
        addLog({
          type: "error",
          stage: "validation",
          message: validation.error || t("kube.error"),
          details: validation.code
            ? t("kube.errorCode", { code: validation.code })
            : undefined,
        });
        retryRef.current?.markFailed();
      } else {
        logKubeActivity();
        if (clearAfter) setTimeout(() => clearLogs(), 1000);
        retryRef.current?.markConnected();
      }
    } finally {
      setIsValidating(false);
    }
  };

  /** Acts on one step of a connect, whichever request it answered. */
  const applyConnectResult = async (
    sid: string,
    result: ConnectResult,
    clearAfter: boolean,
  ) => {
    if (result.connectionLogs) setLogs(result.connectionLogs);

    if (result.requires_browser_sign_in) {
      setPrompt({
        kind: "browser",
        sessionId: sid,
        url: result.url || "",
        code: result.code || "",
        label: result.label || "",
      });
      return;
    }
    if (result.requires_totp) {
      if (result.retry) {
        addLog({
          type: "error",
          stage: "auth",
          message: t("kube.totpVerificationFailed"),
        });
      }
      setPrompt({
        kind: "totp",
        sessionId: sid,
        prompt: result.prompt || t("kube.verificationCodePrompt"),
        isPassword: result.isPassword,
      });
      return;
    }
    if (result.status === "auth_required") {
      setAuthReason(
        result.reason === "no_keyboard" ? "no_keyboard" : "auth_failed",
      );
      setShowAuthDialog(true);
      return;
    }
    setPrompt(null);
    await validate(sid, clearAfter);
  };

  const reportFailure = (error: unknown, fallback: string) => {
    if (error instanceof KubeApiError && error.connectionLogs?.length) {
      setLogs(error.connectionLogs);
    } else {
      addLog({
        type: "error",
        stage: "connection",
        message: error instanceof Error ? error.message : fallback,
      });
    }
    retryRef.current?.markFailed();
  };

  const connect = async (credentials?: {
    userProvidedPassword?: string;
    userProvidedSshKey?: string;
    userProvidedKeyPassword?: string;
  }) => {
    if (!currentHost?.id) return;
    const sid = newSessionId();
    setIsConnecting(true);
    try {
      const result = await kube.connect(sid, currentHost.id, credentials);
      await applyConnectResult(sid, result, !credentials);
    } catch (error) {
      reportFailure(error, t("kube.connectionFailed"));
    } finally {
      setIsConnecting(false);
    }
  };

  const initializingRef = React.useRef(false);

  React.useEffect(() => {
    if (!currentHost?.id || !enabled) return;
    if (initializingRef.current || sessionId) return;
    initializingRef.current = true;
    clearLogs();
    // Cleared only when the connect settles, so a second run of this effect
    // cannot start another session and leave polling on the dropped one.
    void connect().finally(() => {
      initializingRef.current = false;
    });
  }, [currentHost?.id, enabled, retryCount]);

  React.useEffect(() => {
    if (!sessionId) return;
    return () => {
      kube.disconnect(sessionId).catch(() => {});
    };
  }, [sessionId]);

  React.useEffect(() => {
    if (!sessionId || !isVisible) return;
    const keepalive = setInterval(
      () => {
        kube.keepalive(sessionId).catch(() => {});
      },
      10 * 60 * 1000,
    );
    return () => clearInterval(keepalive);
  }, [sessionId, isVisible]);

  const closeTab = () => {
    // In a side panel the current tab is the terminal, which stays open.
    if (compact) onClose?.();
    else if (currentTab !== null) removeTab(currentTab);
  };

  const handleTotpSubmit = async (code: string) => {
    if (!prompt || prompt.kind !== "totp" || !code) return;
    const sid = prompt.sessionId;
    setPrompt(null);
    setIsConnecting(true);
    try {
      await applyConnectResult(sid, await kube.answerTotp(sid, code), false);
    } catch (error) {
      reportFailure(error, t("kube.totpVerificationFailed"));
    } finally {
      setIsConnecting(false);
    }
  };

  const handleBrowserSignInContinue = async () => {
    if (!prompt || prompt.kind !== "browser") return;
    const sid = prompt.sessionId;
    setPrompt(null);
    setIsConnecting(true);
    try {
      await applyConnectResult(
        sid,
        await kube.continueBrowserSignIn(sid),
        false,
      );
    } catch (error) {
      reportFailure(error, t("kube.browserSignInFailed"));
    } finally {
      setIsConnecting(false);
    }
  };

  const handlePromptCancel = () => {
    const sid = prompt?.sessionId;
    setPrompt(null);
    setIsConnecting(false);
    if (sid) kube.disconnect(sid).catch(() => {});
    closeTab();
  };

  const handleBrowserSignInOpenUrl = () => {
    if (prompt?.url) window.open(prompt.url, "_blank", "noopener,noreferrer");
  };

  const handleAuthSubmit = async (credentials: {
    password?: string;
    sshKey?: string;
    keyPassword?: string;
  }) => {
    setShowAuthDialog(false);
    await connect({
      userProvidedPassword: credentials.password,
      userProvidedSshKey: credentials.sshKey,
      userProvidedKeyPassword: credentials.keyPassword,
    });
  };

  const handleAuthCancel = () => {
    setShowAuthDialog(false);
    setIsConnecting(false);
    onClose?.();
  };

  const handleRetry = () => {
    initializingRef.current = false;
    setSessionId(null);
    setKubeValidation(null);
    clearLogs();
    setRetryCount((c) => c + 1);
  };

  const kubeConnectRetry = useConnectionRetry({
    connect: () => {
      handleRetry();
    },
    enabled: enabled && !prompt && !showAuthDialog,
    autoStart: false,
  });
  retryRef.current = kubeConnectRetry;

  const topMarginPx = isTopbarOpen ? 74 : 16;
  const leftMarginPx = 8;
  const bottomMarginPx = 8;

  const wrapperStyle: React.CSSProperties = embedded
    ? { opacity: isVisible ? 1 : 0, height: "100%", width: "100%" }
    : {
        opacity: isVisible ? 1 : 0,
        marginLeft: leftMarginPx,
        marginRight: 17,
        marginTop: topMarginPx,
        marginBottom: bottomMarginPx,
        height: `calc(100vh - ${topMarginPx + bottomMarginPx}px)`,
      };

  const containerClass = embedded
    ? "h-full w-full text-foreground overflow-hidden bg-transparent"
    : "bg-canvas text-foreground border-2 border-edge overflow-hidden";

  if (!enabled) {
    return (
      <div style={wrapperStyle} className={`${containerClass} relative`}>
        <ConnectionScreen
          status="error"
          message={title}
          unavailable={{
            title: t("kube.notEnabled"),
            hint: t("kube.notEnabledHint"),
          }}
        />
      </div>
    );
  }

  const dialogs = (
    <>
      <TOTPDialog
        isOpen={prompt?.kind === "totp"}
        prompt={prompt?.prompt ?? ""}
        mode={prompt?.isPassword ? "password" : "totp"}
        onSubmit={handleTotpSubmit}
        onCancel={handlePromptCancel}
      />
      <BrowserSignInDialog
        isOpen={prompt?.kind === "browser"}
        label={prompt?.label ?? ""}
        url={prompt?.url ?? ""}
        code={prompt?.code ?? ""}
        onContinue={handleBrowserSignInContinue}
        onCancel={handlePromptCancel}
        onOpenUrl={handleBrowserSignInOpenUrl}
      />
      {currentHost && (
        <SSHAuthDialog
          isOpen={showAuthDialog}
          reason={authReason}
          onSubmit={handleAuthSubmit}
          onCancel={handleAuthCancel}
          hostInfo={{
            ip: currentHost.ip,
            port: currentHost.port,
            username: currentHost.username ?? "",
            name: currentHost.name,
          }}
        />
      )}
    </>
  );

  const hostDetail = currentHost
    ? `${currentHost.username ? currentHost.username + "@" : ""}${currentHost.ip}:${currentHost.port}`
    : undefined;

  if (isConnecting || isValidating) {
    return (
      <div style={wrapperStyle} className={`${containerClass} relative`}>
        <ConnectionScreen
          status={kubeConnectRetry.status}
          message={isValidating ? t("kube.validating") : t("kube.connecting")}
          detail={hostDetail}
          attempt={kubeConnectRetry.attempt}
          maxAttempts={kubeConnectRetry.maxAttempts}
          nextRetryInMs={kubeConnectRetry.nextRetryInMs}
          onManualRetry={kubeConnectRetry.retryNow}
        />
        {dialogs}
      </div>
    );
  }

  if (validation && !validation.available) {
    return (
      <div style={wrapperStyle} className={`${containerClass} relative`}>
        <ConnectionScreen
          status={kubeConnectRetry.status}
          message={t("kube.connecting")}
          detail={hostDetail}
          errorDetail={validation.error || t("kube.error")}
          attempt={kubeConnectRetry.attempt}
          maxAttempts={kubeConnectRetry.maxAttempts}
          nextRetryInMs={kubeConnectRetry.nextRetryInMs}
          onManualRetry={kubeConnectRetry.retryNow}
          logPosition="top"
        />
      </div>
    );
  }

  return (
    <div style={wrapperStyle} className={`${containerClass} relative`}>
      <div className="h-full w-full flex flex-col flex-1 min-h-0 overflow-hidden">
        {sessionId && currentHost && validation?.available && (
          <ClusterView
            sessionId={sessionId}
            host={currentHost}
            validation={validation}
            title={title}
            compact={compact}
          />
        )}
      </div>
      {dialogs}
      <ConnectionScreen
        status={kubeConnectRetry.status}
        message={t("kube.connecting")}
        attempt={kubeConnectRetry.attempt}
        maxAttempts={kubeConnectRetry.maxAttempts}
        nextRetryInMs={kubeConnectRetry.nextRetryInMs}
        onManualRetry={kubeConnectRetry.retryNow}
        logPosition="top"
      />
    </div>
  );
}

export function KubernetesManager(
  props: KubernetesManagerProps,
): React.ReactElement {
  return (
    <ConnectionLogProvider>
      <KubernetesManagerInner {...props} />
    </ConnectionLogProvider>
  );
}
