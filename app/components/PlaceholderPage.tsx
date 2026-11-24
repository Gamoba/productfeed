import './placeholder.css'

// A page from the prototype that exists in the menu but isn't built yet. What
// it is for is still being decided, so it shows only the prototype's lede and
// what the prototype put on it, labelled clearly as a placeholder. Nothing on
// it reads or writes data.
export function PlaceholderPage({
  title,
  lede,
  contents,
  note,
}: {
  title: string
  lede: string
  /** What the prototype shows on the page, one short line each. */
  contents: string[]
  /** Extra context, e.g. why the page is waiting. */
  note?: string
}) {
  return (
    <div className="ph">
      <header className="ph-head">
        <div>
          <h1>{title}</h1>
          <p className="ph-lede">{lede}</p>
        </div>
        <span className="pill">Placeholder</span>
      </header>

      <section className="card ph-card">
        <div>
          <h3>This page is not built yet</h3>
          <small>It is in the menu because it is part of the prototype. What it will contain has not been decided.</small>
        </div>
        <div className="ph-list">
          <span className="ph-label">In the prototype</span>
          <ul>
            {contents.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
        {note && <p className="note">{note}</p>}
      </section>
    </div>
  )
}
