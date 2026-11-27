'use client'

import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { AccountUsers, InviteResult, MemberRow } from '@/lib/accountMembers'
import type { AccountRole } from '@/lib/accounts'
import { Icon } from '@/app/components/shell/icons'
import { ROLE_LABEL } from '@/app/components/shell/nav'
import { LimitNote } from '@/app/components/LimitNote'
import { formatNumber, formatWhen } from '@/lib/formatDa'
import './users.css'

const ROLE_HINT: Record<AccountRole, string> = {
  owner: 'Everything, including making others owner',
  admin: 'Invite, change roles and remove users',
  member: 'Work in shops and feeds',
}

export function UsersClient({ initial, customer = false }: { initial: AccountUsers; customer?: boolean }) {
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
        setError((json.error as string) ?? 'That did not work')
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
          <h1>{customer ? 'Users' : 'Agency users'}</h1>
          <p className="au-lede">
            {customer
              ? `Who at ${account.name} can work in its shops and feeds. Everyone here sees the same shops.`
              : `Who at the agency has access to the customers. Everyone here sees the same shops and feeds in ${account.name}.`}
          </p>
        </div>
        {manage && (
          <button type="button" className="wl-btn-primary" onClick={() => setInviting(true)}>
            <Icon name="plus" size={14} /> Invite user
          </button>
        )}
      </header>

      <section className="card au-stats">
        <div>
          <span>Users</span>
          <strong className="num">
            {formatNumber(members.length)}
            {account.seatLimit !== null && <small> / {formatNumber(account.seatLimit)}</small>}
          </strong>
          <small className={account.seatLimit !== null && members.length >= account.seatLimit ? 'neg' : undefined}>
            {account.seatLimit === null
              ? 'No limit on the plan'
              : members.length >= account.seatLimit
                ? 'All seats are used'
                : `The plan includes ${formatNumber(account.seatLimit)} seats`}
          </small>
        </div>
        <div>
          <span>Pending invitations</span>
          <strong className="num">{formatNumber(pending.length)}</strong>
          <small>{pending.length === 0 ? 'None right now' : 'Not signed in yet'}</small>
        </div>
      </section>

      {error && <p className="note warn">{error}</p>}

      <section className="card flush">
        <div className="au-tablewrap">
          <table className="au-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                {manage && <th className="r" aria-label="Actions" />}
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
                      {isMe && <span className="au-you">you</span>}
                    </td>
                    <td className="au-muted">{m.email}</td>
                    <td>
                      {editable ? (
                        <select
                          className="au-sel"
                          value={m.role}
                          disabled={busy === m.userId}
                          onChange={(e) => setRole(m, e.target.value as AccountRole)}
                          aria-label={`Role for ${m.email}`}
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
                        <span className="st" title={`Last signed in ${formatWhen(m.lastSignInAt)}`}>
                          Active
                        </span>
                      ) : (
                        <span className="pill ai">Invited</span>
                      )}
                    </td>
                    {manage && (
                      <td className="r">
                        <span className="au-acts">
                          {editable && confirmRemove === m.userId ? (
                            <>
                              <span className="au-muted">Remove access?</span>
                              <button type="button" className="au-act neg" onClick={() => remove(m)}>
                                Remove
                              </button>
                              <button type="button" className="au-act" onClick={() => setConfirmRemove(null)}>
                                Cancel
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
                                    New link
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="au-act"
                                  onClick={() => setConfirmRemove(m.userId)}
                                  disabled={busy === m.userId}
                                >
                                  Remove
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
        {!manage && <p>Only owners and admins can invite and change users.</p>}
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
  const [upgrade, setUpgrade] = useState<string | null>(null)
  const [added, setAdded] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setUpgrade(null)
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name, role }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'The invitation could not be created')
        setUpgrade(typeof json.upgrade === 'string' ? json.upgrade : null)
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
      <Dialog title="User added" onClose={() => onDone({ kind: 'added', email: added })}>
        <div className="au-dlg-body">
          <p>{added} already has a login and will see the account next time they sign in. No link is needed.</p>
          <div className="au-dlg-foot">
            <button type="button" className="wl-btn-primary" onClick={() => onDone({ kind: 'added', email: added })}>
              Close
            </button>
          </div>
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog title="Invite user" onClose={onClose}>
      <form className="au-dlg-body" onSubmit={submit}>
        <label className="au-field">
          <span>Email</span>
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
          <span>Name (optional)</span>
          <input className="au-sel" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="au-field">
          <span>Role</span>
          <select className="au-sel" value={role} onChange={(e) => setRole(e.target.value as AccountRole)}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}: {ROLE_HINT[r].toLowerCase()}
              </option>
            ))}
          </select>
        </label>
        <p className="au-muted">
          You get a link to send yourself. With it, the user chooses a password. If the email already has a login,
          the user is added straight away.
        </p>
        <LimitNote error={error} upgrade={upgrade} />
        <div className="au-dlg-foot">
          <button type="button" className="wl-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="wl-btn-primary" disabled={busy || !email.trim()}>
            {busy ? 'Creating…' : 'Invite'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function LinkDialog({ email, link, onClose }: { email: string; link: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <Dialog title="Send the link to the user" onClose={onClose}>
      <div className="au-dlg-body">
        <p>
          Send the link to <b>{email}</b>. It works once and expires after 24 hours. If it expires, create a new one from
          the list.
        </p>
        <div className="au-url">
          <Icon name="link" size={14} />
          <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Invitation link" />
        </div>
        <div className="au-dlg-foot">
          <button type="button" className="wl-btn-secondary" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="wl-btn-primary"
            onClick={async () => {
              await navigator.clipboard.writeText(link)
              setCopied(true)
            }}
          >
            {copied ? '✓ Copied' : 'Copy link'}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
