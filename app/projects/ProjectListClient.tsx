'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { projectStatusBadge } from '@/app/components/ProjectConnectModal'

type ProjectSummary = {
  id: string
  name: string
  description: string | null
  shopUrl: string | null
  connectionStatus: string
  lastVerifiedAt: string | null
  created_at: string
  updated_at: string
  feedCount: number
}

// Per-project rollup aggregated client-side from each project's feeds (reusing
// /api/feeds, which already returns per-feed productCount + validationStatus).
// No new server endpoint, no DB change. Best-effort — a project stays without an
// aggregate (card shows "…") if its feeds can't be fetched.
type ProjectAggregate = { products: number; errorFeeds: number; warningFeeds: number }

type FeedRollupRow = { productCount?: number; validationStatus?: 'ok' | 'warnings' | 'errors' | null }

type PatchedProject = { id: string; name: string; description: string | null }

export function ProjectListClient() {
  const router = useRouter()
  // The overview has no sidebar (AppShell's NO_SIDEBAR), so the account and
  // its log-out live in the topbar here instead.
  const [userEmail, setUserEmail] = useState('')
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [aggregates, setAggregates] = useState<Map<string, ProjectAggregate>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  async function load() {
    setError(null)
    try {
      const res = await fetch('/api/projects')
      const data = (await res.json()) as { projects?: ProjectSummary[]; error?: string }
      if (data.error) throw new Error(data.error)
      const list = data.projects ?? []
      setProjects(list)
      loadAggregates(list.map((p) => p.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    }
  }

  // Roll up product totals + feed-health per project. One /api/feeds call per
  // project, in parallel; setState only after all settle (async callback).
  async function loadAggregates(ids: string[]) {
    const entries = await Promise.all(
      ids.map(async (id): Promise<readonly [string, ProjectAggregate | null]> => {
        try {
          const res = await fetch(`/api/feeds?projectId=${encodeURIComponent(id)}`)
          const data = (await res.json()) as { feeds?: FeedRollupRow[] }
          const feeds = data.feeds ?? []
          return [
            id,
            {
              products: feeds.reduce((s, f) => s + (f.productCount ?? 0), 0),
              errorFeeds: feeds.filter((f) => f.validationStatus === 'errors').length,
              warningFeeds: feeds.filter((f) => f.validationStatus === 'warnings').length,
            },
          ] as const
        } catch {
          return [id, null] as const
        }
      })
    )
    setAggregates((prev) => {
      const next = new Map(prev)
      for (const [id, agg] of entries) if (agg) next.set(id, agg)
      return next
    })
  }

  useEffect(() => {
    load()
    supabase.auth.getUser().then(({ data }) => {
      setUserEmail(data.user?.email ?? '')
    })
  }, [])

  async function handleSignOut() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  function handlePatched(updated: PatchedProject) {
    setProjects((prev) =>
      prev
        ? prev.map((p) =>
            p.id === updated.id ? { ...p, name: updated.name, description: updated.description } : p
          )
        : prev
    )
  }

  function handleDeleted(id: string) {
    setProjects((prev) => (prev ? prev.filter((p) => p.id !== id) : prev))
  }

  return (
    <div className="min-h-screen">
      <header className="ff-topbar">
        <div className="flex items-center gap-3">
          <h1 className="ff-topbar-title">Projects</h1>
          {projects && (
            <span style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
              {projects.length} project{projects.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setShowCreate(true)} className="ff-btn-primary">
            Create project
          </button>
          {userEmail && (
            <span style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>{userEmail}</span>
          )}
          <button onClick={handleSignOut} className="ff-btn-secondary">
            Log out
          </button>
        </div>
      </header>

      <main className="px-4 py-4 max-w-6xl">
        {error && (
          <div
            className="ff-panel p-4 mb-3"
            style={{
              background: 'var(--color-badge-danger-bg)',
              borderColor: 'var(--color-badge-danger-text)',
            }}
          >
            <p style={{ fontSize: '12px', color: 'var(--color-badge-danger-text)' }}>{error}</p>
          </div>
        )}

        {projects === null ? (
          <div
            className="ff-panel py-16 text-center"
            style={{ fontSize: '12px', color: 'var(--color-text-tertiary)' }}
          >
            Loading projects…
          </div>
        ) : projects.length === 0 ? (
          <div className="ff-panel py-16 flex flex-col items-center gap-3">
            <p style={{ fontSize: '12px', color: 'var(--color-text-tertiary)' }}>
              No projects yet — a project holds one Shopify connection.
            </p>
            <button onClick={() => setShowCreate(true)} className="ff-btn-primary">
              Create your first project
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {projects.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                aggregate={aggregates.get(p.id)}
                onPatched={handlePatched}
                onDeleted={handleDeleted}
              />
            ))}
          </div>
        )}
      </main>

      {showCreate && <CreateProjectModal onClose={() => setShowCreate(false)} />}
    </div>
  )
}

function ProjectCard({
  project,
  aggregate,
  onPatched,
  onDeleted,
}: {
  project: ProjectSummary
  aggregate?: ProjectAggregate
  onPatched: (updated: PatchedProject) => void
  onDeleted: (id: string) => void
}) {
  const [openModal, setOpenModal] = useState<'rename' | 'delete' | null>(null)
  const badge = projectStatusBadge(project.connectionStatus)

  return (
    <div className="ff-panel ff-card">
      <div
        className="ff-panel-header"
        style={{ textTransform: 'none', letterSpacing: 0, fontSize: '12px', alignItems: 'flex-start' }}
      >
        <div className="min-w-0">
          <div
            className="truncate"
            style={{ fontSize: '13px', fontWeight: 500, color: 'var(--color-text-primary)' }}
          >
            {project.name}
          </div>
          {project.shopUrl && (
            <div
              className="truncate mt-0.5 ff-mono"
              style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', textTransform: 'none', letterSpacing: 0 }}
            >
              {project.shopUrl}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {aggregate && <FeedHealthBadge aggregate={aggregate} />}
          <span className={badge.className}>{badge.label}</span>
          <CardMenu onRename={() => setOpenModal('rename')} onDelete={() => setOpenModal('delete')} />
        </div>
      </div>

      <div className="px-3.5 py-3 space-y-2">
        <Stat label="Feeds" value={String(project.feedCount)} />
        <Stat label="Products" value={aggregate ? aggregate.products.toLocaleString('en-US') : '…'} />
        <Stat
          label="Last verified"
          value={
            project.lastVerifiedAt
              ? new Date(project.lastVerifiedAt).toLocaleString('en-US', {
                  day: '2-digit',
                  month: '2-digit',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : '—'
          }
        />
      </div>

      <div
        className="px-3.5 py-2.5 flex items-center gap-2"
        style={{ borderTop: '1px solid var(--color-border-tertiary)' }}
      >
        <Link href={`/project/${project.id}`} className="ff-btn-primary">
          Open
        </Link>
      </div>

      {openModal === 'rename' && (
        <RenameProjectModal
          project={project}
          onClose={() => setOpenModal(null)}
          onSaved={(updated) => {
            onPatched(updated)
            setOpenModal(null)
          }}
        />
      )}
      {openModal === 'delete' && (
        <DeleteProjectModal
          project={project}
          onClose={() => setOpenModal(null)}
          onDeleted={() => {
            onDeleted(project.id)
            setOpenModal(null)
          }}
        />
      )}
    </div>
  )
}

function CardMenu({ onRename, onDelete }: { onRename: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handle)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Settings"
        aria-label="Settings"
        aria-haspopup="menu"
        aria-expanded={open}
        className="shrink-0"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '22px',
          height: '22px',
          borderRadius: '4px',
          background: open ? 'var(--color-background-secondary)' : 'transparent',
          color: 'var(--color-text-tertiary)',
          border: '1px solid var(--color-border-tertiary)',
          cursor: 'pointer',
          transition: 'background 0.12s ease',
        }}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z" stroke="currentColor" strokeWidth="1.3" />
          <path
            d="M13.3 9.4 14.5 10l-1 1.7-1.4-.4a4.7 4.7 0 0 1-1 .6l-.3 1.4H9l-.3-1.4a4.7 4.7 0 0 1-1-.6l-1.4.4-1-1.7 1.2-.6a4.6 4.6 0 0 1 0-1.2L4.3 7.4l1-1.7L6.7 6c.3-.2.6-.4 1-.6L8 4h1.8l.3 1.4c.3.2.7.3 1 .6l1.4-.4 1 1.7-1.2.6a4.6 4.6 0 0 1 0 1.2Z"
            stroke="currentColor"
            strokeWidth="1.1"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="ff-panel"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            zIndex: 20,
            minWidth: '170px',
            padding: '4px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
          }}
        >
          <MenuItem onClick={() => { setOpen(false); onRename() }}>Rename project</MenuItem>
          <MenuItem onClick={() => { setOpen(false); onDelete() }} danger>
            Delete project
          </MenuItem>
        </div>
      )}
    </div>
  )
}

function MenuItem({
  onClick,
  danger,
  children,
}: {
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '6px 10px',
        fontSize: '12px',
        background: 'transparent',
        border: 'none',
        borderRadius: '4px',
        color: danger ? 'var(--color-badge-danger-text)' : 'var(--color-text-primary)',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--color-background-secondary)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
    >
      {children}
    </button>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="ff-label">{label}</span>
      <span style={{ fontSize: '11px', color: 'var(--color-text-primary)' }}>{value}</span>
    </div>
  )
}

// Rolls a project's feed warnings/errors up to a single at-a-glance badge so
// problems are visible while scanning the grid. Renders nothing when all the
// project's feeds are healthy (errors take precedence over warnings).
function FeedHealthBadge({ aggregate }: { aggregate: ProjectAggregate }) {
  if (aggregate.errorFeeds > 0) {
    return (
      <span className="ff-badge ff-badge-danger shrink-0">
        {aggregate.errorFeeds} {aggregate.errorFeeds === 1 ? 'error' : 'errors'}
      </span>
    )
  }
  if (aggregate.warningFeeds > 0) {
    return (
      <span className="ff-badge ff-badge-warning shrink-0">
        {aggregate.warningFeeds} {aggregate.warningFeeds === 1 ? 'warning' : 'warnings'}
      </span>
    )
  }
  return null
}

// ── Modals ────────────────────────────────────────────────────────────────

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4" onClick={onClose}>
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.3)' }} />
      <div className="relative ff-panel w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="ff-panel-header" style={{ textTransform: 'none', letterSpacing: 0, fontSize: '12px' }}>
          <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--color-text-primary)' }}>
            {title}
          </span>
        </div>
        {children}
      </div>
    </div>
  )
}

function CreateProjectModal({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setSubmitting(true)
    setErr(null)
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, description: description.trim() }),
      })
      const data = (await res.json()) as { project?: { id: string }; error?: string }
      if (!res.ok || data.error || !data.project?.id) {
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }
      // Land on the new project so the user can connect Shopify next.
      router.push(`/project/${data.project.id}`)
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Could not create project')
      setSubmitting(false)
    }
  }

  return (
    <ModalShell title="Create project" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="p-3.5 space-y-3">
          <div>
            <label className="ff-label block mb-1.5">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Bottles With History"
              autoFocus
              className="ff-input"
              required
            />
          </div>
          <div>
            <label className="ff-label block mb-1.5">Description (optional)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Which store this project connects to"
              rows={3}
              className="ff-input"
              style={{ resize: 'none' }}
            />
          </div>
          {err && <p style={{ fontSize: '11px', color: 'var(--color-badge-danger-text)' }}>{err}</p>}
        </div>
        <div
          className="px-3.5 py-3 flex items-center justify-end gap-2"
          style={{ borderTop: '1px solid var(--color-border-tertiary)' }}
        >
          <button type="button" onClick={onClose} className="ff-btn-secondary" disabled={submitting}>
            Cancel
          </button>
          <button type="submit" disabled={submitting || !name.trim()} className="ff-btn-primary">
            {submitting ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}

async function patchProject(
  projectId: string,
  body: { name?: string; description?: string }
): Promise<PatchedProject> {
  const res = await fetch(`/api/projects/${projectId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as { project?: PatchedProject; error?: string }
  if (!res.ok || data.error || !data.project) {
    throw new Error(data.error ?? `HTTP ${res.status}`)
  }
  return data.project
}

function RenameProjectModal({
  project,
  onClose,
  onSaved,
}: {
  project: ProjectSummary
  onClose: () => void
  onSaved: (updated: PatchedProject) => void
}) {
  const [name, setName] = useState(project.name)
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setSubmitting(true)
    setErr(null)
    try {
      const updated = await patchProject(project.id, { name: trimmed })
      onSaved(updated)
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Could not save')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ModalShell title="Rename project" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="p-3.5 space-y-3">
          <div>
            <label className="ff-label block mb-1.5">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              className="ff-input"
              required
            />
          </div>
          {err && <p style={{ fontSize: '11px', color: 'var(--color-badge-danger-text)' }}>{err}</p>}
        </div>
        <div
          className="px-3.5 py-3 flex items-center justify-end gap-2"
          style={{ borderTop: '1px solid var(--color-border-tertiary)' }}
        >
          <button type="button" onClick={onClose} className="ff-btn-secondary">
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !name.trim() || name.trim() === project.name}
            className="ff-btn-primary"
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}

function DeleteProjectModal({
  project,
  onClose,
  onDeleted,
}: {
  project: ProjectSummary
  onClose: () => void
  onDeleted: () => void
}) {
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setErr(null)
    try {
      const res = await fetch(`/api/projects/${project.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      onDeleted()
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Could not delete project')
      setSubmitting(false)
    }
  }

  return (
    <ModalShell title="Delete project" onClose={onClose}>
      <div className="p-3.5 space-y-3">
        <p style={{ fontSize: '12px', color: 'var(--color-text-primary)' }}>
          Delete <strong>{project.name}</strong>?
          {project.feedCount > 0 && (
            <>
              {' '}
              This also deletes its <strong>{project.feedCount} feed{project.feedCount !== 1 ? 's' : ''}</strong> and
              all their data.
            </>
          )}{' '}
          This cannot be undone.
        </p>
        {err && <p style={{ fontSize: '11px', color: 'var(--color-badge-danger-text)' }}>{err}</p>}
      </div>
      <div
        className="px-3.5 py-3 flex items-center justify-end gap-2"
        style={{ borderTop: '1px solid var(--color-border-tertiary)' }}
      >
        <button type="button" onClick={onClose} className="ff-btn-secondary" disabled={submitting}>
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          className="ff-btn-primary"
          style={{
            background: 'var(--color-badge-danger-text)',
            borderColor: 'var(--color-badge-danger-text)',
          }}
        >
          {submitting ? 'Deleting…' : 'Delete project'}
        </button>
      </div>
    </ModalShell>
  )
}
