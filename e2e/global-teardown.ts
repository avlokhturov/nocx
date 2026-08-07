/**
 * Take the stand down and keep its account.
 *
 * Runs whether the suite passed or failed — the backend log is the only record
 * of what the backend actually did, and a failing run is exactly when it is
 * wanted.
 */
import { stopStand } from './stand'

export default async function globalTeardown(): Promise<void> {
  await stopStand()
}
