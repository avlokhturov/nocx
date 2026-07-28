import type { Component } from 'solid-js'

/**
 * Power plug — Lucide `plug` under ISC.
 *
 * Chosen over a play triangle or an arrow for the connect action: a triangle
 * says "run this", an arrow says "go there", and neither is what opening an
 * SSH session is. Uses currentColor so it follows the container's text colour.
 */
const PlugIcon: Component = () => (
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
    <path d="M12 22v-5" />
    <path d="M9 8V2" />
    <path d="M15 8V2" />
    <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
  </svg>
)

export default PlugIcon
