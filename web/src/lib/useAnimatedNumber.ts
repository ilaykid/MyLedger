import { onBeforeUnmount, ref, watch, type Ref } from 'vue';

/**
 * Eases a number toward its target so headline figures settle rather than snap.
 *
 * The easing is strictly a progressive enhancement: a guard timer always lands
 * the exact target value even if not a single animation frame runs. Without it
 * the displayed figure can stick at a stale number whenever requestAnimationFrame
 * is throttled or suspended - a backgrounded tab, a hidden window, headless
 * capture - which on a financial dashboard means showing the wrong amount.
 */
export function useAnimatedNumber(source: Ref<number>, durationMs = 700): Ref<number> {
  const display = ref(source.value);
  let frame = 0;
  let guard: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    cancelAnimationFrame(frame);
    clearTimeout(guard);
  };

  const reduceMotion = () =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  watch(
    source,
    (to, from) => {
      stop();
      if (reduceMotion() || typeof requestAnimationFrame === 'undefined' || document.hidden) {
        display.value = to;
        return;
      }

      const start = performance.now();
      const base = from ?? 0;
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / durationMs);
        // easeOutExpo - fast start, gentle landing
        const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
        display.value = base + (to - base) * eased;
        if (t < 1) frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);

      // setTimeout still fires when frames do not, so the true value always wins.
      guard = setTimeout(() => {
        cancelAnimationFrame(frame);
        display.value = to;
      }, durationMs + 80);
    },
    { immediate: true },
  );

  onBeforeUnmount(stop);
  return display;
}
