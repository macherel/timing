import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * openapi.yaml documents the API: it must list exactly the routes of src/routes/api.ts, and be consistent.
 */
const METHODS = ['get', 'put', 'post', 'patch', 'delete'];
const file = path.resolve(import.meta.dirname, '../openapi.yaml');

let spec: any;
let routes: string[];

beforeAll(async () => {
    const document = yaml.parseDocument(fs.readFileSync(file, 'utf8'));
    expect(document.errors.map((error) => error.message)).toEqual([]);
    spec = document.toJS();

    // The simulated gates are only registered with this variable: document them too
    process.env.TIMING_SIMULATE_GATES = '1';
    const { default: router } = await import('../src/routes/api.js');
    delete process.env.TIMING_SIMULATE_GATES;
    routes = router.stack
        .filter((layer: any) => layer.route)
        .flatMap((layer: any) =>
            Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route.path.replace(/:(\w+)/g, '{$1}')}`),
        );
});

const documented = () =>
    Object.entries(spec.paths).flatMap(([route, item]: [string, any]) =>
        Object.keys(item)
            .filter((key) => METHODS.includes(key))
            .map((method) => `${method.toUpperCase()} ${route}`),
    );

/** Every $ref of the document, with where it is. */
function refs(node: unknown, where = ''): [string, string][] {
    if (Array.isArray(node)) return node.flatMap((item, index) => refs(item, `${where}[${index}]`));
    if (!node || typeof node !== 'object') return [];
    return Object.entries(node).flatMap(([key, value]) =>
        key === '$ref' ? [[where, value as string]] : refs(value, `${where}.${key}`),
    );
}

describe('openapi.yaml', () => {
    it('documents every route of the API, and only those', () => {
        expect(documented().sort()).toEqual([...routes].sort());
    });

    it('is an OpenAPI 3.1 document', () => {
        expect(spec.openapi).toBe('3.1.0');
        expect(spec.info.title).toBeTruthy();
    });

    it('only refers to components that exist', () => {
        const missing = refs(spec)
            .filter(([, ref]) => !ref.startsWith('#/') || ref.slice(2).split('/').reduce((node: any, part) => node?.[part], spec) === undefined)
            .map(([where, ref]) => `${where}: ${ref}`);
        expect(missing).toEqual([]);
    });

    it('gives each operation a unique id, a summary, a tag and responses', () => {
        const operations = Object.values(spec.paths).flatMap((item: any) => METHODS.filter((method) => item[method]).map((method) => item[method]));
        const ids = operations.map((operation) => operation.operationId);
        expect(new Set(ids).size).toBe(ids.length);
        for (const operation of operations) {
            expect(operation.summary, operation.operationId).toBeTruthy();
            expect(operation.tags?.length, operation.operationId).toBeGreaterThan(0);
            expect(Object.keys(operation.responses ?? {}).length, operation.operationId).toBeGreaterThan(0);
        }
        const tags = new Set(spec.tags.map((tag: any) => tag.name));
        expect(operations.flatMap((operation) => operation.tags).filter((tag) => !tags.has(tag))).toEqual([]);
    });

    it('declares the parameters of each path', () => {
        const resolve = (parameter: any) =>
            parameter.$ref ? parameter.$ref.slice(2).split('/').reduce((node: any, part: string) => node[part], spec) : parameter;
        for (const [route, item] of Object.entries(spec.paths) as [string, any][]) {
            const inPath = [...route.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
            const declared = (item.parameters ?? []).map(resolve).filter((p: any) => p.in === 'path').map((p: any) => p.name);
            expect(declared.sort(), route).toEqual(inPath.sort());
        }
    });
});
