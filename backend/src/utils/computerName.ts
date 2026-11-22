import os from 'os';

/**
 * The name of this computer: the sync name of config.yaml when sync is on, the host name otherwise. It is written
 * with each result, beside its line, so a line is told apart from the line of the same name on another computer.
 */
let syncName: string | null = null;

export function computerName(): string {
    return syncName ?? os.hostname();
}

/** Set by the sync service each time it reads config.yaml. */
export function setSyncName(name: string | null): void {
    syncName = name;
}
