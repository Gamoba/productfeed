'use client'

import { useState } from 'react'
import { MasterFieldEditor, type MasterEditorFeed } from '@/app/mapping/MappingClient'
import { Popover } from '@/app/components/shell/Popover'
import { describeMapping } from '@/lib/activity'
import { saveMasterFieldAction, deleteMasterFieldAction } from './actions'
import './master-fields.css'

export type MasterRow = {
  key: string
  name: string
  description: string | null
  mapping_type: string
  config: Record<string, unknown>
  usedBy: string[]
}

type Draft = { key: string | null; name: string; description: string; state: { type: string; config: Record<string, unknown> } }

const feedsText = (n: number) => (n === 1 ? '1 feed' : '{n} feeds'.replace('{n}', String(n)))

export function MasterFieldsClient({ projectId, initial, feeds }: { projectId: string; initial: MasterRow[]; feeds: MasterEditorFeed[] }) {
  // The list is local state, changed at once on save and delete (optimistic);
  // the server answer then confirms it, or the list goes back as it was.
  const [rows, setRows] = useState<(MasterRow & { saving?: boolean })[]>(initial)
  // Fresh server data (a later visit, another tab) replaces the local list.
  const [seen, setSeen] = useState(initial)
  if (seen !== initial) {
    setSeen(initial)
    setRows(initial)
  }
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Key of the row whose delete is waiting for a second click.
  const [confirming, setConfirming] = useState<string | null>(null)
  const feedLabel = new Map(feeds.map((f) => [f.id, f.label]))

  function edit(m: MasterRow | null) {
    setError(null)
    setNotice(null)
    setDraft(
      m
        ? { key: m.key, name: m.name, description: m.description ?? '', state: { type: m.mapping_type, config: m.config } }
        : { key: null, name: '', description: '', state: { type: 'FIELD', config: {} } }
    )
  }

  function save() {
    if (!draft) return
    const d = draft
    const before = rows
    const prev = d.key ? rows.find((r) => r.key === d.key) : undefined
    const tmpKey = d.key ?? `__new_${Date.now()}`
    const optimistic = {
      key: tmpKey,
      name: d.name.trim(),
      description: d.description.trim() || null,
      mapping_type: d.state.type,
      config: d.state.config,
      usedBy: prev?.usedBy ?? [],
      saving: true,
    }
    setRows((cur) =>
      d.key
        ? cur.map((r) => (r.key === d.key ? optimistic : r))
        : [...cur, optimistic].sort((a, b) => a.name.localeCompare(b.name))
    )
    setDraft(null)
    setError(null)
    setNotice(null)
    const undo = (message: string) => {
      setRows(before)
      setDraft(d)
      setError(message)
    }
    saveMasterFieldAction(projectId, {
      key: d.key,
      name: d.name,
      description: d.description,
      mapping_type: d.state.type,
      config: d.state.config,
    })
      .then((r) => {
        if (r.error) return undo(r.error)
        setRows((cur) => cur.map((x) => (x.key === tmpKey ? { ...x, key: r.key ?? x.key, saving: false } : x)))
        if (r.warnings?.length) setNotice(r.warnings.join(' '))
      })
      .catch(() => undo('Kunne ikke nå serveren. Intet blev ændret.'))
  }

  function remove(m: MasterRow) {
    setConfirming(null)
    setError(null)
    // In use: the server refuses and says by how many feeds; nothing to hide.
    if (m.usedBy.length > 0) {
      deleteMasterFieldAction(projectId, m.key)
        .then((r) => r.error && setError(r.error))
        .catch(() => setError('Kunne ikke nå serveren. Intet blev ændret.'))
      return
    }
    const before = rows
    setRows((cur) => cur.filter((r) => r.key !== m.key))
    deleteMasterFieldAction(projectId, m.key)
      .then((r) => {
        if (r.error) {
          setRows(before)
          setError(r.error)
        }
      })
      .catch(() => {
        setRows(before)
        setError('Kunne ikke nå serveren. Intet blev ændret.')
      })
  }

  return (
    <div className="mf">
      <div className="mf-head">
        <div>
          <h1>Master fields</h1>
          <p className="mf-lede">Regler, der sættes op én gang på shoppen og bruges af alle feeds på tværs af lande og kanaler. Ret et master field, og alle feeds, der bruger det, følger med.</p>
        </div>
        {!draft && (
          <button type="button" className="wl-btn-primary" onClick={() => edit(null)}>
            + Nyt master field
          </button>
        )}
      </div>

      {error && <p className="note warn" role="alert">{error}</p>}
      {notice && !error && <p className="note" role="status">{notice}</p>}

      {draft && (
        <section className="card mf-form" aria-label={draft.key ? 'Redigér master field' : 'Nyt master field'}>
          <h3>{draft.key ? 'Redigér master field' : 'Nyt master field'}</h3>
          <div className="mf-fields">
            <label>
              <span>Navn</span>
              <input className="ff-input" value={draft.name} placeholder="fx Titel med størrelse" maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label>
              <span>Beskrivelse</span>
              <input className="ff-input" value={draft.description} placeholder="Hvad det bruges til (valgfrit)" onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </label>
            {draft.key && (
              <label>
                <span>Reference i mappings</span>
                <code className="mf-key">master:{draft.key}</code>
              </label>
            )}
          </div>
          <MasterFieldEditor
            projectId={projectId}
            masters={rows.map((m) => ({ key: m.key, name: m.name, mapping_type: m.mapping_type, config: m.config }))}
            editKey={draft.key}
            name={draft.name}
            state={draft.state as never}
            onChange={(st) => setDraft({ ...draft, state: st })}
            feeds={feeds}
          />
          {feeds.length === 0 && <p className="mf-muted">Tilføj et feed for at se reglen på rigtige varer.</p>}
          <div className="mf-actions">
            <button type="button" className="wl-btn-secondary" onClick={() => setDraft(null)}>
              Annullér
            </button>
            <button type="button" className="wl-btn-primary" onClick={save}>
              Gem master field
            </button>
          </div>
        </section>
      )}

      {rows.length === 0 ? (
        !draft && (
          <section className="card mf-empty">
            <h3>Ingen master fields endnu</h3>
            <p>Lav et til en regel, flere feeds deler, fx en titel bygget af brand, navn og størrelse. I Mapping vælger du typen “Master field” eller bruger det som kilde.</p>
            <button type="button" className="wl-btn-primary" onClick={() => edit(null)}>
              + Nyt master field
            </button>
          </section>
        )
      ) : (
        <section className="card flush">
          <table className="mf-table">
            <thead>
              <tr>
                <th>Master field</th>
                <th>Regel</th>
                <th>Bruges i</th>
                <th aria-label="Redigér" />
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.key}>
                  <td>
                    <b>{m.name}</b>
                    <small>{m.saving ? 'Gemmer…' : m.description || `master:${m.key}`}</small>
                  </td>
                  <td>{describeMapping(m.mapping_type, m.config)}</td>
                  <td>
                    {m.usedBy.length === 0 ? (
                      <span className="mf-muted">Bruges ikke endnu</span>
                    ) : (
                      <span title={m.usedBy.map((id) => feedLabel.get(id) ?? id).join('\n')}>{feedsText(m.usedBy.length)}</span>
                    )}
                  </td>
                  <td className="mf-act">
                    {confirming === m.key ? (
                      <span className="mf-confirm" role="group" aria-label={'Slet master fieldet "{name}"? Det kan ikke fortrydes.'.replace('{name}', m.name)}>
                        <span>Slet?</span>
                        <button type="button" className="link" onClick={() => setConfirming(null)} disabled={!!m.saving}>
                          Annullér
                        </button>
                        <button type="button" className="link neg" onClick={() => remove(m)} disabled={!!m.saving}>
                          Slet
                        </button>
                      </span>
                    ) : (
                    <>
                    <button type="button" className="link" onClick={() => edit(m)} disabled={!!m.saving}>
                      Redigér
                    </button>
                    <Popover label={`Flere handlinger for ${m.name}`} align="right" triggerClassName="mf-more" trigger={<span aria-hidden="true">⋯</span>}>
                      {(close) => (
                        <button
                          type="button"
                          role="menuitem"
                          className="shell-menu-item neg"
                          onClick={() => {
                            close()
                            setConfirming(m.key)
                          }}
                        >
                          Slet
                        </button>
                      )}
                    </Popover>
                    </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <p className="mf-muted mf-foot">Et feed bruger et master field med mapping-typen “Master field” eller som kilde i Field, Combine og regler. Feedets egne regler og formatering gælder stadig ovenpå.</p>
    </div>
  )
}
