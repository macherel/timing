<script setup lang="ts">
import { useId } from 'vue';
import type { Locale } from '../../i18n';

/**
 * The flag of a language, drawn in SVG: flag emoji show as two letters on Windows. Decorative: the button around it
 * gives the language name.
 */
defineProps<{ code: Locale }>();

// The clip paths need ids unique in the page
const id = useId();
</script>

<template>
  <svg v-if="code === 'fr'" class="flag" viewBox="0 0 3 2" width="24" height="16" aria-hidden="true">
    <rect width="1" height="2" fill="#002654" />
    <rect x="1" width="1" height="2" fill="#fff" />
    <rect x="2" width="1" height="2" fill="#ce1126" />
  </svg>
  <svg v-else-if="code === 'de'" class="flag" viewBox="0 0 5 3" width="27" height="16" aria-hidden="true">
    <rect width="5" height="1" fill="#000" />
    <rect y="1" width="5" height="1" fill="#dd0000" />
    <rect y="2" width="5" height="1" fill="#ffce00" />
  </svg>
  <svg v-else-if="code === 'en'" class="flag" viewBox="0 0 60 30" width="32" height="16" aria-hidden="true">
    <clipPath :id="`${id}-flag`"><path d="M0,0 v30 h60 v-30 z" /></clipPath>
    <clipPath :id="`${id}-diagonals`"><path d="M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z" /></clipPath>
    <g :clip-path="`url(#${id}-flag)`">
      <path d="M0,0 v30 h60 v-30 z" fill="#012169" />
      <path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" stroke-width="6" />
      <path d="M0,0 L60,30 M60,0 L0,30" :clip-path="`url(#${id}-diagonals)`" stroke="#c8102e" stroke-width="4" />
      <path d="M30,0 v30 M0,15 h60" stroke="#fff" stroke-width="10" />
      <path d="M30,0 v30 M0,15 h60" stroke="#c8102e" stroke-width="6" />
    </g>
  </svg>
</template>

<style scoped>
.flag {
  display: block;
  border-radius: 2px;
  /* A thin edge, so the white parts stay visible on a light background */
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.15);
}
</style>
