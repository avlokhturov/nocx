/**
 * TreeRow's entry vocabulary and the one predicate derived from it.
 *
 * Split out of `tree-row.tsx` so that code which is not a component can ask
 * the same question. Importing the component module pulls Solid's DOM event
 * delegation at load time, which throws outside a DOM environment — the
 * Files store is plain logic and its suite runs in node. The predicate is not
 * a rendering detail, so the split costs nothing and keeps ONE owner: a
 * second copy in the store would agree on every case anyone tried and
 * disagree on the cyclic symlink, where the row draws a leaf and the store
 * would still walk into it.
 *
 * `tree-row.tsx` re-exports both, so the kit's public surface is unchanged.
 */

/** The wire's vocabulary (design §5.1 `Kind`), deliberately: the panel passes
 *  an entry's kind straight through, so there is no mapping layer for a
 *  defect to live in. `other` is a FIFO, socket, device or procfs
 *  pseudo-file; `unreadable` is not a kind of object but a kind of failure —
 *  the entry exists and its metadata could not be read. */
export type TreeRowKind = 'regular' | 'dir' | 'symlink' | 'other' | 'unreadable'

/** A row is expandable from its kind alone: dir, or a symlink into a dir
 *  that is not cyclic. A cyclic symlink is a leaf whatever the caller asks. */
export function isExpandable(kind: TreeRowKind, linkKind?: TreeRowKind, cyclic?: boolean): boolean {
  if (kind === 'dir') return true
  if (kind === 'symlink' && linkKind === 'dir') return !cyclic
  return false
}
