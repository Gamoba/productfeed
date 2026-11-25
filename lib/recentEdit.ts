// "This feed was just changed" — remembered in the browser tab, so the Overview
// can re-check the feed on its own after a save instead of showing the
// validation from before the change (the background check after a save may not
// have finished yet). Client-only; sessionStorage, so it never leaves the tab.

const KEY = (feedId: string) => `ff:edited:${feedId}`
const MAX_AGE_MS = 10 * 60 * 1000

export function markFeedEdited(feedId: string): void {
  try {
    sessionStorage.setItem(KEY(feedId), String(Date.now()))
  } catch {
    // Private mode / storage blocked: the Overview just shows the stored result.
  }
}

/** True once per edit: reading it clears the mark. */
export function takeFeedEdited(feedId: string): boolean {
  try {
    const at = Number(sessionStorage.getItem(KEY(feedId)))
    sessionStorage.removeItem(KEY(feedId))
    return Number.isFinite(at) && at > 0 && Date.now() - at < MAX_AGE_MS
  } catch {
    return false
  }
}
