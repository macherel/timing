import crypto from 'crypto';
import fs from 'fs';
import yaml from 'yaml';
import { CONFIG_PATH } from './hardware/deviceConfig.js';

/**
 * The administration lock: when config.yaml has an `adminPassword`, the pages hide the administration pages and the
 * discipline settings until the password is typed. It keeps casual users away from the settings, it is not a
 * security barrier (the API itself stays open, like the rest of the app on the local network).
 *
 * Typing the password gives the page a token, kept by the browser. The token is a hash of the password with a secret
 * drawn when the server starts: changing the password, or restarting the app, locks every browser again.
 */

const secret = crypto.randomBytes(32);

const tokenFor = (password: string) => crypto.createHmac('sha256', secret).update(password).digest('hex');

/**
 * The password of config.yaml, or undefined when there is none. Read from the file each time, so a change applies at
 * once; an invalid file still keeps its password, so a typo elsewhere does not unlock the pages.
 */
export function adminPassword(): string | undefined {
    try {
        const password = yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))?.adminPassword;
        if (typeof password === 'number') return String(password);
        return typeof password === 'string' && password !== '' ? password : undefined;
    } catch {
        return undefined;
    }
}

function sameText(a: string, b: string): boolean {
    const [hashA, hashB] = [a, b].map((text) => crypto.createHash('sha256').update(text).digest());
    return crypto.timingSafeEqual(hashA, hashB);
}

/** Whether a password is set, and whether `token` (from unlock) unlocks it. Always unlocked without password. */
export function lockState(token: unknown): { protected: boolean; unlocked: boolean } {
    const password = adminPassword();
    if (password === undefined) return { protected: false, unlocked: true };
    return { protected: true, unlocked: typeof token === 'string' && sameText(token, tokenFor(password)) };
}

/** The token for the password typed, or null when it is wrong (or no password is set). */
export function unlock(password: unknown): string | null {
    const expected = adminPassword();
    if (expected === undefined || typeof password !== 'string' || !sameText(password, expected)) return null;
    return tokenFor(expected);
}
