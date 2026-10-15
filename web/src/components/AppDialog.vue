<script setup lang="ts">
import { ref, watch, useId, nextTick, onBeforeUnmount } from 'vue';
const props = defineProps<{
    open: boolean;
    title: string;
    wide?: boolean;
    drawer?: boolean;
    /**
     * Optional confirmation footer. When set, the dialog renders a confirm
     * button with this label (emitting `confirm`) and a cancel button
     * (emitting `close`). Without it the dialog is unchanged: content only.
     */
    confirmLabel?: string;
    /** Label for the cancel button in the confirmation footer. */
    cancelLabel?: string;
    /** Styles the confirm button as destructive. */
    danger?: boolean;
    /** Disables the footer buttons while the action runs. */
    busy?: boolean;
}>();
const emit = defineEmits<{
    close: [
    ];
    confirm: [
    ];
}>();
const titleId = useId();
const element = ref<HTMLDialogElement | null>(null);
watch(() => props.open, async (value) => { await nextTick(); if (value && !element.value?.open)
    element.value?.showModal();
else if (!value)
    element.value?.close(); }, { immediate: true });
onBeforeUnmount(() => element.value?.close());
</script>
<template>
<Teleport to="body">
<dialog ref="element" class="app-dialog" :class="{'dialog-wide':wide,'dialog-drawer':drawer}" :aria-labelledby="titleId" @cancel.prevent="emit('close')" @click="e=>{if(e.target===element)emit('close')}">
<div class="dialog-content">
<header class="flex items-center justify-between gap-3">
<h2 :id="titleId" class="text-lg font-bold">{{title}}</h2>
<button class="icon-btn" aria-label="סגירה" @click="emit('close')">×</button>
</header>
<div class="mt-5">
<slot/>
</div>
<footer v-if="confirmLabel" class="mt-6 flex flex-wrap items-center gap-2">
<button class="btn" :class="danger?'dialog-danger':'btn-primary'" :disabled="busy" @click="emit('confirm')">{{confirmLabel}}</button>
<button class="btn btn-ghost" :disabled="busy" @click="emit('close')">{{cancelLabel ?? 'ביטול'}}</button>
</footer>
</div>
</dialog>
</Teleport>
</template>
<style scoped>
.dialog-danger{background:var(--status-critical);color:#fff;border:1px solid transparent}
.dialog-danger:not(:disabled):hover{filter:brightness(1.08)}
</style>
