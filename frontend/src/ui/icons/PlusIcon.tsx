import type { Component } from 'solid-js'

/**
 * Plus sign — Lucide `plus` under ISC.
 * Uses currentColor so it follows the container's text colour.
 */
const PlusIcon: Component = () => (
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
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </svg>
)

export default PlusIcon
