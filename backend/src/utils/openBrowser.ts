import { spawn } from 'child_process';
import { createLogger, errorMessage } from './logger.js';

const log = createLogger('Browser');

/**
 * Opens a URL in the default browser. Failing is not fatal: the URL is logged so it can be opened by hand.
 */
export function openBrowser(url: string): void {
    const [command, args] =
        process.platform === 'win32'
            ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
            : process.platform === 'darwin'
              ? ['open', [url]]
              : ['xdg-open', [url]];

    const fail = (reason: string) => log.warn(`Could not open the browser (${reason}). Open ${url} by hand.`);
    try {
        const child = spawn(command, args, { detached: true, stdio: 'ignore' });
        child.on('error', (error) => fail(errorMessage(error)));
        child.unref();
    } catch (error) {
        fail(errorMessage(error));
    }
}
