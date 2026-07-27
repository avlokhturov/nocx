/**
 * Fixture: class from a function call — must be reported as undetermined.
 * The scanner must not guess that `labelClass()` returns any specific class.
 */
export function UndeterminedClass() {
  const labelClass = () => (Math.random() > 0.5 ? 'ui-fixture-unknown' : '')
  return <label class={labelClass()}>dynamic</label>
}
