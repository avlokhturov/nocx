/**
 * Fixture: the string `ui-fixture-comment` appears only in this JSDoc block
 * and must NOT be picked up as a kit identity.
 *
 * If the scanner finds it, either it is running a regex over raw source or
 * it is parsing comments as JSX — both are bugs.
 */
export function CommentOnly() {
  return <div>no ui- classes on elements here</div>
}
