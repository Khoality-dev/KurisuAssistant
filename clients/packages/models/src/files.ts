/**
 * A directory entry, as every file source describes one.
 *
 * This lived in the desktop explorer's store, which made the API layer import
 * from the store to describe its own return type — the one back-edge in an
 * otherwise layered import graph. It is a wire shape, so it belongs here.
 */
export interface FileEntry {
  name: string;
  fullPath: string;
  type: 'file' | 'directory';
  size: number;
  modified: string | null;
  extension: string;
}
