// What is being dragged around the strip, said on the wire of the drag itself.
//
// TWO OBJECTS SHARE ONE RAIL — a tab row and a workspace heading — and a drop
// target has to know which one is coming before it offers to take it. The
// DataTransfer withholds its DATA during a dragover (the browser hands it over
// only at the drop, so a page cannot read what is being dragged over it), but
// it always exposes the list of TYPES. So the type is the question a target
// can ask while the drag is in flight, and that is what these are for.
//
// Without them every tab row lit its insertion line for a workspace being
// dragged past it and then did nothing when it landed — an offer the strip
// could not honour, which is the one thing a drop mark must never be.

/** A tab row is being dragged; the payload is its pane id. */
export const TAB_DRAG_TYPE = 'application/x-nocx-tab'

/** A workspace heading is being dragged; the payload is its workspace id. */
export const WORKSPACE_DRAG_TYPE = 'application/x-nocx-workspace'
