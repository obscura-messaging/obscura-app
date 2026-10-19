const FILE_SCHEME = 'file://';

/** The plain path the bridge expects, from a path or a `file://` URL. */
export function toPath(pathOrUrl: string): string {
  return pathOrUrl.startsWith(FILE_SCHEME) ? pathOrUrl.slice(FILE_SCHEME.length) : pathOrUrl;
}

export function fileUri(path: string): string {
  return FILE_SCHEME + path;
}
