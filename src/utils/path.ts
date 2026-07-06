export function joinPath(folder: string, file: string): string {
  // Native separator: prefer the one already used in the folder string.
  const sep = folder.includes("\\") ? "\\" : "/";
  const trimmed = folder.endsWith(sep) ? folder.slice(0, -1) : folder;
  return `${trimmed}${sep}${file}`;
}

export function normalizePathForCompare(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function isSamePath(a: string, b: string): boolean {
  return normalizePathForCompare(a) === normalizePathForCompare(b);
}

export function isPathWithin(path: string, root: string): boolean {
  const normalizedPath = normalizePathForCompare(path);
  const normalizedRoot = normalizePathForCompare(root);
  if (normalizedPath === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith("/")
    ? normalizedRoot
    : `${normalizedRoot}/`;
  return normalizedPath.startsWith(prefix);
}

export function parentPath(path: string): string | null {
  const usesBackslash = path.includes("\\");
  const sep = usesBackslash ? "\\" : "/";
  const trimmed = path.replace(/[\\/]+$/, "");
  const normalized = trimmed.replace(/\\/g, "/");

  if (!normalized || /^[A-Za-z]:$/.test(normalized)) return null;
  if (normalized.startsWith("//")) {
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length <= 2) return null;
    return `\\\\${parts.slice(0, -1).join("\\")}`;
  }

  const index = normalized.lastIndexOf("/");
  if (index < 0) return null;
  if (index === 0) return "/";

  const parent = normalized.slice(0, index);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}${sep}`;
  return usesBackslash ? parent.replace(/\//g, "\\") : parent;
}

export function pathLabel(path: string): string {
  if (/^[A-Za-z]:[\\/]?$/.test(path)) return path;
  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed) return path;
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function ancestorPaths(rootPath: string, currentPath: string): string[] {
  if (!isPathWithin(currentPath, rootPath)) return [rootPath];

  const chain: string[] = [];
  let cursor: string | null = currentPath;
  while (cursor) {
    chain.push(cursor);
    if (isSamePath(cursor, rootPath)) break;
    const parent = parentPath(cursor);
    if (!parent || isSamePath(parent, cursor)) break;
    cursor = parent;
  }

  if (!chain.some((path) => isSamePath(path, rootPath))) {
    chain.push(rootPath);
  }
  return chain.reverse();
}
