import type { Component } from 'solid-js'

/**
 * Symlink to a file — Lucide `file-symlink` under ISC.
 * The file tree's symlink glyph: a file with a fold-back arrow, for links to
 * files, broken links and cyclic links. A symlink into a directory is a
 * folder in the tree (it expands and lists) and gets the folder glyphs.
 * Uses currentColor so it follows the container's text colour.
 */
const FileSymlinkIcon: Component = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M4 11V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h7" />
    <path d="M14 2v5a1 1 0 0 0 1 1h5" />
    <path d="m10 18 3-3-3-3" />
  </svg>
)

export default FileSymlinkIcon
