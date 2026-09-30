<script setup lang="ts">
defineProps<{ name: string; size?: number }>();
const paths: Record<string,string> = {
  home:'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
  transactions:'M4 4h16v16H4z M8 8h8 M8 12h5 M8 16h8',
  review:'m8 12 3 3 5-6 M4 3h16v18H4z',
  chart:'M4 3v17h17 M8 15v-4 M13 15V7 M18 15V4',
  wallet:'M3 5h17v15H3z M3 5V3h14 M15 10h6v5h-6z',
  calendar:'M4 5h16v16H4z M8 3v4 M16 3v4 M4 10h16 M8 14h2 M14 14h2',
  settings:'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
  tag:'M3 3h8l10 10-8 8L3 11z M7 7h.01',
  history:'M4 10a8 8 0 1 1 0 5 M4 4v6h6 M12 7v5l3 2',
  arrow:'M19 12H5m6-6-6 6 6 6',
  menu:'M4 6h16 M4 12h16 M4 18h16',
};
</script>
<template><svg :width="size ?? 20" :height="size ?? 20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] ?? paths.settings"/></svg></template>
