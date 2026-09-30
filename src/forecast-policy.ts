/** Pure policy helpers shared by the engine, evidence UI and regression tests. */
export function coveredCycle(accounts: Array<{
    coverageFrom: Date | null;
    coverageThrough: Date | null;
    lifecycle: string;
}>, start: Date, end: Date): boolean {
    const active = accounts.filter(a => a.lifecycle === 'active');
    return active.length > 0 && active.every(a => a.coverageFrom != null && a.coverageFrom <= start && a.coverageThrough != null && a.coverageThrough >= end);
}
export function dataState(issues: Array<{
    kind: string;
    severity: string;
}>, uncategorizedShare = 0): 'complete' | 'partial' | 'stale' | 'unavailable' {
    if (issues.some(i => i.kind === 'no_bank_connected' || i.kind === 'missing_balance'))
        return 'unavailable';
    if (issues.some(i => i.kind === 'sync_stalled' || i.kind === 'provider_stale'))
        return 'stale';
    if (uncategorizedShare > 0 || issues.some(i => i.severity !== 'info'))
        return 'partial';
    return 'complete';
}
