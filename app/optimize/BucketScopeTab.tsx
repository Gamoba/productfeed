'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  getBucketCandidates,
  getBucketOverlap,
  getBucketMembership,
  getBucketFilters,
  getFeedMetafields,
  saveBucketFilters,
  setBucketMembership,
  getBucketManualProducts,
  addManualBucketProducts,
  removeManualBucketProduct,
  searchFeedProducts,
} from './actions'
import { FilterSection, defaultRule, NO_VALUE_OPS, type MetafieldOption } from '@/app/components/FilterEditor'
import { ScopeProductPanel } from './ScopeProductPanel'
import type { FilterRule, FilterConfig } from '@/app/filters/actions'
import type { BucketConflict } from '@/lib/optimizationBuckets'

type OverlapData = { conflicts: BucketConflict[]; inThisBucket: number; unassigned: number }

// Same words as the Results tab (BucketResultsPanel).
const STATUS_LABEL: Record<string, string> = {
  ai_generated: 'Optimeret',
  human_edited: 'Rettet i hånden',
  needs_review: 'Til godkendelse',
  not_optimized: 'Ikke optimeret',
}

// Membership for a candidate set = all candidates except the conflicts the user
// chose to LEAVE in their current bucket. Pure (no component state) so it can be
// reused by the debounced auto-save and the pull-in toggles without re-renders.
function membershipRefs(cands: string[], ov: OverlapData, pull: Set<string>): string[] {
  const leave = new Set(ov.conflicts.filter((c) => !pull.has(c.product_ref)).map((c) => c.product_ref))
  return cands.filter((r) => !leave.has(r))
}

// A rule is "ready" (genuinely fillable, not half-built) when its field is chosen
// AND it either takes no value or has one. The two genuinely-incomplete states:
//   - field === '' or the bare 'metafield:' placeholder (no metafield picked yet)
//   - a value-taking operator with an empty value
// Crucially, a CONCRETE metafield field (e.g. 'metafield:custom.drue') IS ready —
// the readiness check works off these two conditions only, NOT off membership in
// the standard FILTER_FIELDS list (which never contains metafield tokens, so
// checking against it would wrongly mark every metafield rule incomplete). Mirrors
// lib/feedFilters' active-rule predicate so the client agrees with the server.
function ruleIsReady(r: FilterRule): boolean {
  if (!r.field || r.field === 'metafield:') return false
  return NO_VALUE_OPS.has(r.operator) || r.value.trim() !== ''
}

export function BucketScopeTab({
  feedId,
  bucketId,
  initialInclude,
  initialExclude,
}: {
  feedId: string
  bucketId: string
  initialInclude: FilterConfig
  initialExclude: FilterConfig
}) {
  const [include, setInclude] = useState<FilterConfig>(initialInclude)
  const [exclude, setExclude] = useState<FilterConfig>(initialExclude)

  // Feed's actual metafields → the scope filter's metafield dropdown (pick from
  // what exists instead of typing namespace.key). Undefined until loaded; while
  // undefined the editor falls back to its free-text metafield input.
  const [metafields, setMetafields] = useState<MetafieldOption[] | undefined>(undefined)
  useEffect(() => {
    getFeedMetafields(feedId).then((r) => {
      if ('data' in r) setMetafields(r.data)
    })
  }, [feedId])

  const [candidates, setCandidates] = useState<string[] | null>(null)
  const [overlap, setOverlap] = useState<OverlapData | null>(null)
  const [pullIn, setPullIn] = useState<Set<string>>(new Set())
  // The bucket's saved membership count, read straight from the DB on entry so the
  // count shows INSTANTLY without the heavy candidate recompute. Used for display
  // until (and unless) the user changes the criteria, which triggers a live recompute.
  const [savedCount, setSavedCount] = useState<number | null>(null)

  // Manual additions (source='manual') — additive to the filter, surviving filter
  // changes. Committed immediately (with the same overlap warning the filter uses).
  const [manual, setManual] = useState<{ product_ref: string; title: string }[]>([])
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<{ product_ref: string; title: string; vendor: string | null; image_url: string | null }[]>([])
  const [searching, setSearching] = useState(false)
  const [addBusy, setAddBusy] = useState<string | null>(null)
  const [pendingConflict, setPendingConflict] = useState<{ ref: string; title: string; bucketName: string } | null>(null)

  const manualRefs = useMemo(() => new Set(manual.map((m) => m.product_ref)), [manual])

  // Load the bucket's manual products on mount.
  useEffect(() => {
    getBucketManualProducts(feedId, bucketId).then((r) => {
      if ('data' in r) setManual(r.data)
    })
  }, [feedId, bucketId])

  // Debounced product search for the manual-add picker.
  useEffect(() => {
    const q = search.trim()
    // Clearing the results for an empty query, and switching the spinner on for a
    // non-empty one, happen in the input's onChange (not synchronously in here).
    if (!q) return
    let cancelled = false
    const t = setTimeout(async () => {
      const r = await searchFeedProducts(feedId, q)
      if (cancelled) return
      if ('data' in r) setResults(r.data)
      setSearching(false)
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [search, feedId])

  async function refreshManual() {
    const r = await getBucketManualProducts(feedId, bucketId)
    if ('data' in r) setManual(r.data)
  }

  // Add flow: run the SAME overlap check the filter uses. If the product belongs
  // to another bucket, require a deliberate confirm (move) before committing.
  async function attemptAdd(ref: string, title: string) {
    setError(null)
    setAddBusy(ref)
    const ov = await getBucketOverlap(feedId, bucketId, [ref])
    if ('error' in ov) {
      setError(ov.error)
      setAddBusy(null)
      return
    }
    const conflict = ov.data.conflicts[0]
    if (conflict) {
      setPendingConflict({ ref, title, bucketName: conflict.bucketName })
      setAddBusy(null)
      return
    }
    await commitAdd(ref)
    setAddBusy(null)
  }
  async function commitAdd(ref: string) {
    const r = await addManualBucketProducts(feedId, bucketId, [ref])
    if (r.error) setError(r.error)
    else await refreshManual()
    setPendingConflict(null)
  }
  async function removeManual(ref: string) {
    setError(null)
    const r = await removeManualBucketProduct(feedId, bucketId, ref)
    if (r.error) setError(r.error)
    else setManual((prev) => prev.filter((m) => m.product_ref !== ref))
  }

  const [error, setError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  // True while a criteria change is being recomputed (candidate match + overlap) —
  // drives the "Searching…" indicator on the count so a change shows visible work.
  const [recomputing, setRecomputing] = useState(false)

  // The criteria we last persisted, serialized. Comparing the live criteria against
  // this distinguishes a real edit from a mount / re-render / Strict-Mode remount,
  // so we only save on genuine changes and never spuriously re-commit membership
  // just from re-entering the bucket. Seeded with the criteria loaded from the
  // server, so a fresh mount is, correctly, "unchanged".
  const lastSavedRef = useRef(JSON.stringify({ include: initialInclude, exclude: initialExclude }))

  // Re-read the SAVED criteria on mount. The page-load props (initialInclude/
  // Exclude) are fetched once server-side; after an auto-save WITHOUT a full reload
  // (e.g. switching to Examples and back, which unmounts/remounts this tab) those
  // props are stale, so returning to Scope would show the old/empty rules. Reading
  // the DB here repopulates the rule UI with whatever was last persisted. We sync
  // lastSavedRef to the fetched value so this load is treated as "unchanged" and
  // does NOT trigger a spurious re-save/recompute.
  useEffect(() => {
    let cancelled = false
    getBucketFilters(feedId, bucketId).then((r) => {
      if (cancelled || !('data' in r)) return
      lastSavedRef.current = JSON.stringify({ include: r.data.include, exclude: r.data.exclude })
      setInclude(r.data.include)
      setExclude(r.data.exclude)
    })
    return () => {
      cancelled = true
    }
  }, [feedId, bucketId])

  // Instant count on entry: read the saved membership directly (a cheap id-only read
  // of bucket_products) and show it immediately — no candidate recompute round-trip.
  // The numbers are already in the DB; just show them. The auto-save effect below
  // only does the heavy recompute when the criteria actually change.
  useEffect(() => {
    let cancelled = false
    getBucketMembership(feedId, bucketId).then((r) => {
      if (cancelled) return
      if ('data' in r) setSavedCount(r.data.length)
    })
    return () => {
      cancelled = true
    }
  }, [feedId, bucketId])

  // Every rule edit shows the "thinking" indicator IMMEDIATELY (before the 500ms
  // debounce + the server recompute), so the user sees it checking right away — not
  // only during the (often brief) server call. The effect clears it when done.
  function addRule(t: 'include' | 'exclude') {
    setRecomputing(true)
    ;(t === 'include' ? setInclude : setExclude)((p) => ({ ...p, rules: [...p.rules, defaultRule()] }))
  }
  function removeRule(t: 'include' | 'exclude', i: number) {
    setRecomputing(true)
    ;(t === 'include' ? setInclude : setExclude)((p) => ({ ...p, rules: p.rules.filter((_, j) => j !== i) }))
  }
  function updateRule(t: 'include' | 'exclude', i: number, patch: Partial<FilterRule>) {
    setRecomputing(true)
    ;(t === 'include' ? setInclude : setExclude)((p) => ({ ...p, rules: p.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) }))
  }
  function setOp(t: 'include' | 'exclude', op: 'AND' | 'OR') {
    setRecomputing(true)
    ;(t === 'include' ? setInclude : setExclude)((p) => ({ ...p, operator: op }))
  }

  // Auto-save — runs ONLY when the criteria actually change. Opening a bucket with
  // unchanged criteria does no work here (the saved count is already shown instantly
  // by the membership read above), so entering/leaving a bucket is fast. On a real
  // change it debounces 500ms, refreshes the live count/overlap, and — when the
  // criteria are in an applyable state — persists the filter + commits membership.
  // Reuses the exact functions the old two-button flow used.
  useEffect(() => {
    const key = JSON.stringify({ include, exclude })
    const unchanged = key === lastSavedRef.current
    // Skip the SAVE (not the count refresh) while any rule is still half-built — no
    // field chosen, or a value-taking operator with no value. This is the guard's
    // ONLY job; a complete rule like a metafield "drue = Riesling" is ready and
    // saves normally. An empty rule set (no rules at all) is applyable = whole feed.
    const unresolved =
      !unchanged &&
      (include.rules.some((r) => !ruleIsReady(r)) || exclude.rules.some((r) => !ruleIsReady(r)))

    let cancelled = false
    const t = setTimeout(async () => {
      // Unchanged (mount, or a revert back to the saved criteria): clear any pending
      // thinking state and do no work — the saved count already shows.
      if (unchanged) {
        setRecomputing(false)
        return
      }
      // Keep the in-flight indicator on through the server recompute (already turned
      // on by the edit handler); cleared at every non-cancelled exit below.
      setRecomputing(true)
      // Live count/overlap tracks the changed criteria (the server ignores
      // unresolved rules, same as the feed Filters page).
      const c = await getBucketCandidates(feedId, include, exclude)
      if (cancelled) return
      if ('error' in c) {
        setError(c.error)
        if (!unresolved) setSaveState('error')
        setRecomputing(false)
        return
      }
      const ov = await getBucketOverlap(feedId, bucketId, c.data)
      if (cancelled) return
      if ('error' in ov) {
        setError(ov.error)
        if (!unresolved) setSaveState('error')
        setRecomputing(false)
        return
      }
      setCandidates(c.data)
      setOverlap(ov.data)
      setPullIn(new Set()) // default: leave conflicts in their current bucket
      setRecomputing(false)

      if (unresolved) return
      setSaveState('saving')
      setError(null)
      const f = await saveBucketFilters(feedId, bucketId, include, exclude)
      if (cancelled) return
      if (f.error) {
        setError(f.error)
        setSaveState('error')
        return
      }
      const refs = membershipRefs(c.data, ov.data, new Set())
      const m = await setBucketMembership(feedId, bucketId, refs)
      if (cancelled) return
      if (m.error) {
        setError(m.error)
        setSaveState('error')
        return
      }
      lastSavedRef.current = key // mark these criteria persisted
      setSavedCount(refs.length) // keep the instant-entry count in sync with what we saved
      setSaveState('saved')
    }, unchanged ? 0 : 500)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [include, exclude, feedId, bucketId])

  // The membership currently saved for this bucket (drives the count shown).
  const finalRefs = useMemo(() => {
    if (!candidates || !overlap) return []
    return membershipRefs(candidates, overlap, pullIn)
  }, [candidates, overlap, pullIn])

  // A deliberate pull-in choice is a move between buckets, so it commits
  // immediately (not on the criteria debounce).
  async function commitMembership(refs: string[]) {
    setSaveState('saving')
    setError(null)
    const m = await setBucketMembership(feedId, bucketId, refs)
    if (m.error) {
      setError(m.error)
      setSaveState('error')
    } else {
      setSaveState('saved')
    }
  }

  function togglePull(ref: string) {
    if (!candidates || !overlap) return
    const next = new Set(pullIn)
    if (next.has(ref)) next.delete(ref)
    else next.add(ref)
    setPullIn(next)
    commitMembership(membershipRefs(candidates, overlap, next))
  }

  // Bulk pull-in toggle for the overlap list — every conflict at once, then the
  // user can still fine-tune individual rows.
  const allPulledIn = !!overlap && overlap.conflicts.length > 0 && overlap.conflicts.every((c) => pullIn.has(c.product_ref))
  function togglePullAll() {
    if (!candidates || !overlap) return
    const next = allPulledIn ? new Set<string>() : new Set(overlap.conflicts.map((c) => c.product_ref))
    setPullIn(next)
    commitMembership(membershipRefs(candidates, overlap, next))
  }

  // Count to show: the live recomputed candidate count once the user has changed
  // criteria, otherwise the instantly-loaded saved membership count.
  const displayCount = candidates !== null ? candidates.length : savedCount

  return (
    <div className="space-y-4">
      {/* Step heading — title + intro, then the live match count as part of the
          header. The count shows an inline thinking state while it recomputes; the
          discreet Saving…/Saved ✓ status sits top-right. */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--accent-ink)' }}>
            Scope
          </div>
          <h2 style={{ fontSize: '20px', fontWeight: 500, color: 'var(--ink)', letterSpacing: '-0.01em', lineHeight: 1.2, marginTop: '3px' }}>
            Vælg varer til bucketen
          </h2>
          <p style={{ fontSize: '12px', color: 'var(--ink-secondary)', lineHeight: 1.5, marginTop: '6px', maxWidth: '52ch' }}>
            Vælg hvilke varer bucketen dækker. Antallet og bucketens varer
            opdateres automatisk, når du ændrer reglerne. Du skal ikke gemme.
          </p>
          <div className="flex items-center gap-2" style={{ marginTop: '10px' }}>
            <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--ink-secondary)' }}>Matchende varer:</span>
            {recomputing || displayCount === null ? (
              // Box styled INLINE (not via a CSS class) so it's visible even if the
              // class were ever absent from the build; it only borrows the keyframe.
              <span
                aria-hidden
                title="Tæller igen…"
                style={{
                  display: 'inline-block',
                  width: '13px',
                  height: '13px',
                  border: '2px solid var(--hairline)',
                  borderTopColor: 'var(--accent-ink)',
                  borderRadius: '50%',
                  animation: 'ff-spin 0.6s linear infinite',
                }}
              />
            ) : (
              <span style={{ fontSize: '16px', fontWeight: 500, color: 'var(--ink)', letterSpacing: '-0.01em' }}>{displayCount.toLocaleString('da-DK')}</span>
            )}
          </div>
        </div>
        <div className="shrink-0 text-right">
          {saveState === 'saving' ? (
            <div style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>Gemmer…</div>
          ) : saveState === 'saved' ? (
            <div style={{ fontSize: '11px', color: 'var(--accent-green)' }}>Gemt ✓</div>
          ) : null}
        </div>
      </div>

      {error && <div style={{ fontSize: '11px', color: 'var(--accent-red)' }}>{error}</div>}

      {/* Two columns: the scope controls on the left, a read-only product-reference
          panel on the right so you can see the data you're filtering against. */}
      <div className="flex flex-col lg:flex-row gap-4 items-start">
        <div className="w-full lg:flex-1 min-w-0 space-y-4">
      <FilterSection
        title="Inkludér varer"
        description="Kun varer, der matcher reglerne, kommer med. Ingen regler betyder alle varer i feedet."
        badge="INKLUDÉR"
        badgeCls="ff-badge ff-badge-success"
        config={include}
        onAddRule={() => addRule('include')}
        onRemoveRule={(i) => removeRule('include', i)}
        onUpdateRule={(i, p) => updateRule('include', i, p)}
        onSetOperator={(op) => setOp('include', op)}
        metafieldOptions={metafields}
      />
      <FilterSection
        title="Ekskludér varer"
        description="Varer, der matcher reglerne, fjernes igen."
        badge="EKSKLUDÉR"
        badgeCls="ff-badge ff-badge-danger"
        config={exclude}
        onAddRule={() => addRule('exclude')}
        onRemoveRule={(i) => removeRule('exclude', i)}
        onUpdateRule={(i, p) => updateRule('exclude', i, p)}
        onSetOperator={(op) => setOp('exclude', op)}
        metafieldOptions={metafields}
      />

      {/* Manual additions — added on top of the filter; survive filter changes. */}
      <div className="ff-panel">
        <div className="ff-panel-header" style={{ textTransform: 'none', letterSpacing: 0, fontSize: '12px', padding: '10px 14px' }}>
          Tilføj varer manuelt
        </div>
        <div className="p-3.5 space-y-2.5">
          <p style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>
            Tilføj bestemte varer oven i reglerne. Manuelt tilføjede varer bliver i bucketen, selv om du ændrer
            reglerne. {manual.length.toLocaleString('da-DK')} tilføjet manuelt.
          </p>

          {pendingConflict && (
            <div
              className="space-y-2"
              style={{ fontSize: '11px', padding: '8px 10px', borderRadius: '6px', background: 'var(--warn-bg)', border: '1px solid var(--accent-amber)' }}
            >
              <div style={{ color: 'var(--accent-amber)' }}>
                “{pendingConflict.title}” ligger allerede i bucketen “{pendingConflict.bucketName}”. Flytter du den hertil,
                fjernes den derfra (en vare kan kun ligge i én bucket).
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => commitAdd(pendingConflict.ref)} className="ff-btn-primary">
                  Flyt hertil
                </button>
                <button onClick={() => setPendingConflict(null)} className="ff-btn-ghost" style={{ fontSize: '11px', padding: '0 8px' }}>
                  Annullér
                </button>
              </div>
            </div>
          )}

          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              if (e.target.value.trim()) setSearching(true)
              else setResults([])
            }}
            placeholder="Søg efter varer på titel eller producent…"
            className="ff-input w-full"
          />

          {searching && <p style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>Søger…</p>}

          {results.length > 0 && (
            <div className="space-y-1" style={{ maxHeight: '260px', overflowY: 'auto' }}>
              {results.map((p) => {
                const added = manualRefs.has(p.product_ref)
                return (
                  <div key={p.product_ref} className="flex items-center gap-2">
                    {p.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.image_url} alt="" loading="lazy" className="w-8 h-8 object-cover shrink-0" style={{ borderRadius: '4px', border: '1px solid var(--hairline)' }} />
                    ) : (
                      <div className="w-8 h-8 shrink-0" style={{ background: 'var(--bg-surface)', borderRadius: '4px' }} />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="truncate" style={{ fontSize: '11px', color: 'var(--ink)' }}>{p.title}</div>
                      {p.vendor && <div className="truncate" style={{ fontSize: '10px', color: 'var(--ink-muted)' }}>{p.vendor}</div>}
                    </div>
                    <button
                      type="button"
                      onClick={() => attemptAdd(p.product_ref, p.title)}
                      disabled={added || addBusy === p.product_ref}
                      className="ff-btn-secondary shrink-0"
                    >
                      {added ? 'Tilføjet' : addBusy === p.product_ref ? 'Tilføjer…' : 'Tilføj'}
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          {manual.length > 0 && (
            <div>
              <label className="ff-label">Tilføjet manuelt ({manual.length.toLocaleString('da-DK')})</label>
              <div className="space-y-1">
                {manual.map((m) => (
                  <div
                    key={m.product_ref}
                    className="flex items-center gap-2"
                    style={{ fontSize: '11px', padding: '4px 8px', border: '1px solid var(--hairline)', borderRadius: '5px' }}
                  >
                    <span className="flex-1 min-w-0 truncate" style={{ color: 'var(--ink)' }} title={m.product_ref}>{m.title}</span>
                    <button type="button" onClick={() => removeManual(m.product_ref)} className="ff-btn-ghost shrink-0 w-5 h-5" aria-label="Fjern manuelt tilføjet vare">×</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {candidates && overlap && (
        <div className="ff-panel">
          <div className="ff-panel-header" style={{ textTransform: 'none', letterSpacing: 0, fontSize: '12px', padding: '10px 14px' }}>
            Match
          </div>
          <div className="p-3.5 space-y-3">
            <div style={{ fontSize: '12px', color: 'var(--ink-secondary)' }}>
              <strong style={{ color: 'var(--ink)' }}>{candidates.length.toLocaleString('da-DK')}</strong> varer matcher.{' '}
              {overlap.inThisBucket.toLocaleString('da-DK')} er allerede i bucketen · {overlap.unassigned.toLocaleString('da-DK')} uden bucket ·{' '}
              <strong style={{ color: overlap.conflicts.length ? 'var(--accent-amber)' : 'inherit' }}>
                {overlap.conflicts.length.toLocaleString('da-DK')}
              </strong>{' '}
              i andre buckets.
              {manual.length > 0 && (
                <>
                  {' '}
                  <span style={{ color: 'var(--ink-muted)' }}>
                    + {manual.length.toLocaleString('da-DK')} manuelt →{' '}
                    <strong style={{ color: 'var(--ink)' }}>
                      {new Set([...candidates, ...manualRefs]).size.toLocaleString('da-DK')}
                    </strong>{' '}
                    i alt.
                  </span>
                </>
              )}
            </div>

            {overlap.conflicts.length > 0 && (
              <div className="space-y-1.5">
                <div style={{ fontSize: '11px', color: 'var(--ink-secondary)' }}>
                  Disse varer ligger allerede i en anden bucket. Sæt flueben for at flytte dem til DENNE bucket
                  (en vare kan kun ligge i én bucket). Uden flueben bliver de, hvor de er:
                </div>
                <button
                  type="button"
                  onClick={togglePullAll}
                  className="ff-btn-ghost"
                  style={{ fontSize: '10px', fontWeight: 500, color: 'var(--accent-ink)', padding: '2px 6px', alignSelf: 'flex-start' }}
                >
                  {allPulledIn ? 'Fravælg alle' : 'Vælg alle'}
                </button>
                <div className="space-y-1" style={{ maxHeight: '280px', overflowY: 'auto' }}>
                  {overlap.conflicts.map((c) => (
                    <label key={c.product_ref} className="flex items-center gap-2" style={{ fontSize: '11px' }}>
                      <input type="checkbox" checked={pullIn.has(c.product_ref)} onChange={() => togglePull(c.product_ref)} />
                      <span style={{ color: 'var(--ink-secondary)' }} title={c.product_ref}>{c.title}</span>
                      <span style={{ color: 'var(--ink-muted)' }}>i “{c.bucketName}”</span>
                      {c.status && (
                        <span className={`ff-badge ${c.status === 'human_edited' ? 'ff-badge-warning' : 'ff-badge-neutral'}`}>
                          {STATUS_LABEL[c.status] ?? c.status}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>
              Bucketen har <strong style={{ color: 'var(--ink)' }}>{finalRefs.length.toLocaleString('da-DK')}</strong>{' '}
              {finalRefs.length === 1 ? 'vare' : 'varer'}. Gemt automatisk.
            </div>
          </div>
        </div>
      )}
        </div>
        <div className="w-full lg:w-1/3 shrink-0">
          <ScopeProductPanel feedId={feedId} bucketId={bucketId} />
        </div>
      </div>
    </div>
  )
}
