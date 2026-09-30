const MAX_PATTERN_LENGTH = 200;

/**
 * A small subset for merchant rules: no repeated groups, assertions or
 * backreferences; one unbounded atomic repetition and a finite branching budget.
 * Callers also limit descriptions to 500 characters. Rejecting complex rules is
 * preferable to running a potentially exponential expression on the API thread.
 */
export function compileSafeRegex(pattern: string): RegExp {
  if (pattern.length > MAX_PATTERN_LENGTH) throw new Error(`regex is longer than ${MAX_PATTERN_LENGTH} characters`);
  const groups: boolean[] = [];
  let inClass = false, lastGroup = false, groupQuantified = false, unbounded = 0, choices = 1;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      const escaped = pattern[++i];
      if (!inClass && (/[1-9]/.test(escaped ?? '') || escaped === 'k')) throw new Error('regex backreferences are not allowed');
      if ((escaped === 'p' || escaped === 'P') && pattern[i + 1] === '{') {
        const end = pattern.indexOf('}', i + 2);
        if (end < 0) throw new Error('invalid Unicode property');
        i = end;
      }
      lastGroup = false;
      continue;
    }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; lastGroup = false; continue; }
    if (c === '(') {
      if (pattern[i + 1] === '?') {
        if (pattern[i + 2] !== ':') throw new Error('regex assertions and special groups are not allowed');
        i += 2;
      }
      groups.push(false); lastGroup = false; continue;
    }
    if (c === ')') { groupQuantified = groups.pop() ?? false; lastGroup = true; continue; }
    if (c === '*' || c === '+' || c === '?' || c === '{') {
      if (lastGroup && (c !== '?' || groupQuantified)) throw new Error('nested or repeated regex groups are not allowed');
      if (c === '*' || c === '+') unbounded++;
      else if (c === '?') choices *= 2;
      else {
        const count = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(i));
        if (!count) throw new Error('invalid regex repetition');
        const min = Number(count[1]);
        const max = count[2] === undefined ? min : count[2] === '' ? Infinity : Number(count[2]);
        if (min > 100 || (Number.isFinite(max) && max > 100)) throw new Error('regex repetition is too large');
        if (max === Infinity) unbounded++; else choices *= max - min + 1;
        i += count[0].length - 1;
      }
      if (unbounded > 1 || choices > 16) throw new Error('regex has too many variable repetitions');
      for (let j = 0; j < groups.length; j++) groups[j] = true;
      if (pattern[i + 1] === '?') i++;
      lastGroup = false;
      continue;
    }
    lastGroup = false;
  }
  return new RegExp(pattern, 'iu');
}
