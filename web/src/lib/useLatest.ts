import { onBeforeUnmount } from 'vue';
/** Ignore old responses, including those arriving after the page unmounts. */
export function useLatest() {
    let version = 0;
    onBeforeUnmount(() => { version++; });
    return () => { const current = ++version; return () => version === current; };
}
