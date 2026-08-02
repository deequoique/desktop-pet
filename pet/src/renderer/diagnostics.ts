export type RendererDiagnosticInput = {
  event: `${'app' | 'config' | 'socket' | 'call' | 'webrtc' | 'media' | 'tts' | 'note' | 'update' | 'storage'}.${string}`;
  domain: 'app' | 'config' | 'socket' | 'call' | 'webrtc' | 'media' | 'tts' | 'note' | 'update' | 'storage';
  level?: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  errorCode?: string;
  recoverability?: 'automatic' | 'retryable' | 'user_action' | 'fatal';
  correlation?: Record<string, unknown>;
  context?: Record<string, unknown>;
  exception?: { name?: string; message: string; stack?: string; cause?: unknown };
};

type PetDiagnosticWindow = Window & {
  pet?: {
    recordDiagnostic?: (event: RendererDiagnosticInput) => void;
  };
};

export function normalizeDiagnosticError(value: unknown): NonNullable<RendererDiagnosticInput['exception']> {
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

export function recordPetDiagnostic(input: RendererDiagnosticInput) {
  try {
    (window as PetDiagnosticWindow).pet?.recordDiagnostic?.(input);
  } catch {
    // Diagnostics must never interrupt the product path.
  }
}

export function installPetGlobalDiagnostics() {
  const onError = (event: ErrorEvent) => {
    recordPetDiagnostic({
      event: 'app.renderer-error',
      domain: 'app',
      level: 'error',
      errorCode: 'app_pet_renderer_error',
      recoverability: 'retryable',
      context: { filename: event.filename, line: event.lineno, column: event.colno },
      exception: normalizeDiagnosticError(event.error || event.message),
    });
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    recordPetDiagnostic({
      event: 'app.renderer-unhandled-rejection',
      domain: 'app',
      level: 'error',
      errorCode: 'app_pet_unhandled_rejection',
      recoverability: 'retryable',
      exception: normalizeDiagnosticError(event.reason),
    });
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
}
