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
    props: Partial<{ line: string | null; run: RunState; results: RunResult[]; attempts: number | null; best: 'shortest' | 'longest'; precision: Precision; closed: string | null; startBlocked: string | null; lastResult: RunResult | null; previousRun: RunResult | null; resultRows: number; settingsResultRows: number; measure: Measure; attemptsPerDistance: number | null; minDistance: number | null; allowDistanceChange: boolean }> = {},
  ) {
    return mountWithI18n(RunPanel, {
      props: { participant: HUGO, line: 'Line 1', run: { status: 'idle' }, results: [], lastResult: null, busy: false, closed: null, attempts: null, best: 'shortest', precision: 'hundredth', ...props },
    });
  }
  const readyButton = (wrapper: ReturnType<typeof mountPanel>) => wrapper.find('button.ready');
  // The buttons of the run, without those of the results' title
  const actions = (wrapper: ReturnType<typeof mountPanel>) => wrapper.findAll('button').filter((button) => !button.element.closest('.resize'));

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
    expect(actions(running).map((button) => button.text())).toEqual(['Invalidate', 'Disqualify']);
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
    // The latest first, with their number
    const rows = wrapper.findAll('tbody tr');
    expect(rows.map((row) => row.find('td').text())).toEqual(['3', '2', '1']);
    expect(rows.map((row) => row.classes().includes('best'))).toEqual([false, true, false]);
    expect(rows[1].find('.badge').text()).toBe('best');
    // A disqualified run's time is struck through
    expect(rows[0].find('s').text()).toBe('9.00');

    const select = rows[2].find('select');
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
    expect(actions(ready).map((button) => button.text())).toEqual(['Validate', 'Invalidate', 'Disqualify']);
    for (const [label, event] of [['Validate', 'validate'], ['Invalidate', 'invalidate'], ['Disqualify', 'disqualify']]) {
      await ready.findAll('button').find((button) => button.text() === label)!.trigger('click');
      expect(ready.emitted(event), event).toHaveLength(1);
    }
  });

  it('keeps the distance started until it is validated, and tells when the participant is eliminated', async () => {
    const jump = (distanceCm: number, status: RunResult['status'], start: string) => result({ start, timeMs: null, distanceCm, status });
    const started = mountPanel({ measure: 'distance', line: 'Manuel', attemptsPerDistance: 3, results: [jump(345, 'dq', '2026-11-05T10:00:00Z')] });
    const input = started.find('[data-testid="distance-input"]');
    expect((input.element as HTMLInputElement).value).toBe('345');
    expect(input.attributes('readonly')).toBeDefined();
    expect(started.find('[data-testid="started-distance"]').text()).toBe('Attempt 2 of 3');
    // Shown as locked
    expect(started.find('[data-testid="distance-locked"]').exists()).toBe(true);
    expect(input.classes()).toContain('locked');
    expect(input.attributes('title')).toBe('Distance locked: it cannot be changed before it is validated');

    // Unlocked by the operator, exceptionally: another distance, ready with the unlock
    await started.find('[data-testid="distance-locked"]').trigger('click');
    expect(input.attributes('readonly')).toBeUndefined();
    await input.setValue('360');
    await started.find('form.distance').trigger('submit');
    expect(started.emitted('ready')).toEqual([[360, true]]);
    // Locked again: back to the distance started
    await started.find('[data-testid="distance-locked"]').trigger('click');
    expect(input.attributes('readonly')).toBeDefined();
    expect((input.element as HTMLInputElement).value).toBe('345');
    // One ready button only, the one of the distance
    expect(started.findAll('button.ready').map((button) => button.text())).toEqual(['Ready']);

    // Unless the settings let the participant change distance
    const free = mountPanel({ measure: 'distance', line: 'Manuel', allowDistanceChange: true, results: [jump(345, 'dq', '2026-11-05T10:00:00Z')] });
    expect(free.find('[data-testid="distance-input"]').attributes('readonly')).toBeUndefined();
    expect((free.find('[data-testid="distance-input"]').element as HTMLInputElement).value).toBe('');
    expect(free.find('[data-testid="started-distance"]').exists()).toBe(false);
    expect(free.find('[data-testid="distance-locked"]').exists()).toBe(false);

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
    expect(rows.map((row) => row.find('td.time s, td.time').text().replace('best', '').trim())).toEqual(['500 cm', '390 cm', '345 cm']);
    expect(wrapper.find('thead').text()).toContain('Distance');
  });

  it('suggests the distance of the last run of the line, or 5 cm more after a valid run of the same participant', () => {
    const jump = (bib: string, distanceCm: number, status: RunResult['status']) =>
      result({ bib, name: bib === '7' ? 'Hugo Guérin' : 'Léa Martin', timeMs: null, distanceCm, status });
    const typed = (previousRun: RunResult | null) =>
      (mountPanel({ measure: 'distance', line: 'Manuel', previousRun }).find('[data-testid="distance-input"]').element as HTMLInputElement).value;
    expect(typed(null)).toBe('');
    expect(typed(jump('12', 300, 'ok'))).toBe('300');
    expect(typed(jump('12', 300, 'dq'))).toBe('300');
    expect(typed(jump('7', 300, 'ok'))).toBe('305');
    // The distance started comes first
    const started = mountPanel({ measure: 'distance', line: 'Manuel', results: [jump('7', 280, 'dq')], previousRun: jump('12', 300, 'ok') });
    expect((started.find('[data-testid="distance-input"]').element as HTMLInputElement).value).toBe('280');
  });

  it('suggests the minimum distance before the first run of the line, and never less', () => {
    const jump = (bib: string, distanceCm: number, status: RunResult['status']) =>
      result({ bib, name: bib === '7' ? 'Hugo Guérin' : 'Léa Martin', timeMs: null, distanceCm, status });
    const field = (previousRun: RunResult | null) =>
      mountPanel({ measure: 'distance', line: 'Manuel', minDistance: 250, previousRun }).find('[data-testid="distance-input"]').element as HTMLInputElement;
    expect(field(null).value).toBe('250');
    expect(field(null).min).toBe('250');
    expect(field(jump('12', 200, 'ok')).value).toBe('250');
    expect(field(jump('12', 300, 'ok')).value).toBe('300');
  });

  it('does not get ready below the minimum distance', async () => {
    const wrapper = mountPanel({ measure: 'distance', line: 'Manuel', minDistance: 250 });
    await wrapper.find('[data-testid="distance-input"]').setValue('240');
    await wrapper.find('form.distance').trigger('submit');
    expect(wrapper.emitted('ready')).toBeUndefined();
    await wrapper.find('[data-testid="distance-input"]').setValue('250');
    await wrapper.find('form.distance').trigger('submit');
    expect(wrapper.emitted('ready')).toEqual([[250]]);
  });

  it('leaves out of the best the runs beyond the attempts allowed, e.g. an invalid run made valid afterwards', () => {
    const results = [
      result({ start: '2026-11-05T10:00:00Z', timeMs: 12000 }),
      result({ start: '2026-11-05T10:05:00Z', timeMs: 11000, status: 'dq' }),
      result({ start: '2026-11-05T10:10:00Z', timeMs: 9000 }),
    ];
    const rows = mountPanel({ results, attempts: 2 }).findAll('tbody tr');
    expect(rows.map((row) => row.classes().includes('best'))).toEqual([false, false, true]);
    expect(rows.map((row) => row.find('[data-testid="beyond-attempts"]').exists())).toEqual([true, false, false]);
  });

  it('changes for now how many runs the results show at once, from their title', async () => {
    const wrapper = mountPanel({ results: [result({})], resultRows: 5, settingsResultRows: 5 });
    expect(wrapper.find('[data-testid="results-reset"]').exists()).toBe(false);
    await wrapper.find('[data-testid="results-more"]').trigger('click');
    await wrapper.find('[data-testid="results-fewer"]').trigger('click');
    expect(wrapper.emitted('resizeResults')).toEqual([[6], [4]]);
    await wrapper.setProps({ resultRows: 1 });
    expect(wrapper.find('[data-testid="results-fewer"]').attributes('disabled')).toBeDefined();
    await wrapper.find('[data-testid="results-reset"]').trigger('click');
    expect(wrapper.emitted('resizeResults')!.at(-1)).toEqual([5]);
  });

  it('marks the longest valid time as best for a slow race', () => {
    const results = [
      result({ start: '2026-11-05T10:00:00Z', timeMs: 12345 }),
      result({ start: '2026-11-05T10:05:00Z', timeMs: 11000 }),
      result({ start: '2026-11-05T10:10:00Z', timeMs: 15000, status: 'dq' }),
    ];
    const rows = mountPanel({ results, best: 'longest' }).findAll('tbody tr');
    expect(rows.map((row) => row.classes().includes('best'))).toEqual([false, false, true]);
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

  it('changes for now how many runs it shows, from its title', async () => {
    setLocale('en');
    const wrapper = mountWithI18n(RecentRuns, { props: { results: [], count: 3, settingsCount: 3, precision: 'hundredth' } });
    expect(wrapper.find('[data-testid="recent-reset"]').exists()).toBe(false);
    await wrapper.find('[data-testid="recent-more"]').trigger('click');
    await wrapper.find('[data-testid="recent-fewer"]').trigger('click');
    expect(wrapper.emitted('resize')).toEqual([[4], [2]]);
    await wrapper.setProps({ count: 1 });
    expect(wrapper.find('h3').text()).toBe('Last run of the line');
    expect(wrapper.find('[data-testid="recent-fewer"]').attributes('disabled')).toBeDefined();
    await wrapper.find('[data-testid="recent-reset"]').trigger('click');
    expect(wrapper.emitted('resize')!.at(-1)).toEqual([3]);
  });

  it('says when the line has no run yet', () => {
    expect(mountRecent([]).find('table').exists()).toBe(false);
  });

  it('selects a participant of the participant files by a click on their bib or name', async () => {
    const results = [result({ bib: '12', name: 'Léa Martin' }), result({ bib: '99', name: 'Removed' })];
    const wrapper = mountWithI18n(RecentRuns, { props: { results, count: 3, precision: 'hundredth', selectable: new Set(['7', '12']) } });
    const rows = wrapper.findAll('tbody tr');
    expect(rows.map((row) => row.findAll('button.pick').length)).toEqual([2, 0]);
    await rows[0].findAll('button.pick')[1].trigger('click');
    expect(wrapper.emitted('select')).toEqual([['12']]);
    // None while a run is in progress
    expect(mountRecent(results).find('button.pick').exists()).toBe(false);
  });
});
