import type { Component } from 'solid-js'

/**
 * Downward arrow — Lucide `arrow-down` under ISC.
 * Uses currentColor so it follows the container's text colour.
 */
const ArrowDownIcon: Component = () => (
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
    <path d="M12 5v14" />
    <path d="m19 12-7 7-7-7" />
  </svg>
)

export default ArrowDownIcon
