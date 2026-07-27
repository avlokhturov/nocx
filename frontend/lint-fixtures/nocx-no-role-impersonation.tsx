/* Negative fixture for nocx/no-role-impersonation.

   Every element in the first group MUST be reported, and gate.sh asserts it. A rule
   nobody has watched fail is indistinguishable from a rule that does nothing — which
   is precisely the failure this family of gates exists to catch, and which the kit
   migration found three times in code that looked clean. */

export function Impersonators() {
  return (
    <div>
      {/* A control hand-rolled from a neutral element. It satisfies no-raw-controls —
          there is no <button> anywhere here — and defeats the kit completely. */}
      <div role="button" onClick={() => {}}>
        Save
      </div>
      <span role="checkbox" aria-checked="false" />
      <span role="radio" aria-checked="false" />
      <div role="switch" aria-checked="true" />
      <div role="textbox" />
      <div role="searchbox" />
      <div role="combobox" />

      {/* NOT reported, deliberately. `option` and `listbox` are composite domain
          semantics that no kit primitive replaces: a native <select> is not an
          arbitrary list row, and forbidding the role would push quick-connect toward
          worse markup. If these ever start being reported, the rule has over-reached
          and the fixture is where that shows up. */}
      <div role="option">quick-connect row</div>
      <div role="listbox" />
    </div>
  )
}
