/**
 * Templates of the columns of the UDA export (see udaResults in runService.ts): each column has a title, written in
 * the header line, and a value, written in the line of each participant. Both are text with expressions between
 * braces, e.g. the value
 *
 *   {if status == "OK"}{minutes * 60 + seconds}.{pad(fraction, 2)}{else}{status}{end}
 *
 * - Text is written as it is; {{ and }} write a brace.
 * - {expression} writes its value.
 * - {if expression}…{elif expression}…{else}…{end} writes the text of the first true condition (elif and else are
 *   optional).
 * - Expressions: whole numbers, texts in quotes ("…" or '…', \ escapes a quote), variables, function calls, and the
 *   operators, from the lowest priority:  || · && · ! · == != < <= > >= · + - · * / % · unary -
 *   / is the whole division (rounded towards 0), % its remainder. + adds two numbers, else joins two texts. A text
 *   made of digits counts as a number. A condition is true unless it is false, 0 or an empty text.
 * - Functions: pad(x, n[, c]) (x on n characters, c or 0 added on the left), upper(x), lower(x), trim(x), len(x),
 *   left(x, n), right(x, n), min(a, b…), max(a, b…), abs(x), col("column") (the cell of that column of the
 *   participant file, its name compared without case, accents nor spaces).
 * No code is run: the template is parsed and evaluated here only.
 */

export type Value = number | string | boolean;

/** A mistake in a template, at a position (0-based, in the template text). */
export class TemplateError extends Error {
    constructor(
        message: string,
        readonly position: number | null = null
    ) {
        super(position === null ? message : `${message} (character ${position + 1})`);
    }
}

type Expr =
    | { kind: 'value'; value: Value }
    | { kind: 'var'; name: string; pos: number }
    | { kind: 'call'; name: string; args: Expr[]; pos: number }
    | { kind: 'unary'; op: '-' | '!'; operand: Expr; pos: number }
    | { kind: 'binary'; op: string; left: Expr; right: Expr; pos: number };

type Node =
    | { kind: 'text'; text: string }
    | { kind: 'expr'; expr: Expr }
    | { kind: 'if'; branches: { condition: Expr; body: Node[] }[]; otherwise: Node[] };

export interface Template {
    nodes: Node[];
}

/** What a template is evaluated with: its variables and the cells of the participant (col). */
export interface Scope {
    vars: Record<string, Value>;
    // A cell of the participant file, by column name (any case, accents and spaces)
    column?: (name: string) => string;
}

// Functions: their number of arguments (min, max; null: no maximum)
const FUNCTIONS: Record<string, [number, number | null]> = {
    pad: [2, 3],
    upper: [1, 1],
    lower: [1, 1],
    trim: [1, 1],
    len: [1, 1],
    left: [2, 2],
    right: [2, 2],
    min: [1, null],
    max: [1, null],
    abs: [1, 1],
    col: [1, 1],
};

const KEYWORDS = new Set(['true', 'false', 'if', 'elif', 'else', 'end']);

/**
 * Parses a template. Throws a TemplateError for a mistake: a brace not closed, an {if} without {end}, an expression
 * that cannot be read, or a variable or function not in `variables` / the functions above.
 */
export function parseTemplate(text: string, variables: ReadonlySet<string>): Template {
    if (/[\r\n]/.test(text)) throw new TemplateError('a template is one line: it cannot hold a line break');
    // The blocks open: the root, then each {if}
    const root: Node[] = [];
    const stack: { node: Extract<Node, { kind: 'if' }> | null; body: Node[]; pos: number; hasElse: boolean }[] = [
        { node: null, body: root, pos: 0, hasElse: false },
    ];
    const current = () => stack[stack.length - 1];
    let literal = '';
    const flush = () => {
        if (literal !== '') current().body.push({ kind: 'text', text: literal });
        literal = '';
    };

    let i = 0;
    while (i < text.length) {
        const char = text[i];
        if (char === '{' && text[i + 1] === '{') {
            literal += '{';
            i += 2;
        } else if (char === '}' && text[i + 1] === '}') {
            literal += '}';
            i += 2;
        } else if (char === '}') {
            throw new TemplateError('"}" without "{": write }} for a brace', i);
        } else if (char === '{') {
            flush();
            const close = closingBrace(text, i);
            const inner = text.slice(i + 1, close);
            const start = i + 1 + (inner.length - inner.trimStart().length);
            const content = inner.trim();
            const word = /^[A-Za-z]+/.exec(content)?.[0] ?? '';
            const rest = content.slice(word.length);
            const restStart = start + word.length;
            if (word === 'if' && rest.trim() !== '') {
                const node: Extract<Node, { kind: 'if' }> = { kind: 'if', branches: [], otherwise: [] };
                const branch = { condition: parseExpression(rest, restStart, variables), body: [] as Node[] };
                node.branches.push(branch);
                current().body.push(node);
                stack.push({ node, body: branch.body, pos: i, hasElse: false });
            } else if (word === 'elif' && rest.trim() !== '') {
                const block = current();
                if (!block.node) throw new TemplateError('{elif} without {if}', i);
                if (block.hasElse) throw new TemplateError('{elif} after {else}', i);
                const branch = { condition: parseExpression(rest, restStart, variables), body: [] as Node[] };
                block.node.branches.push(branch);
                block.body = branch.body;
            } else if (word === 'else' && rest.trim() === '') {
                const block = current();
                if (!block.node) throw new TemplateError('{else} without {if}', i);
                if (block.hasElse) throw new TemplateError('a second {else}', i);
                block.hasElse = true;
                block.body = block.node.otherwise;
            } else if (word === 'end' && rest.trim() === '') {
                if (!current().node) throw new TemplateError('{end} without {if}', i);
                stack.pop();
            } else if (content === '') {
                throw new TemplateError('empty {}: write {{ for a brace', i);
            } else {
                current().body.push({ kind: 'expr', expr: parseExpression(inner, i + 1, variables) });
            }
            i = close + 1;
        } else {
            literal += char;
            i++;
        }
    }
    flush();
    if (stack.length > 1) throw new TemplateError('{if} without {end}', current().pos);
    return { nodes: root };
}

/** Where the brace opened at `open` closes, quotes skipped. */
function closingBrace(text: string, open: number): number {
    let quote: string | null = null;
    for (let i = open + 1; i < text.length; i++) {
        const char = text[i];
        if (quote) {
            if (char === '\\') i++;
            else if (char === quote) quote = null;
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === '{') {
            throw new TemplateError('"{" inside {…}', i);
        } else if (char === '}') {
            return i;
        }
    }
    throw new TemplateError(quote ? 'text not closed by its quote' : '"{" not closed by "}"', open);
}

type Token = { type: 'num' | 'str' | 'id' | 'op'; text: string; value?: Value; pos: number };

function tokenize(source: string, offset: number): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < source.length) {
        const char = source[i];
        const pos = offset + i;
        if (/\s/.test(char)) {
            i++;
        } else if (/\d/.test(char)) {
            const digits = /^\d+/.exec(source.slice(i))![0];
            if (/^[A-Za-z_.]/.test(source.slice(i + digits.length))) throw new TemplateError('only whole numbers can be written', pos);
            tokens.push({ type: 'num', text: digits, value: Number(digits), pos });
            i += digits.length;
        } else if (char === '"' || char === "'") {
            let value = '';
            let j = i + 1;
            for (; j < source.length && source[j] !== char; j++) {
                if (source[j] === '\\' && j + 1 < source.length) j++;
                value += source[j];
            }
            if (j >= source.length) throw new TemplateError('text not closed by its quote', pos);
            tokens.push({ type: 'str', text: source.slice(i, j + 1), value, pos });
            i = j + 1;
        } else if (/[A-Za-z_]/.test(char)) {
            const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i))![0];
            tokens.push({ type: 'id', text: name, pos });
            i += name.length;
        } else {
            const op = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '!', '+', '-', '*', '/', '%', '(', ')', ','].find((candidate) => source.startsWith(candidate, i));
            if (!op) throw new TemplateError(`unexpected "${char}"`, pos);
            tokens.push({ type: 'op', text: op, pos });
            i += op.length;
        }
    }
    return tokens;
}

/** Parses an expression, `offset` being where it starts in the template (for the positions of the errors). */
function parseExpression(source: string, offset: number, variables: ReadonlySet<string>): Expr {
    const tokens = tokenize(source, offset);
    let index = 0;
    const end = offset + source.length;
    const peek = () => tokens[index];
    const at = (type: Token['type'], text?: string) => peek()?.type === type && (text === undefined || peek().text === text);
    const expect = (text: string) => {
        if (!at('op', text)) throw new TemplateError(`"${text}" expected`, peek()?.pos ?? end);
        index++;
    };

    const binary = (ops: string[], type: Token['type'], next: () => Expr) => (): Expr => {
        let left = next();
        while (peek() && peek().type === type && ops.includes(peek().text)) {
            const { text: op, pos } = tokens[index++];
            left = { kind: 'binary', op, left, right: next(), pos };
        }
        return left;
    };

    const primary = (): Expr => {
        const token = peek();
        if (!token) throw new TemplateError('value expected', end);
        index++;
        if (token.type === 'num' || token.type === 'str') return { kind: 'value', value: token.value! };
        if (token.type === 'op' && token.text === '(') {
            const inner = or();
            expect(')');
            return inner;
        }
        if (token.type === 'id') {
            if (token.text === 'true' || token.text === 'false') return { kind: 'value', value: token.text === 'true' };
            if (KEYWORDS.has(token.text)) throw new TemplateError(`"${token.text}" cannot be used here`, token.pos);
            if (at('op', '(')) {
                index++;
                const arity = FUNCTIONS[token.text];
                if (!arity) throw new TemplateError(`unknown function "${token.text}"`, token.pos);
                const args: Expr[] = [];
                if (!at('op', ')')) {
                    args.push(or());
                    while (at('op', ',')) {
                        index++;
                        args.push(or());
                    }
                }
                expect(')');
                const [min, max] = arity;
                if (args.length < min || (max !== null && args.length > max)) {
                    const count = max === null ? `at least ${min}` : min === max ? `${min}` : `${min} or ${max}`;
                    throw new TemplateError(`${token.text}() takes ${count} argument${min === 1 && max === 1 ? '' : 's'}`, token.pos);
                }
                return { kind: 'call', name: token.text, args, pos: token.pos };
            }
            if (!variables.has(token.text)) throw new TemplateError(`unknown variable "${token.text}"`, token.pos);
            return { kind: 'var', name: token.text, pos: token.pos };
        }
        throw new TemplateError(`unexpected "${token.text}"`, token.pos);
    };
    const unary = (): Expr => {
        if (at('op', '-')) {
            const { pos } = tokens[index++];
            return { kind: 'unary', op: '-', operand: unary(), pos };
        }
        return primary();
    };
    const product = binary(['*', '/', '%'], 'op', unary);
    const sum = binary(['+', '-'], 'op', product);
    const comparison = (): Expr => {
        const left = sum();
        if (peek() && peek().type === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(peek().text)) {
            const { text: op, pos } = tokens[index++];
            return { kind: 'binary', op, left, right: sum(), pos };
        }
        return left;
    };
    const negation = (): Expr => {
        if (at('op', '!')) {
            const { pos } = tokens[index++];
            return { kind: 'unary', op: '!', operand: negation(), pos };
        }
        return comparison();
    };
    const and = binary(['&&'], 'op', negation);
    const or = binary(['||'], 'op', and);

    const expr = or();
    if (peek()) throw new TemplateError(`unexpected "${peek().text}"`, peek().pos);
    return expr;
}

const isNumeric = (value: Value): boolean => typeof value === 'number' || (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value));

function toNumber(value: Value, pos: number): number {
    if (isNumeric(value)) return Number(value);
    throw new TemplateError(`${JSON.stringify(value)} is not a number`, pos);
}

export const toText = (value: Value): string => (typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value));

const truthy = (value: Value): boolean => value !== false && value !== 0 && value !== '';

function evaluate(expr: Expr, scope: Scope): Value {
    switch (expr.kind) {
        case 'value':
            return expr.value;
        case 'var':
            return scope.vars[expr.name] ?? '';
        case 'unary': {
            const value = evaluate(expr.operand, scope);
            return expr.op === '!' ? !truthy(value) : -toNumber(value, expr.pos);
        }
        case 'binary': {
            if (expr.op === '&&') return truthy(evaluate(expr.left, scope)) && truthy(evaluate(expr.right, scope));
            if (expr.op === '||') return truthy(evaluate(expr.left, scope)) || truthy(evaluate(expr.right, scope));
            const left = evaluate(expr.left, scope);
            const right = evaluate(expr.right, scope);
            const numbers = isNumeric(left) && isNumeric(right);
            switch (expr.op) {
                case '+':
                    return numbers ? Number(left) + Number(right) : toText(left) + toText(right);
                case '-':
                    return toNumber(left, expr.pos) - toNumber(right, expr.pos);
                case '*':
                    return toNumber(left, expr.pos) * toNumber(right, expr.pos);
                case '/':
                case '%': {
                    const divisor = toNumber(right, expr.pos);
                    if (divisor === 0) throw new TemplateError('division by 0', expr.pos);
                    const dividend = toNumber(left, expr.pos);
                    return expr.op === '/' ? Math.trunc(dividend / divisor) : dividend % divisor;
                }
            }
            const order = numbers ? Number(left) - Number(right) : toText(left) < toText(right) ? -1 : toText(left) > toText(right) ? 1 : 0;
            return { '==': order === 0, '!=': order !== 0, '<': order < 0, '<=': order <= 0, '>': order > 0, '>=': order >= 0 }[expr.op]!;
        }
        case 'call': {
            const args = expr.args.map((arg) => evaluate(arg, scope));
            const text = (n: number) => toText(args[n]);
            const count = (n: number) => {
                const value = toNumber(args[n], expr.pos);
                if (value < 0) throw new TemplateError(`${expr.name}() needs a length from 0`, expr.pos);
                return value;
            };
            switch (expr.name) {
                case 'pad':
                    return text(0).padStart(count(1), args.length > 2 ? text(2) || ' ' : '0');
                case 'upper':
                    return text(0).toLocaleUpperCase('fr');
                case 'lower':
                    return text(0).toLocaleLowerCase('fr');
                case 'trim':
                    return text(0).trim();
                case 'len':
                    return [...text(0)].length;
                case 'left':
                    return [...text(0)].slice(0, count(1)).join('');
                case 'right': {
                    const n = count(1);
                    return n === 0 ? '' : [...text(0)].slice(-n).join('');
                }
                case 'min':
                case 'max': {
                    const numbers = args.map((arg) => toNumber(arg, expr.pos));
                    return expr.name === 'min' ? Math.min(...numbers) : Math.max(...numbers);
                }
                case 'abs':
                    return Math.abs(toNumber(args[0], expr.pos));
                case 'col':
                    return scope.column?.(text(0)) ?? '';
            }
            throw new TemplateError(`unknown function "${expr.name}"`, expr.pos);
        }
    }
}

/** A cell of a line: quoted, as in CSV, when it holds the separator, a quote or a line break. */
export function csvCell(text: string, separator: string): string {
    const special = text.includes(separator) || /["\r\n]/.test(text);
    return special ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The text of a template for a scope. An expression that cannot be evaluated (e.g. a division by 0) writes #ERROR,
 * and its error is added to `errors`.
 */
export function renderTemplate(template: Template, scope: Scope, errors: TemplateError[] = []): string {
    const render = (nodes: Node[]): string =>
        nodes
            .map((node) => {
                try {
                    if (node.kind === 'text') return node.text;
                    if (node.kind === 'expr') return toText(evaluate(node.expr, scope));
                    const branch = node.branches.find(({ condition }) => truthy(evaluate(condition, scope)));
                    return render(branch ? branch.body : node.otherwise);
                } catch (error) {
                    if (!(error instanceof TemplateError)) throw error;
                    errors.push(error);
                    return '#ERROR';
                }
            })
            .join('');
    return render(template.nodes);
}

// Variables of the header line, and of the line of each participant
export const HEADER_VARIABLES: ReadonlySet<string> = new Set(['event', 'discipline', 'measure', 'count']);
export const LINE_VARIABLES: ReadonlySet<string> = new Set([
    ...HEADER_VARIABLES,
    'bib',
    'name',
    'firstName',
    'lastName',
    'category',
    'status',
    'runs',
    'okRuns',
    'attempts',
    'bestRun',
    'bestAttempt',
    'rank',
    'categoryRank',
    'timeMs',
    'units',
    'minutes',
    'seconds',
    'fraction',
    'distance',
]);

/** A column of the UDA export: its title in the header line (a header template), its value in each line. */
export interface UdaColumn {
    title: string;
    value: string;
}

export const MAX_UDA_COLUMNS = 50;

/**
 * The columns of the UDA export when the discipline has none: the import format of the UDA, without header. The
 * results are 0 without an OK run, and DNS (no run) is written DNF, as the UDA knows DQ and DNF only.
 */
export function defaultColumns(measure: 'time' | 'distance'): UdaColumn[] {
    const results = measure === 'distance' ? ['{distance}'] : ['{minutes}', '{seconds}', '{fraction}'];
    return ['{bib}', '{if status == "DQ"}DQ{elif status != "OK"}DNF{end}', ...results].map((value) => ({ title: '', value }));
}

/**
 * The problems of columns of the UDA export, each named by its number: empty when they can be used. There must be 1
 * to MAX_UDA_COLUMNS, each with a title and a value.
 */
export function udaColumnsProblems(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_UDA_COLUMNS) return [`must be a list of 1 to ${MAX_UDA_COLUMNS} columns`];
    return value.flatMap((column, index) => {
        if (!column || typeof column !== 'object' || typeof column.title !== 'string' || typeof column.value !== 'string') {
            return [`column ${index + 1} must have a title and a value, as texts`];
        }
        return (['title', 'value'] as const).flatMap((part) => {
            try {
                parseTemplate(column[part], part === 'title' ? HEADER_VARIABLES : LINE_VARIABLES);
                return [];
            } catch (error) {
                if (!(error instanceof TemplateError)) throw error;
                return [`column ${index + 1} ${part}: ${error.message}`];
            }
        });
    });
}

export const DEFAULT_SEPARATOR = ',';
export const DEFAULT_SORT = 'bib';

/** A key of the order of the lines: a line variable, descending when written with a - before it. */
export interface SortKey {
    name: string;
    descending: boolean;
}

/** The keys of an order of the lines, e.g. "category, rank" or "-distance, bib". Throws a TemplateError if one is wrong. */
export function parseSort(text: string): SortKey[] {
    const keys = text
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '')
        .map((part) => {
            const match = /^(-?)\s*([A-Za-z_][A-Za-z0-9_]*)$/.exec(part);
            if (!match || !LINE_VARIABLES.has(match[2]) || HEADER_VARIABLES.has(match[2])) {
                throw new TemplateError(`"${part}" is not a variable of a participant to sort by`);
            }
            return { name: match[2], descending: match[1] === '-' };
        });
    if (keys.length === 0) throw new TemplateError('the order needs at least one variable');
    return keys;
}

/**
 * Compares two values to sort lines: empty values last, numbers by value, texts alphabetically (case and accents
 * ignored, digits by value).
 */
export function compareValues(a: Value, b: Value, descending = false): number {
    const emptyA = a === '';
    const emptyB = b === '';
    if (emptyA || emptyB) return Number(emptyA) - Number(emptyB);
    const order = isNumeric(a) && isNumeric(b) ? Number(a) - Number(b) : toText(a).localeCompare(toText(b), 'fr', { numeric: true, sensitivity: 'base' });
    return descending ? -order : order;
}

/** Whether a separator can be used: 1 to 5 characters, no line break nor brace. */
export const isSeparator = (value: unknown): value is string => typeof value === 'string' && /^[^\r\n{}]{1,5}$/.test(value);
