/// Normalize raw user input from the tag field. Trims, drops empty, and
/// rejects exact duplicates. Returns the new tag list to persist, or null
/// when the input shouldn't trigger a save (empty / duplicate / no change).
export function appendTag(
  input: string,
  existing: readonly string[],
): string[] | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (existing.includes(trimmed)) return null;
  return [...existing, trimmed];
}

export function removeTag(target: string, existing: readonly string[]): string[] {
  return existing.filter((t) => t !== target);
}
