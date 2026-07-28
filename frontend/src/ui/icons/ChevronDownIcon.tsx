import type { Component } from 'solid-js'

/**
 * Downward chevron — Lucide `chevron-down` under ISC.
 * Uses currentColor so it follows the container's text colour.
 */
const ChevronDownIcon: Component = () => (
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
    <path d="m6 9 6 6 6-6" />
  </svg>
)

export default ChevronDownIcon
