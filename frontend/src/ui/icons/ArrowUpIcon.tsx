import type { Component } from 'solid-js'

/**
 * Upward arrow — Lucide `arrow-up` under ISC.
 * Uses currentColor so it follows the container's text colour.
 */
const ArrowUpIcon: Component = () => (
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
    <path d="m5 12 7-7 7 7" />
    <path d="M12 19V5" />
  </svg>
)

export default ArrowUpIcon
