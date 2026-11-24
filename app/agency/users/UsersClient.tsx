'use client'

import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { AccountUsers, InviteResult, MemberRow } from '@/lib/accountMembers'
import type { AccountRole } from '@/lib/accounts'
import { Icon } from '@/app/components/shell/icons'
import { ROLE_LABEL } from '@/app/components/shell/nav'
import { formatNumber, formatWhen } from '@/lib/formatDa'
import './users.css'

const ROLE_HINT: Record<AccountRole, string> = {
  owner: 'Alt, også at gøre andre til ejer',
  admin: 'Invitere, ændre roller og fjerne brugere',
  member: 'Arbejde i shops og feeds',
}

export function UsersClient({ initial }: { initial: AccountUsers }) {
  const [data, setData] = useState(initial)
  const [inviting, setInviting] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [linkFor, setLinkFor] = useState<{
    email: string
    link: string
  } | null>(null)

  const { account, myRole, me, members } = data
  const manage = myRole === 'owner' || myRole === 'admin'
  const base = `/api/accounts/${account.id}/members`
  const pending = members.filter((m) => !m.lastSignInAt)
  const roles: AccountRole[] = myRole === 'owner' ? ['owner', 'admin', 'member'] : ['admin', 'member']

  async function reload() {
    const res = await fetch(base)
    if (res.ok) setData(await res.json())
  }

  async function call(id: string, url: string, init: RequestInit): Promise<Record<string, unknown> | null> {
    setBusy(id)
    setError(null)
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'Content-Type': 'application/json' },
      })
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) {
        setError((json.error as string) ?? 'Det lykkedes ikke')
        return null
      }
      return json
    } finally {
      setBusy(null)
    }
  }

  async function setRole(m: MemberRow, role: AccountRole) {
    if (
      await call(m.userId, `${base}/${m.userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      })
    )
      await reload()
  }

  async function remove(m: MemberRow) {
    setConfirmRemove(null)
    if (await call(m.userId, `${base}/${m.userId}`, { method: 'DELETE' })) await reload()
  }

  async function newLink(m: MemberRow) {
    const json = await call(m.userId, `${base}/${m.userId}/link`, {
      method: 'POST',
    })
    if (json?.link) setLinkFor({ email: m.email, link: String(json.link) })
  }

  return (
    <div className="au">
      <header className="au-head">
        <div>
          <h1>Agency users</h1>
          <p className="au-lede">
            Hvem på bureauet har adgang til kunderne. Alle her ser de samme shops og feeds i {account.name}.
          </p>
        </div>
        {manage && (
          <button type="button" className="wl-btn-primary" onClick={() => setInviting(true)}>
            <Icon name="plus" size={14} /> Invitér bruger
          </button>
        )}
      </header>

      <section className="card au-stats">
        <div>
          <span>Brugere</span>
          <strong className="num">
            {formatNumber(members.length)}
            {account.seatLimit !== null && <small> / {formatNumber(account.seatLimit)}</small>}
          </strong>
          <small className={account.seatLimit !== null && members.length >= account.seatLimit ? 'neg' : undefined}>
            {account.seatLimit === null
              ? 'Ingen grænse på planen'
              : members.length >= account.seatLimit
                ? 'Alle pladser er brugt'
                : `Planen giver ${formatNumber(account.seatLimit)} pladser`}
          </small>
        </div>
        <div>
          <span>Afventende invitationer</span>
          <strong className="num">{formatNumber(pending.length)}</strong>
          <small>{pending.length === 0 ? 'Ingen lige nu' : 'Har ikke logget ind endnu'}</small>
        </div>
      </section>

      {error && <p className="note warn">{error}</p>}

      <section className="card flush">
        <div className="au-tablewrap">
          <table className="au-table">
            <thead>
              <tr>
                <th>Navn</th>
                <th>E-mail</th>
                <th>Rolle</th>
                <th>Status</th>
                {manage && <th className="r" aria-label="Handlinger" />}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const isMe = m.userId === me
                // Admins can't touch owners; nobody edits themselves here.
                const editable = manage && !isMe && (myRole === 'owner' || m.role !== 'owner')
                return (
                  <tr key={m.userId}>
                    <td>
                      <b className="au-name">{m.name || m.email.split('@')[0]}</b>
                      {isMe && <span className="au-you">dig</span>}
                    </td>
                    <td className="au-muted">{m.email}</td>
                    <td>
                      {editable ? (
                        <select
                          className="au-sel"
                          value={m.role}
                          disabled={busy === m.userId}
                          onChange={(e) => setRole(m, e.target.value as AccountRole)}
                          aria-label={`Rolle for ${m.email}`}
                        >
                          {roles.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        ROLE_LABEL[m.role]
                      )}
                    </td>
                    <td>
                      {m.lastSignInAt ? (
                        <span className="st" title={`Sidst logget ind ${formatWhen(m.lastSignInAt)}`}>
                          Aktiv
                        </span>
                      ) : (
                        <span className="pill ai">Inviteret</span>
                      )}
                    </td>
                    {manage && (
                      <td className="r">
                        <span className="au-acts">
                          {editable && confirmRemove === m.userId ? (
                            <>
                              <span className="au-muted">Fjern adgang?</span>
                              <button type="button" className="au-act neg" onClick={() => remove(m)}>
                                Fjern
                              </button>
                              <button type="button" className="au-act" onClick={() => setConfirmRemove(null)}>
                                Annullér
                              </button>
                            </>
                          ) : (
                            editable && (
                              <>
                                {!m.lastSignInAt && (
                                  <button
                                    type="button"
                                    className="au-act link"
                                    onClick={() => newLink(m)}
                                    disabled={busy === m.userId}
                                  >
                                    Nyt link
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="au-act"
                                  onClick={() => setConfirmRemove(m.userId)}
                                  disabled={busy === m.userId}
                                >
                                  Fjern
                                </button>
                              </>
                            )
                          )}
                        </span>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="au-notes">
        {(Object.keys(ROLE_HINT) as AccountRole[]).map((r) => (
          <p key={r}>
            <b>{ROLE_LABEL[r]}:</b> {ROLE_HINT[r]}.
          </p>
        ))}
        {!manage && <p>Kun ejere og admins kan invitere og ændre brugere.</p>}
      </div>

      {inviting && (
        <InviteDialog
          base={base}
          roles={roles}
          onClose={() => setInviting(false)}
          onDone={async (r) => {
            await reload()
            if (r.kind === 'invited') setLinkFor({ email: r.email, link: r.link })
            setInviting(false)
          }}
        />
      )}
      {linkFor && <LinkDialog {...linkFor} onClose={() => setLinkFor(null)} />}
    </div>
  )
}

// ── dialogs ──────────────────────────────────────────────────────────────────

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  // Portalled to <body> so no ancestor can clip or contain the fixed backdrop.
  return createPortal(
    <div className="au-overlay" onClick={onClose}>
      <div
        className="au-dlg"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <h2>{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  )
}

function InviteDialog({
  base,
  roles,
  onClose,
  onDone,
}: {
  base: string
  roles: AccountRole[]
  onClose: () => void
  onDone: (r: InviteResult) => void
}) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<AccountRole>('member')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name, role }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Invitationen kunne ikke oprettes')
        return
      }
      const r = json as InviteResult
      // Someone with a login already: no link needed, say so before closing.
      if (r.kind === 'added') setAdded(r.email)
      else onDone(r)
    } finally {
      setBusy(false)
    }
  }

  if (added) {
    return (
      <Dialog title="Brugeren er tilføjet" onClose={() => onDone({ kind: 'added', email: added })}>
        <div className="au-dlg-body">
          <p>{added} har allerede et login og ser kontoen næste gang, de logger ind. Der er ikke brug for et link.</p>
          <div className="au-dlg-foot">
            <button type="button" className="wl-btn-primary" onClick={() => onDone({ kind: 'added', email: added })}>
              Luk
            </button>
          </div>
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog title="Invitér bruger" onClose={onClose}>
      <form className="au-dlg-body" onSubmit={submit}>
        <label className="au-field">
          <span>E-mail</span>
          <input
            type="email"
            className="au-sel"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label className="au-field">
          <span>Navn (valgfrit)</span>
          <input className="au-sel" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="au-field">
          <span>Rolle</span>
          <select className="au-sel" value={role} onChange={(e) => setRole(e.target.value as AccountRole)}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}: {ROLE_HINT[r].toLowerCase()}
              </option>
            ))}
          </select>
        </label>
        <p className="au-muted">
          Du får et link, som du selv sender. Med det vælger brugeren en adgangskode. Har e-mailen allerede et login,
          tilføjes brugeren med det samme.
        </p>
        {error && <p className="note warn">{error}</p>}
        <div className="au-dlg-foot">
          <button type="button" className="wl-btn-secondary" onClick={onClose}>
            Annullér
          </button>
          <button type="submit" className="wl-btn-primary" disabled={busy || !email.trim()}>
            {busy ? 'Opretter…' : 'Invitér'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function LinkDialog({ email, link, onClose }: { email: string; link: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <Dialog title="Send linket til brugeren" onClose={onClose}>
      <div className="au-dlg-body">
        <p>
          Send linket til <b>{email}</b>. Det virker én gang og udløber efter et døgn. Udløber det, laver du et nyt fra
          listen.
        </p>
        <div className="au-url">
          <Icon name="link" size={14} />
          <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Invitationslink" />
        </div>
        <div className="au-dlg-foot">
          <button type="button" className="wl-btn-secondary" onClick={onClose}>
            Luk
          </button>
          <button
            type="button"
            className="wl-btn-primary"
            onClick={async () => {
              await navigator.clipboard.writeText(link)
              setCopied(true)
            }}
          >
            {copied ? '✓ Kopieret' : 'Kopiér link'}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
