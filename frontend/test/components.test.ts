import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import ParticipantPicker from '../src/components/race/ParticipantPicker.vue';
import RunPanel from '../src/components/race/RunPanel.vue';
import { setLocale } from '../src/i18n';
import type { Participant, RunResult, RunState } from '../src/types';
import { mountWithI18n } from './mount';

const HUGO: Participant = { bib: '7', name: 'Hugo Guérin', file: 'men' };
const LEA: Participant = { bib: '12', name: 'Léa Martin', file: 'women' };

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
    expect(suggestions(wrapper)).toEqual(['7 Hugo Guérin men', '12 Léa Martin women']);

    await input.setValue('lea');
    expect(suggestions(wrapper)).toEqual(['12 Léa Martin women']);

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
    ...extra,
  });

  function mountPanel(
    props: Partial<{ run: RunState; results: RunResult[]; attempts: number | null; best: 'shortest' | 'longest'; closed: string | null; lastResult: RunResult | null }> = {},
  ) {
    return mountWithI18n(RunPanel, {
      props: { participant: HUGO, run: { status: 'idle' }, results: [], lastResult: null, busy: false, closed: null, attempts: null, best: 'shortest', ...props },
    });
  }
  const readyButton = (wrapper: ReturnType<typeof mountPanel>) => wrapper.find('button.ready');

  it('offers "Ready to start" for the next attempt', async () => {
    const wrapper = mountPanel({ attempts: 3, results: [result({})] });
    expect(wrapper.text()).toContain('Attempt 2 of 3');
    expect(readyButton(wrapper).attributes('disabled')).toBeUndefined();
    await readyButton(wrapper).trigger('click');
    expect(wrapper.emitted('ready')).toHaveLength(1);
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

  it('waits for the start, then offers cancel, invalidate and disqualify while running', async () => {
    const ready = mountPanel({ run: { status: 'ready', event: 'CFM26', discipline: '100m', participant: HUGO } });
    expect(ready.text()).toContain('Waiting for the start…');

    const running = mountPanel({
      run: { status: 'running', event: 'CFM26', discipline: '100m', participant: HUGO, startedAt: new Date().toISOString() },
    });
    expect(running.find('[role="timer"]').exists()).toBe(true);
    for (const [label, event] of [['Cancel run', 'cancel'], ['Invalidate', 'invalidate'], ['Disqualify', 'disqualify']]) {
      await running.findAll('button').find((button) => button.text() === label)!.trigger('click');
      expect(running.emitted(event), event).toHaveLength(1);
    }
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
    expect(rows[2].find('s').text()).toBe('9.000');

    const select = rows[0].find('select');
    await select.setValue('invalid');
    expect(wrapper.emitted('setStatus')).toEqual([[results[0], 'invalid']]);
    // The select keeps the saved status until the saved result comes back
    expect((select.element as HTMLSelectElement).value).toBe('ok');
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
