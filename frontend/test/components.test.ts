import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import ParticipantPicker from '../src/components/race/ParticipantPicker.vue';
import RunPanel from '../src/components/race/RunPanel.vue';
import RecentRuns from '../src/components/race/RecentRuns.vue';
import { setLocale } from '../src/i18n';
import type { Measure, Participant, Precision, RunResult, RunState } from '../src/types';
import { mountWithI18n } from './mount';

const HUGO: Participant = { bib: '7', name: 'Hugo Guérin', category: 'Sénior M' };
const LEA: Participant = { bib: '12', name: 'Léa Martin', category: '' };

describe('ParticipantPicker', () => {
  function mountPicker(props: { finished?: Set<string>; disabled?: boolean } = {}) {
    const wrapper = mountWithI18n(ParticipantPicker, {
      props: {
        participants: [HUGO, LEA],
        modelValue: null,
        'onUpdate:modelValue': (value: Participant | null) => wrapper.setProps({ modelValue: value }),
        ...props,
      },
    });
    return wrapper;
  }
  const suggestions = (wrapper: ReturnType<typeof mountPicker>) =>
    wrapper.findAll('[role="option"]').map((option) => option.findAll('span').map((span) => span.text()).join(' '));

  it('lists everyone when focused, and the matches while typing', async () => {
    const wrapper = mountPicker();
    const input = wrapper.find('input');
    await input.trigger('focus');
    expect(suggestions(wrapper)).toEqual(['7 Hugo Guérin Sénior M', '12 Léa Martin']);

    await input.setValue('lea');
    expect(suggestions(wrapper)).toEqual(['12 Léa Martin']);

    await input.setValue('zzz');
    expect(wrapper.find('.empty').text()).toBe('No participant matches “zzz”');
  });

  it('selects with the arrow keys and Enter, and shows the choice in the input', async () => {
    const wrapper = mountPicker();
    const input = wrapper.find('input');
    await input.trigger('focus');
    await input.trigger('keydown', { key: 'ArrowDown' });
    await input.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([LEA]);
    expect(input.element.value).toBe('12 · Léa Martin');
    // The list is hidden (v-show) once a participant is chosen
    expect(wrapper.find('[role="listbox"]').attributes('style')).toContain('display: none');
  });

  it('selects with a click, and clears with the ✕ button', async () => {
    const wrapper = mountPicker();
    await wrapper.find('input').trigger('focus');
    await wrapper.findAll('[role="option"]')[0].trigger('mousedown');
    expect(wrapper.props('modelValue')).toEqual(HUGO);

    await wrapper.find('button.clear').trigger('click');
    expect(wrapper.props('modelValue')).toBeNull();
    expect(wrapper.find('input').element.value).toBe('');
  });

  it('marks the participants without attempts left as done', async () => {
    const wrapper = mountPicker({ finished: new Set(['7']) });
    await wrapper.find('input').trigger('focus');
    const [hugo, lea] = wrapper.findAll('[role="option"]');
    expect(hugo.classes()).toContain('finished');
    expect(hugo.find('.badge').text()).toBe('done');
    expect(lea.find('.badge').exists()).toBe(false);
  });

  it('cannot be used while disabled (a run is in progress)', () => {
    const wrapper = mountPicker({ disabled: true });
    expect(wrapper.find('input').attributes('disabled')).toBeDefined();
  });
});

describe('RunPanel', () => {
  const result = (extra: Partial<RunResult>): RunResult => ({
    bib: '7',
    name: 'Hugo Guérin',
    start: '2026-11-05T10:00:00Z',
    finish: '2026-11-05T10:00:12.345Z',
    timeMs: 12345,
    status: 'ok',
    computer: 'PC',
    line: 'Line 1',
    ...extra,
  });

  function mountPanel(
    props: Partial<{ line: string | null; run: RunState; results: RunResult[]; attempts: number | null; best: 'shortest' | 'longest'; precision: Precision; closed: string | null; startBlocked: string | null; lastResult: RunResult | null; measure: Measure; attemptsPerDistance: number | null; allowDistanceChange: boolean }> = {},
  ) {
    return mountWithI18n(RunPanel, {
      props: { participant: HUGO, line: 'Line 1', run: { status: 'idle' }, results: [], lastResult: null, busy: false, closed: null, attempts: null, best: 'shortest', precision: 'hundredth', ...props },
    });
  }
  const readyButton = (wrapper: ReturnType<typeof mountPanel>) => wrapper.find('button.ready');

  it('offers "Ready to start" for the next attempt', async () => {
    const wrapper = mountPanel({ attempts: 3, results: [result({})] });
    expect(wrapper.text()).toContain('Sénior M · Attempt 2 of 3');
    expect(readyButton(wrapper).attributes('disabled')).toBeUndefined();
    await readyButton(wrapper).trigger('click');
    expect(wrapper.emitted('ready')).toHaveLength(1);
  });

  it('shows no category when the participant has none', () => {
    const wrapper = mountWithI18n(RunPanel, {
      props: { participant: LEA, line: 'Line 1', run: { status: 'idle' }, results: [], lastResult: null, busy: false, closed: null, attempts: null, best: 'shortest', precision: 'hundredth' },
    });
    expect(wrapper.find('.who .muted').text()).toBe('Attempt 1');
  });

  it('does not count invalid runs as attempts, and stops when none is left', () => {
    const one = mountPanel({ attempts: 2, results: [result({ status: 'invalid', finish: null, timeMs: null })] });
    expect(one.text()).toContain('Attempt 1 of 2');

    const none = mountPanel({ attempts: 1, results: [result({})] });
    expect(none.text()).toContain('Its only attempt is used');
    expect(readyButton(none).attributes('disabled')).toBeDefined();
    expect(readyButton(none).attributes('title')).toBe('No attempt left');
  });

  it('says why it cannot start when the discipline is closed', () => {
    const wrapper = mountPanel({ closed: 'its results are locked' });
    expect(readyButton(wrapper).attributes('disabled')).toBeDefined();
    expect(readyButton(wrapper).attributes('title')).toBe('Closed: its results are locked');
  });

  it('waits for the start, then offers invalidate and disqualify while running, but not cancel', async () => {
    const ready = mountPanel({ run: { status: 'ready', event: 'CFM26', discipline: '100m', participant: HUGO } });
    expect(ready.text()).toContain('Waiting for the start…');

    const running = mountPanel({
      run: { status: 'running', event: 'CFM26', discipline: '100m', participant: HUGO, startedAt: new Date().toISOString() },
    });
    expect(running.find('[role="timer"]').exists()).toBe(true);
    expect(running.findAll('button').map((button) => button.text())).toEqual(['Invalidate', 'Disqualify']);
    for (const [label, event] of [['Invalidate', 'invalidate'], ['Disqualify', 'disqualify']]) {
      await running.findAll('button').find((button) => button.text() === label)!.trigger('click');
      expect(running.emitted(event), event).toHaveLength(1);
    }
  });

  it('cannot get ready without a line on this computer', () => {
    const wrapper = mountPanel({ line: null });
    expect(readyButton(wrapper).attributes('disabled')).toBeDefined();
    expect(readyButton(wrapper).attributes('title')).toBe('No line on this computer');
  });

  it('cannot get ready on a line that cannot start runs, but its results can still be changed', () => {
    const wrapper = mountPanel({ startBlocked: 'No new start on this line', results: [result({})] });
    expect(readyButton(wrapper).attributes('disabled')).toBeDefined();
    expect(readyButton(wrapper).attributes('title')).toBe('No new start on this line');
    expect(wrapper.find('select').attributes('disabled')).toBeUndefined();
  });

  it('tells when another participant is running', () => {
    const wrapper = mountPanel({ run: { status: 'ready', event: 'CFM26', discipline: '100m', participant: LEA } });
    expect(wrapper.find('.other').text()).toBe('12 Léa Martin (CFM26 / 100m) is waiting for the start.');
    expect(readyButton(wrapper).attributes('disabled')).toBeDefined();
  });

  it('lists the results with the best valid time marked, and edits a status', async () => {
    const results = [
      result({ start: '2026-11-05T10:00:00Z', timeMs: 12345 }),
      result({ start: '2026-11-05T10:05:00Z', timeMs: 11000 }),
      result({ start: '2026-11-05T10:10:00Z', timeMs: 9000, status: 'dq' }),
    ];
    const wrapper = mountPanel({ results });
    const rows = wrapper.findAll('tbody tr');
    expect(rows.map((row) => row.classes().includes('best'))).toEqual([false, true, false]);
    expect(rows[1].find('.badge').text()).toBe('best');
    // A disqualified run's time is struck through
    expect(rows[2].find('s').text()).toBe('9.00');

    const select = rows[0].find('select');
    await select.setValue('invalid');
    expect(wrapper.emitted('setStatus')).toEqual([[results[0], 'invalid']]);
    // The select keeps the saved status until the saved result comes back
    expect((select.element as HTMLSelectElement).value).toBe('ok');
  });

  it('shows the times with the decimals of the precision', () => {
    const results = [result({ timeMs: 12345 })];
    expect(mountPanel({ results, precision: 'thousandth' }).find('tbody td.time').text()).toBe('12.345');
    expect(mountPanel({ results: [result({ timeMs: 12000 })], precision: 'second' }).find('tbody td.time').text()).toBe('12');
  });

  it('takes the distance typed to get the participant ready, then validates it or not', async () => {
    const idle = mountPanel({ measure: 'distance', line: 'Manuel' });
    const input = idle.find('[data-testid="distance-input"]');
    expect(input.attributes('step')).toBe('1');
    // Nothing typed: not ready
    await idle.find('form.distance').trigger('submit');
    expect(idle.emitted('ready')).toBeUndefined();
    await input.setValue('345');
    await idle.find('form.distance').trigger('submit');
    expect(idle.emitted('ready')).toEqual([[345]]);

    const ready = mountPanel({ measure: 'distance', line: 'Manuel', run: { status: 'ready', event: 'CFM26', discipline: 'jump', participant: HUGO, distanceCm: 345 } });
    expect(ready.find('[data-testid="distance-to-validate"]').text()).toBe('345 cm');
    expect(ready.findAll('button').map((button) => button.text())).toEqual(['Validate', 'Invalidate', 'Disqualify']);
    for (const [label, event] of [['Validate', 'validate'], ['Invalidate', 'invalidate'], ['Disqualify', 'disqualify']]) {
      await ready.findAll('button').find((button) => button.text() === label)!.trigger('click');
      expect(ready.emitted(event), event).toHaveLength(1);
    }
  });

  it('keeps the distance started until it is validated, and tells when the participant is eliminated', () => {
    const jump = (distanceCm: number, status: RunResult['status'], start: string) => result({ start, timeMs: null, distanceCm, status });
    const started = mountPanel({ measure: 'distance', line: 'Manuel', attemptsPerDistance: 3, results: [jump(345, 'dq', '2026-11-05T10:00:00Z')] });
    const input = started.find('[data-testid="distance-input"]');
    expect((input.element as HTMLInputElement).value).toBe('345');
    expect(input.attributes('readonly')).toBeDefined();
    expect(started.find('[data-testid="started-distance"]').text()).toBe('Distance started: 345 cm, attempt 2 of 3');
    // One ready button only, the one of the distance
    expect(started.findAll('button.ready').map((button) => button.text())).toEqual(['Ready']);

    // Unless the settings let the participant change distance
    const free = mountPanel({ measure: 'distance', line: 'Manuel', allowDistanceChange: true, results: [jump(345, 'dq', '2026-11-05T10:00:00Z')] });
    expect(free.find('[data-testid="distance-input"]').attributes('readonly')).toBeUndefined();
    expect((free.find('[data-testid="distance-input"]').element as HTMLInputElement).value).toBe('');
    expect(free.find('[data-testid="started-distance"]').exists()).toBe(false);

    const out = mountPanel({
      measure: 'distance',
      line: 'Manuel',
      attemptsPerDistance: 2,
      results: [jump(345, 'dq', '2026-11-05T10:00:00Z'), jump(345, 'dq', '2026-11-05T10:01:00Z')],
    });
    expect(out.text()).toContain('Eliminated: 2 attempts at 345 cm');
    expect(readyButton(out).attributes('disabled')).toBeDefined();
  });

  it('lists the distances in centimetres with the longest valid one marked as best, whatever the precision of times', () => {
    const results = [
      result({ start: '2026-11-05T10:00:00Z', timeMs: null, distanceCm: 345 }),
      result({ start: '2026-11-05T10:05:00Z', timeMs: null, distanceCm: 390 }),
      result({ start: '2026-11-05T10:10:00Z', timeMs: null, distanceCm: 500, status: 'dq' }),
    ];
    const wrapper = mountPanel({ results, measure: 'distance', precision: 'tenth' });
    const rows = wrapper.findAll('tbody tr');
    expect(rows.map((row) => row.classes().includes('best'))).toEqual([false, true, false]);
    expect(rows.map((row) => row.find('td.time s, td.time').text().replace('best', '').trim())).toEqual(['345 cm', '390 cm', '500 cm']);
    expect(wrapper.find('thead').text()).toContain('Distance');
  });

  it('leaves out of the best the runs beyond the attempts allowed, e.g. an invalid run made valid afterwards', () => {
    const results = [
      result({ start: '2026-11-05T10:00:00Z', timeMs: 12000 }),
      result({ start: '2026-11-05T10:05:00Z', timeMs: 11000, status: 'dq' }),
      result({ start: '2026-11-05T10:10:00Z', timeMs: 9000 }),
    ];
    const rows = mountPanel({ results, attempts: 2 }).findAll('tbody tr');
    expect(rows.map((row) => row.classes().includes('best'))).toEqual([true, false, false]);
    expect(rows.map((row) => row.find('[data-testid="beyond-attempts"]').exists())).toEqual([false, false, true]);
  });

  it('marks the longest valid time as best for a slow race', () => {
    const results = [
      result({ start: '2026-11-05T10:00:00Z', timeMs: 12345 }),
      result({ start: '2026-11-05T10:05:00Z', timeMs: 11000 }),
      result({ start: '2026-11-05T10:10:00Z', timeMs: 15000, status: 'dq' }),
    ];
    const rows = mountPanel({ results, best: 'longest' }).findAll('tbody tr');
    expect(rows.map((row) => row.classes().includes('best'))).toEqual([true, false, false]);
  });

  it('cannot set a run without a time to OK', () => {
    const wrapper = mountPanel({ results: [result({ status: 'dq', finish: null, timeMs: null })] });
    const ok = wrapper.find('option[value="ok"]');
    expect(ok.attributes('disabled')).toBeDefined();
  });

  it('follows the chosen language', async () => {
    const wrapper = mountPanel({ attempts: 3 });
    setLocale('fr');
    await nextTick();
    expect(wrapper.text()).toContain('Essai 1 sur 3');
    expect(readyButton(wrapper).text()).toBe('Prêt au départ');
  });
});

describe('RecentRuns', () => {
  const result = (extra: Partial<RunResult>): RunResult => ({
    bib: '7',
    name: 'Hugo Guérin',
    start: '2026-11-05T10:00:00Z',
    finish: '2026-11-05T10:00:12.345Z',
    timeMs: 12345,
    status: 'ok',
    computer: 'PC',
    line: 'Line 1',
    ...extra,
  });
  const mountRecent = (results: RunResult[], precision: Precision = 'hundredth') =>
    mountWithI18n(RecentRuns, { props: { results, count: 3, precision } });

  it('lists the runs with their bib, name, time and status', () => {
    setLocale('en');
    const wrapper = mountRecent([
      result({ bib: '12', name: 'Léa Martin', timeMs: 11000 }),
      result({ status: 'dq', finish: null, timeMs: null }),
    ]);
    const rows = wrapper.findAll('tbody tr').map((row) => row.findAll('td').map((cell) => cell.text()));
    expect(rows.map((cells) => [cells[0], cells[1], cells[2], cells[4]])).toEqual([
      ['12', 'Léa Martin', '11.00', 'OK'],
      ['7', 'Hugo Guérin', '—', 'DQ'],
    ]);
    expect(wrapper.find('h3').text()).toBe('Last 3 runs of the line');
  });

  it('says when the line has no run yet', () => {
    expect(mountRecent([]).find('table').exists()).toBe(false);
  });
});
