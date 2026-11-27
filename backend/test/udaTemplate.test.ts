import { describe, expect, it } from 'vitest';
import { compareValues, defaultColumns, LINE_VARIABLES, parseSort, parseTemplate, renderTemplate, TemplateError, type Value } from '../src/services/udaTemplate.js';

const render = (text: string, vars: Record<string, Value> = {}) => {
    const errors: TemplateError[] = [];
    const out = renderTemplate(parseTemplate(text, new Set([...LINE_VARIABLES, ...Object.keys(vars)])), { vars, column: (name) => (name === 'Country' ? 'France' : '') }, errors);
    return errors.length > 0 ? `${out} | ${errors.map((e) => e.message).join('; ')}` : out;
};
const problem = (text: string) => {
    try {
        parseTemplate(text, LINE_VARIABLES);
        return null;
    } catch (error) {
        return (error as Error).message;
    }
};

describe('UDA templates', () => {
    it('writes text, braces and variables', () => {
        expect(render('Bib {bib}: {{ok}}', { bib: '7' })).toBe('Bib 7: {ok}');
        expect(render('{ name }', { name: 'Ann' })).toBe('Ann');
    });

    it('evaluates formulas, whole divisions included', () => {
        expect(render('{minutes * 60 + seconds}.{pad(fraction, 2)}', { minutes: 1, seconds: 13, fraction: 5 })).toBe('73.05');
        expect(render('{7 / 2} {-7 / 2} {7 % 2} {(1 + 2) * 3} {1 + 2 * 3} {-(2 - 5)}')).toBe('3 -3 1 9 7 3');
        expect(render('{distance / 100}m{pad(distance % 100, 2)}', { distance: 345 })).toBe('3m45');
        expect(render('{bib + 1000}', { bib: '7' })).toBe('1007');
        expect(render('{name + " " + upper(lastName)}', { name: 'Ann', lastName: 'Roy' })).toBe('Ann ROY');
    });

    it('chooses the branch of the first true condition', () => {
        const t = '{if status == "OK"}{rank}{elif status == "DQ" || status == "DNF"}-{else}DNS{end}';
        expect(render(t, { status: 'OK', rank: 2 })).toBe('2');
        expect(render(t, { status: 'DNF' })).toBe('-');
        expect(render(t, { status: 'DNS' })).toBe('DNS');
        expect(render('{if rank}{if rank <= 3}podium{else}{rank}{end}{end}', { rank: 2 })).toBe('podium');
        expect(render('{if !rank}none{end}', { rank: '' })).toBe('none');
        expect(render('{if runs >= 2 && runs < 10}x{end}', { runs: 3 })).toBe('x');
        expect(render('{if "10" > 9}yes{end}')).toBe('yes');
    });

    it('has functions', () => {
        expect(render('{pad(7, 4)}|{pad("a", 3, " ")}|{left("Hello", 2)}|{right("Hello", 3)}|{len("été")}|{trim("  x ")}')).toBe('0007|  a|He|llo|3|x');
        expect(render('{min(3, 1, 2)} {max(3, 1, 2)} {abs(-4)} {lower("ÉTÉ")} {col("Country")}')).toBe('1 3 4 été France');
    });

    it('has the columns of the UDA format by default', () => {
        expect(defaultColumns('time').map((column) => column.value)).toEqual(['{bib}', '{if status == "DQ"}DQ{elif status != "OK"}DNF{end}', '{minutes}', '{seconds}', '{fraction}']);
        expect(defaultColumns('distance').map((column) => column.value)).toEqual(['{bib}', '{if status == "DQ"}DQ{elif status != "OK"}DNF{end}', '{distance}']);
    });

    it('writes #ERROR for an expression that cannot be evaluated', () => {
        expect(render('{bib / 0}', { bib: '7' })).toBe('#ERROR | division by 0 (character 6)');
        expect(render('{name * 2}', { name: 'Ann' })).toBe('#ERROR | "Ann" is not a number (character 7)');
    });

    it('refuses mistakes, with their position', () => {
        expect(problem('{nope}')).toBe('unknown variable "nope" (character 2)');
        expect(problem('{foo(1)}')).toBe('unknown function "foo" (character 2)');
        expect(problem('{pad(1)}')).toBe('pad() takes 2 or 3 arguments (character 2)');
        expect(problem('{bib')).toBe('"{" not closed by "}" (character 1)');
        expect(problem('a}b')).toBe('"}" without "{": write }} for a brace (character 2)');
        expect(problem('{if bib}x')).toBe('{if} without {end} (character 1)');
        expect(problem('{else}')).toBe('{else} without {if} (character 1)');
        expect(problem('{if bib}{else}{elif bib}{end}')).toBe('{elif} after {else} (character 15)');
        expect(problem('{1.5}')).toBe('only whole numbers can be written (character 2)');
        expect(problem('{bib +}')).toBe('value expected (character 7)');
        expect(problem('{"a}')).toBe('text not closed by its quote (character 1)');
        expect(problem('{}')).toBe('empty {}: write {{ for a brace (character 1)');
        expect(problem('a\nb')).toMatch(/one line/);
        expect(problem('{"}"}')).toBeNull();
        expect(problem('{if bib and rank}x{end}')).toBe('unexpected "and" (character 9)');
        expect(problem('{bib & 1}')).toBe('unexpected "&" (character 6)');
    });

    it('reads the order of the lines', () => {
        expect(parseSort('category, -rank')).toEqual([{ name: 'category', descending: false }, { name: 'rank', descending: true }]);
        expect(() => parseSort('speed')).toThrow(TemplateError);
        expect(() => parseSort('sep')).toThrow(TemplateError);
        expect(() => parseSort(' ')).toThrow(TemplateError);
        expect([10, '', 2, 1].sort((a, b) => compareValues(a, b))).toEqual([1, 2, 10, '']);
        expect([10, '', 2].sort((a, b) => compareValues(a, b, true))).toEqual([10, 2, '']);
        expect(['b', 'Á', 'a10', 'a9'].sort((a, b) => compareValues(a, b))).toEqual(['Á', 'a9', 'a10', 'b']);
    });
});
