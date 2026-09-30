<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { api } from '../lib/api';
const id = ref(''), busy = ref(false), error = ref('');
function receive(e: Event) { id.value = (e as CustomEvent<string>).detail; error.value = ''; }
async function undo() { busy.value = true; try {
    await api.undo(id.value);
    id.value = '';
}
catch (e) {
    error.value = String(e instanceof Error ? e.message : e);
}
finally {
    busy.value = false;
} }
onMounted(() => window.addEventListener('ledger:undo', receive));
onBeforeUnmount(() => window.removeEventListener('ledger:undo', receive));
</script>
<template>
<div v-if="id" class="undo-notice" role="status">
<span>{{error || 'השינוי נשמר'}}</span>
<button class="btn" :disabled="busy" @click="undo">{{busy?'מבטל…':'ביטול השינוי'}}</button>
<RouterLink to="/activity" class="text-sm underline">היסטוריה</RouterLink>
<button class="icon-btn" aria-label="סגירת ההודעה" @click="id=''">×</button>
</div>
</template>
