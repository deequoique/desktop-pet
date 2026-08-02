export function normalizeDiagnosticError(value) {
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: value.stack,
            cause: value.cause,
        };
    }
    if (typeof value === 'string')
        return { message: value };
    try {
        return { message: JSON.stringify(value) };
    }
    catch {
        return { message: String(value) };
    }
}
export function recordControlDiagnostic(input) {
    try {
        window.desktopPetControl?.recordDiagnostic?.(input);
    }
    catch {
        // Diagnostics must never interrupt the product path.
    }
}
export function installControlGlobalDiagnostics() {
    const onError = (event) => {
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
    const onUnhandledRejection = (event) => {
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
