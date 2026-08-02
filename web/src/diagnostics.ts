export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type DiagnosticDomain = 'app' | 'config' | 'socket' | 'call' | 'webrtc' | 'media' | 'tts' | 'note' | 'update' | 'storage';
export type DiagnosticRecoverability = 'automatic' | 'retryable' | 'user_action' | 'fatal';

export type RendererDiagnosticInput = {
  event: `${DiagnosticDomain}.${string}`;
  domain: DiagnosticDomain;
  level?: DiagnosticLevel;
  errorCode?: string;
  recoverability?: DiagnosticRecoverability;
  correlation?: Record<string, unknown>;
  context?: Record<string, unknown>;
  exception?: {
    name?: string;
    message: string;
    stack?: string;
    cause?: unknown;
  };
};

type DiagnosticBridgeWindow = Window & {
  desktopPetControl?: {
    recordDiagnostic?: (event: RendererDiagnosticInput) => void;
  };
};

export function normalizeDiagnosticError(value: unknown): RendererDiagnosticInput['exception'] {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: (value as Error & { cause?: unknown }).cause,
    };
  }
  if (typeof value === 'string') return { message: value };
  try { return { message: JSON.stringify(value) }; }
  catch { return { message: String(value) }; }
}

export function recordControlDiagnostic(input: RendererDiagnosticInput) {
  try {
    (window as DiagnosticBridgeWindow).desktopPetControl?.recordDiagnostic?.(input);
  } catch {
    // Diagnostics must never interrupt the product path.
  }
}

export function installControlGlobalDiagnostics() {
  const onError = (event: ErrorEvent) => {
    recordControlDiagnostic({
      event: 'app.renderer-error',
      domain: 'app',
      level: 'error',
      errorCode: 'app_control_renderer_error',
      recoverability: 'retryable',
      context: {
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
      },
      exception: normalizeDiagnosticError(event.error || event.message),
    });
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    recordControlDiagnostic({
      event: 'app.renderer-unhandled-rejection',
      domain: 'app',
      level: 'error',
      errorCode: 'app_control_unhandled_rejection',
      recoverability: 'retryable',
      exception: normalizeDiagnosticError(event.reason),
    });
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
  };
}
