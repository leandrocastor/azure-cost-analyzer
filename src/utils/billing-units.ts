/** Groups overlapping sets transitively, without inferring relationships. */
export const groupByBillingUnits = <T>(
  items: T[],
  idsFor: (item: T) => string[],
): T[][] => {
  const groups: T[][] = [];
  const visited = new Set<T>();
  const expanded = new Set<string>();
  const byUnit = new Map<string, T[]>();
  for (const item of items) {
    for (const id of new Set(idsFor(item).map((unit) => unit.toLowerCase()))) {
      const bucket = byUnit.get(id) ?? [];
      bucket.push(item);
      byUnit.set(id, bucket);
    }
  }
  for (const item of items) {
    if (visited.has(item)) continue;
    const group = [item];
    visited.add(item);
    for (const current of group) {
      for (const id of idsFor(current).map((unit) => unit.toLowerCase())) {
        if (expanded.has(id)) continue;
        expanded.add(id);
        for (const candidate of byUnit.get(id) ?? []) {
          if (!visited.has(candidate)) {
            group.push(candidate);
            visited.add(candidate);
          }
        }
      }
    }
    groups.push(group);
  }
  return groups;
};
