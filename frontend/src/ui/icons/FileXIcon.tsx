import type { Component } from 'solid-js'

/**
 * Unreadable file — Lucide `file-x` under ISC.
 * The file tree's `unreadable` glyph: the entry exists but its metadata could
 * not be read (permission denied), so it is a file that cannot be opened.
 * Uses currentColor so it follows the container's text colour.
 */
const FileXIcon: Component = () => (
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
    <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
    <path d="M14 2v5a1 1 0 0 0 1 1h5" />
    <path d="m14.5 12.5-5 5" />
    <path d="m9.5 12.5 5 5" />
  </svg>
)

export default FileXIcon
