/**
 * Bring the run up: the disk floor, then the stand.
 *
 * Order matters. preflight refuses to start on a filesystem too full to
 * survive a run, and there is no point building a backend to discover that.
 */
import preflight from './preflight'
import { startStand } from './stand'

export default async function globalSetup(): Promise<void> {
  preflight()
  const stand = await startStand()
  // Printed, not silent: when a run is inspected afterwards the first question
  // is which backend it drove, and the answer should be in the log rather than
  // only in a file somebody has to know about.
  console.log(`e2e stand: backend 127.0.0.1:${stand.port}, home ${stand.home}`)
}
