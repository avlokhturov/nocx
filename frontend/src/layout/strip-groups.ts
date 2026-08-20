// groupStrip — how the strip draws headings, with the AXIS as an input
// (nocx-isoph.5; workspaces UX design §4.2 and §4.3, tabs/panes design §9).
//
// ONE MECHANISM, SEVERAL AXES, AND THAT IS THE WHOLE REASON THIS IS A MODULE.
// Three sets of work want to cut the same strip: this bead cuts it by
// WORKSPACE, nocx-jv3q.1 cuts it by the surface type of the pane, and design
// §9 adds project, host, worktree and branch — "ways of drawing the flat
// list, not objects". A hard-coded workspace heading that jv3q.1 then forks
// is the AD-8 defect in advance, so the heading rule arrives as a parameter
// and the only thing here is the cut.
//
// THIS DECIDES NO ORDER. Rows are drawn in the order they arrive — which is
// the backend's, through stripOrder and lineageOrder — and the groups come
// out in the order their first row does. A grouping function that also sorted
// would be a second owner of the strip's order, which is the fact
// nocx-isoph.4 spent itself moving into the backend.
//
// A HEADING OF null IS A GROUP THAT DRAWS NONE, and it is not the same as an
// empty string: the default workspace's rows are top-level rows with no
// header at all (§4.2), so its group is a cut with nothing above it.

/**
 * How one axis cuts the strip.
 *
 * `heading` is handed ONE key and nothing else — not the set of groups, not a
 * count, not the other keys. That signature is what makes "the default
 * workspace never renders" a property rather than a branch somebody has to
 * remember: there is no way to write "…unless it is the only one", which is
 * the rule the owner withdrew in discussion (§4.2) because it makes the whole
 * chrome appear and disappear on a counter and forces the default to acquire
 * a name nobody gave it.
 */
export interface GroupAxis<Row> {
  /** Which group a row belongs to. */
  key: (row: Row) => string
  /** What to write above that group, or null for a group with no heading. */
  heading: (key: string) => string | null
}

/** One cut of the strip: the rows that share a key, and what stands above
 *  them. */
export interface StripGroup<Row> {
  readonly key: string
  readonly heading: string | null
  readonly rows: Row[]
}

/**
 * Cut `rows` by `axis`, preserving their order inside each group and taking
 * the group order from where each group's first row sits.
 */
export function groupStrip<Row>(rows: readonly Row[], axis: GroupAxis<Row>): StripGroup<Row>[] {
  const groups: StripGroup<Row>[] = []
  const byKey = new Map<string, StripGroup<Row>>()
  for (const row of rows) {
    const key = axis.key(row)
    let group = byKey.get(key)
    if (!group) {
      group = { key, heading: axis.heading(key), rows: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    group.rows.push(row)
  }
  return groups
}

/** The workspace a row is in, however the caller's row type carries it. */
export type WorkspaceOf<Row> = (row: Row) => string

/** What this axis needs to know about a workspace: nothing but its identity
 *  and what the user called it. */
export interface NamedWorkspace {
  readonly id: string
  readonly name: string
}

/**
 * The workspace axis: a named workspace heads its group, and the default
 * workspace heads nothing.
 *
 * THE DEFAULT'S STORED NAME IS NEVER READ. The row exists in the database and
 * has a name there; the product's default workspace has none (§4.2), so this
 * function answers null for it before it ever looks the name up. That is the
 * single place the rule lives — the chip and the switcher ask this module
 * rather than each testing the id themselves.
 *
 * A key with no workspace behind it also heads nothing. A heading invented
 * for a workspace whose row has not arrived would be a name the user never
 * gave, which is the same defect wearing a different hat.
 */
export function workspaceAxis<Row>(
  workspaces: readonly NamedWorkspace[],
  defaultWorkspaceId: string,
  workspaceOf: WorkspaceOf<Row>,
): GroupAxis<Row> {
  return {
    key: workspaceOf,
    heading: (key) => (key === defaultWorkspaceId ? null : workspaceName(workspaces, key)),
  }
}

/** What the user called a workspace, or null when nothing here knows. */
function workspaceName(workspaces: readonly NamedWorkspace[], id: string): string | null {
  const name = workspaces.find((w) => w.id === id)?.name?.trim()
  return name ? name : null
}
