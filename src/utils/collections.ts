/** Group `[key, value]` pairs into a map of value lists, in first-seen key order. */
export function groupBy<K, V>(pairs: Iterable<readonly [K, V]>): Map<K, V[]> {
  const groups = new Map<K, V[]>();
  for (const [key, value] of pairs) {
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [value]);
    else group.push(value);
  }
  return groups;
}
