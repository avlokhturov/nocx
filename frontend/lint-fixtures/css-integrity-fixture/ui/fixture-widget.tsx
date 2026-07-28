/* Kit component for the rule-3 fixture. Rule 3 keys off the identity set the AST
   scanner derives from the components' own JSX, so the fixture needs a component to
   derive it FROM — a hard-coded list in the checker would be the prefix test the
   design rules out, dressed differently.

   `fixture-widget` is deliberately outside the `ui-` namespace: it proves the rule
   follows what a component renders rather than what a class is called. */

export function FixtureWidget() {
  return (
    <div class="fixture-widget">
      <span class="fixture-widget__label">Label</span>
      <svg viewBox="0 0 24 24" />
    </div>
  )
}
