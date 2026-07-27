/**
 * Fixture: `ui-fixture-qs` appears only as a querySelector argument and must
 * NOT be picked up as a kit identity.
 */
export function QuerySelector() {
  const el = typeof document !== 'undefined' ? document.querySelector('.ui-fixture-qs') : null
  return <div>{el ? 'found' : 'not found'}</div>
}
