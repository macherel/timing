import { EventEmitter } from 'events';

/**
 * Tells the sync service that files of a discipline were changed on this computer (a result saved, a status or the
 * settings changed), so peers can be asked to sync at once instead of at their next check.
 */
const emitter = new EventEmitter();

export function notifyLocalChange(event: string, discipline: string): void {
    emitter.emit('change', event, discipline);
}

export function onLocalChange(listener: (event: string, discipline: string) => void): void {
    emitter.on('change', listener);
}
