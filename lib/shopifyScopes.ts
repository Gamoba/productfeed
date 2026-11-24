// Which Shopify access scopes this app needs, and what breaks without each one.
//
// The app is strictly read-only (see AGENTS.md), so every scope here is a read
// scope. They live in one place because the same list drives three things: the
// warning shown right after connecting, the warning shown on the project page
// afterwards, and the text a developer reads when wondering why a feed is full
// of raw Shopify IDs.
//
// `impact` is written for the person who has to fix it — what they will SEE go
// wrong, not the name of the API call that fails.

export type ScopeRequirement = {
  handle: string
  // false = the connection still works, but some capability is degraded.
  required: boolean
  impact: string
}

export const SHOPIFY_SCOPES: ScopeRequirement[] = [
  {
    handle: 'read_products',
    required: true,
    impact: 'Varerne kan slet ikke synkroniseres.',
  },
  {
    handle: 'read_metaobjects',
    required: false,
    impact:
      'Metaobject-felter (region, drue, land …) viser et Shopify-id i stedet for værdien.',
  },
  {
    handle: 'read_markets',
    required: false,
    impact: 'Markeder kan ikke hentes, når du opretter et feed.',
  },
  {
    handle: 'read_translations',
    required: false,
    impact: 'Oversatte titler og beskrivelser hentes ikke til feeds på andre sprog.',
  },
]

export type MissingScope = ScopeRequirement

// The scopes we want that this token does not have.
//
// An EMPTY granted list means we could not read the scopes, not that none are
// granted — reporting everything as missing there would be a false alarm, so
// callers treat an empty list as "unknown" and skip the check.
export function missingScopes(granted: string[]): MissingScope[] {
  if (granted.length === 0) return []
  return SHOPIFY_SCOPES.filter((s) => !granted.includes(s.handle))
}
