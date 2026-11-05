<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import type { Participant } from '../../types';
import { searchParticipants } from '../../race/participantSearch';

// Most suggestions shown for a search: enough to pick from, short enough to scan. An empty input lists everyone.
const MAX_SUGGESTIONS = 12;

const props = defineProps<{
  participants: Participant[];
  // Bibs of the participants who used all their attempts: still listed, but shown as done
  finished?: Set<string>;
  disabled?: boolean;
}>();
const selected = defineModel<Participant | null>({ required: true });

const input = ref<HTMLInputElement | null>(null);
const list = ref<HTMLElement | null>(null);
const query = ref('');
const open = ref(false);
const activeIndex = ref(0);
const listId = useId();

const label = (participant: Participant) => `${participant.bib} · ${participant.name}`;
const suggestions = computed(() => searchParticipants(props.participants, query.value, MAX_SUGGESTIONS));
const showList = computed(() => open.value && !selected.value && props.participants.length > 0);

// Show the chosen participant. When the selection is cleared, the text goes too, unless the user is typing a new
// search (then the text no longer shows the previous participant).
watch(
  selected,
  (participant, previous) => {
    if (participant) query.value = label(participant);
    else if (!previous || query.value === label(previous)) query.value = '';
  },
  { immediate: true },
);

function onInput(): void {
  // Typing again starts a new search
  if (selected.value) selected.value = null;
  open.value = true;
  activeIndex.value = 0;
}

function choose(participant: Participant): void {
  selected.value = participant;
  open.value = false;
}

async function move(step: number): Promise<void> {
  if (!showList.value) {
    open.value = true;
    return;
  }
  const count = suggestions.value.length;
  if (count === 0) return;
  activeIndex.value = (activeIndex.value + step + count) % count;
  await nextTick();
  list.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    move(event.key === 'ArrowDown' ? 1 : -1);
  } else if (event.key === 'Enter' && showList.value) {
    event.preventDefault();
    const participant = suggestions.value[activeIndex.value];
    if (participant) choose(participant);
  } else if (event.key === 'Escape') {
    if (showList.value) open.value = false;
    else selected.value = null;
  }
}

defineExpose({ focus: () => input.value?.focus() });
</script>

<template>
  <div class="picker">
    <input
      ref="input"
      v-model="query"
      type="text"
      role="combobox"
      aria-autocomplete="list"
      :aria-expanded="showList"
      :aria-controls="listId"
      :aria-activedescendant="showList && suggestions.length > 0 ? `${listId}-${activeIndex}` : undefined"
      :disabled="disabled"
      placeholder="Bib number or name"
      autocomplete="off"
      spellcheck="false"
      @input="onInput"
      @keydown="onKeydown"
      @focus="open = true"
      @click="open = true"
      @blur="open = false"
    />
    <button v-if="selected && !disabled" type="button" class="icon clear" title="Clear" @click="selected = null; input?.focus()">
      ✕
    </button>

    <ul v-show="showList" :id="listId" ref="list" role="listbox" class="suggestions">
      <li
        v-for="(participant, index) in suggestions"
        :id="`${listId}-${index}`"
        :key="participant.bib"
        role="option"
        :class="{ finished: finished?.has(participant.bib) }"
        :aria-selected="index === activeIndex"
        @mousedown.prevent="choose(participant)"
        @mousemove="activeIndex = index"
      >
        <span class="bib mono">{{ participant.bib }}</span>
        <span class="name">{{ participant.name }}</span>
        <span class="file muted">{{ participant.file }}</span>
        <span v-if="finished?.has(participant.bib)" class="badge done" title="All attempts used">done</span>
      </li>
      <li v-if="suggestions.length === 0" class="empty muted">No participant matches “{{ query.trim() }}”</li>
    </ul>
  </div>
</template>

<style scoped>
.picker {
  position: relative;
  display: flex;
  align-items: center;
}
.picker input {
  width: 100%;
  font-size: 1.15em;
  padding: 8px 40px 8px 12px;
}
.clear {
  position: absolute;
  right: 6px;
  border: none;
}
.suggestions {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 10;
  max-height: 22em;
  overflow-y: auto;
  margin: 0;
  padding: 4px;
  list-style: none;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
}
.suggestions li {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.suggestions li[aria-selected='true'] {
  background: var(--accent-bg);
}
.suggestions li.empty {
  cursor: default;
}
.bib {
  min-width: 3.5em;
  text-align: right;
  font-weight: 600;
  color: var(--text-h);
}
.name {
  flex: 1;
  color: var(--text-h);
}
.suggestions li.finished .bib,
.suggestions li.finished .name {
  color: var(--text-muted);
  font-weight: normal;
  text-decoration: line-through;
}
.badge.done {
  font-size: 0.75em;
}
.file {
  font-size: 0.85em;
}
</style>
