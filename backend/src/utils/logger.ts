/**
 * Console logger that prefixes every line with a scope, e.g. "[Hardware] Device opened".
 */
export function createLogger(scope: string) {
    const prefix = `[${scope}]`;
    return {
        info: (...args: unknown[]) => console.log(prefix, ...args),
        warn: (...args: unknown[]) => console.warn(prefix, ...args),
        error: (...args: unknown[]) => console.error(prefix, ...args),
        debug: (...args: unknown[]) => console.debug(prefix, ...args),
    };
}

/**
 * Extracts a readable message from anything thrown.
 */
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
