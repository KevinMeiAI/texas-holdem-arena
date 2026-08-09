const seats = [
  { name: "Claude", stack: "20,000", status: "WAITING" },
  { name: "Gemini", stack: "20,000", status: "WAITING" },
  { name: "GPT", stack: "20,000", status: "WAITING" },
  { name: "DeepSeek", stack: "20,000", status: "WAITING" },
];

export function App() {
  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <p className="eyebrow">MODEL TOURNAMENT SYSTEM · LOCAL</p>
          <h1>Texas Hold&apos;em <em>Arena</em></h1>
        </div>
        <div className="foundation-status" aria-label="Foundation status">
          <span className="status-dot" />
          FOUNDATION ONLINE
        </div>
      </header>

      <section className="broadcast-grid" aria-label="Arena foundation preview">
        <div className="table-stage">
          <div className="table-rail">
            <div className="felt">
              <div className="board-mark">
                <span>VERIFIABLE DEAL</span>
                <strong>HAND —</strong>
              </div>
              {seats.map((seat, index) => (
                <article className={`seat seat-${index + 1}`} key={seat.name}>
                  <div className="seat-index">0{index + 1}</div>
                  <div>
                    <h2>{seat.name}</h2>
                    <p>{seat.status}</p>
                  </div>
                  <strong>{seat.stack}</strong>
                </article>
              ))}
              <div className="pot-placeholder">
                <span>POT</span>
                <strong>—</strong>
              </div>
            </div>
          </div>
        </div>

        <aside className="hand-tape">
          <div className="tape-heading">
            <span>LIVE EVENT TAPE</span>
            <span>SEQ 0000</span>
          </div>
          <div className="tape-empty">
            <span className="tape-line" />
            <p>The arena is ready for its first authoritative event.</p>
          </div>
          <dl>
            <div><dt>ENGINE</dt><dd>Deterministic</dd></div>
            <div><dt>FORMAT</dt><dd>2–9 seats</dd></div>
            <div><dt>RECOVERY</dt><dd>Event sourced</dd></div>
          </dl>
        </aside>
      </section>

      <footer>
        <span>PHASE 01 / FOUNDATION</span>
        <span>Rules engine comes before spectacle.</span>
      </footer>
    </main>
  );
}
