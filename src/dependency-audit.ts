// No advisory exceptions: every known vulnerability fails the release check.
export function assessDependencyAudit(input: unknown): { unexpected: string[] } {
  const report = input as { error?: unknown; metadata?: { vulnerabilities?: { total?: number } }; vulnerabilities?: Record<string, { via?: unknown[] }> };
  if (!report || typeof report !== 'object' || report.error || !report.vulnerabilities
    || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)
    || !Number.isSafeInteger(report.metadata?.vulnerabilities?.total)) {
    throw new Error('npm audit did not return a complete vulnerability report');
  }
  const unexpected = new Set<string>();
  for (const [name, entry] of Object.entries(report.vulnerabilities)) {
    if (!entry || !Array.isArray(entry.via) || !entry.via.length) throw new Error('Malformed npm audit entry');
    for (const via of entry.via) {
      if (typeof via === 'string') {
        if (!Object.hasOwn(report.vulnerabilities, via)) throw new Error('Incomplete npm audit dependency chain');
        continue;
      }
      const advisory = via as { url?: string; name?: string; severity?: string };
      if (!advisory || typeof advisory.url !== 'string') throw new Error('Malformed npm audit advisory');
      unexpected.add(`${name}: ${advisory.url}`);
    }
  }
  const total = report.metadata!.vulnerabilities!.total!;
  if (total !== Object.keys(report.vulnerabilities).length || (total > 0 && unexpected.size === 0)) {
    throw new Error('Inconsistent npm audit vulnerability counts');
  }
  return { unexpected: [...unexpected] };
}
