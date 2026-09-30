<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import QualityPage from './QualityPage.vue';
import DailyPage from './DailyPage.vue';
import NotificationCenter from '../components/NotificationCenter.vue';
const route = useRoute();
const section = computed(() => ['classify', 'insights'].includes(String(route.query.tab)) ? String(route.query.tab) : 'quality');
const sections = [{ id: 'quality', label: 'איכות וסנכרון' }, { id: 'classify', label: 'סיווג תנועות' }, { id: 'insights', label: 'תובנות' }];
</script>
<template>
  <div class="review-workspace">
    <div class="page-heading"><div><h1>לטיפול</h1><p>בודקים את הנתונים, מסווגים את התנועות וממשיכים הלאה.</p></div><RouterLink to="/activity" class="text-link">מה כבר טופל ←</RouterLink></div>
    <nav class="section-tabs" aria-label="תחומי טיפול"><RouterLink v-for="item in sections" :key="item.id" :to="{path:'/review',query:{tab:item.id}}" :class="{selected:section===item.id}" :aria-current="section===item.id?'page':undefined">{{item.label}}</RouterLink></nav>
    <QualityPage v-if="section==='quality'" embedded/>
    <DailyPage v-else-if="section==='classify'" embedded/>
    <NotificationCenter v-else embedded/>
  </div>
</template>
