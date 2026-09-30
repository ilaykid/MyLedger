import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import './style.css';
import './workspace.css';
import ReviewHubPage from './pages/ReviewHubPage.vue';
import ActivityPage from './pages/ActivityPage.vue';

import DashboardPage from './pages/DashboardPage.vue';
import ConnectionsPage from './pages/ConnectionsPage.vue';
import RecurringPage from './pages/RecurringPage.vue';
import TransactionsPage from './pages/TransactionsPage.vue';
import BreakdownPage from './pages/BreakdownPage.vue';
import CategoriesPage from './pages/CategoriesPage.vue';
import RulesPage from './pages/RulesPage.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/quality', redirect: to => ({path:'/review',query:{...to.query,tab:'quality'},hash:to.hash}) },
    { path: '/review', component: ReviewHubPage },
    { path: '/planning', component: DashboardPage, props: { view: 'planning' } },
    { path: '/month-details', component: DashboardPage, props: { view: 'details' } },
    { path: '/activity', component: ActivityPage },
    { path: '/settings', component: ConnectionsPage, props: { settingsOnly: true } },
    { path: '/', component: DashboardPage, name: 'dashboard' },
    { path: '/connections', component: ConnectionsPage, name: 'connections' },
    { path: '/recurring', component: RecurringPage, name: 'recurring' },
    { path: '/transactions', component: TransactionsPage, name: 'transactions' },
    { path: '/breakdown', component: BreakdownPage, name: 'breakdown' },
    { path: '/daily', redirect: to => ({path:'/review',query:{...to.query,tab:'classify'},hash:to.hash}), name: 'daily' },
    { path: '/categories', component: CategoriesPage, name: 'categories' },
    { path: '/rules', component: RulesPage, name: 'rules' },
  ],
  scrollBehavior: (to) => to.hash ? {el:to.hash,top:90} : {top:0},
});

createApp(App).use(router).mount('#app');
