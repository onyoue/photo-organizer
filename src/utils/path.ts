export function joinPath(folder: string, file: string): string {
  // Native separator: prefer the one already used in the folder string.
  const sep = folder.includes("\\") ? "\\" : "/";
  const trimmed = folder.endsWith(sep) ? folder.slice(0, -1) : folder;
  return `${trimmed}${sep}${file}`;
}
