import type { Component } from 'solid-js'

/**
 * Server — Lucide `server` under ISC.
 * The file tree's `other` glyph: a FIFO, socket, device or procfs
 * pseudo-file — the machine's plumbing, which lists but is neither openable
 * nor expandable. Uses currentColor so it follows the container's text colour.
 */
const ServerIcon: Component = () => (
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
    <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
    <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
    <line x1="6" x2="6.01" y1="6" y2="6" />
    <line x1="6" x2="6.01" y1="18" y2="18" />
  </svg>
)

export default ServerIcon
