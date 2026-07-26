// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@solidjs/testing-library'
import { Hello } from './hello'

describe('Hello', () => {
  it('renders the greeting', () => {
    render(() => <Hello name="World" />)
    expect(screen.getByText('Hello, World!')).toBeTruthy()
  })

  it('renders a different name', () => {
    render(() => <Hello name="Solid" />)
    expect(screen.getByText('Hello, Solid!')).toBeTruthy()
  })
})
