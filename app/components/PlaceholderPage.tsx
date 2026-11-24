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
        <span className="pill">Pladsholder</span>
      </header>

      <section className="card ph-card">
        <div>
          <h3>Siden er ikke bygget endnu</h3>
          <small>Den står i menuen, fordi den er med i prototypen. Hvad den skal indeholde, er ikke besluttet.</small>
        </div>
        <div className="ph-list">
          <span className="ph-label">I prototypen</span>
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
