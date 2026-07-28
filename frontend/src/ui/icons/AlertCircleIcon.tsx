import type { Component } from 'solid-js'

/**
 * Exclamation in a circle — Lucide `circle-alert` under ISC.
 * Uses currentColor so it follows the container's text colour.
 */
const AlertCircleIcon: Component = () => (
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
    <circle cx="12" cy="12" r="10" />
    <path d="M12 8v4" />
    <path d="M12 16h.01" />
  </svg>
)

export default AlertCircleIcon
