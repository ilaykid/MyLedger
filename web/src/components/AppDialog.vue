<script setup lang="ts">
import { ref, watch, useId, nextTick, onBeforeUnmount } from 'vue';
const props = defineProps<{
    open: boolean;
    title: string;
    wide?: boolean;
    drawer?: boolean;
}>();
const emit = defineEmits<{
    close: [
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
</div>
</dialog>
</Teleport>
</template>
