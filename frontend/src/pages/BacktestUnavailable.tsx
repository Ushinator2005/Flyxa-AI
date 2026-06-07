export default function BacktestUnavailable() {
  return (
    <div
      style={{
        minHeight: 'calc(100vh - 52px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'var(--app-bg)',
      }}
    >
      <section
        data-tour-id="backtest-header"
        style={{
          width: 'min(100%, 460px)',
          border: '1px solid var(--app-border)',
          borderRadius: 8,
          background: 'var(--app-panel)',
          padding: 28,
          textAlign: 'center',
        }}
      >
        <img
          src="/logo.svg"
          alt="Flyxa"
          style={{
            width: 58,
            height: 58,
            display: 'block',
            margin: '0 auto 14px',
          }}
        />
        <h1 style={{ margin: 0, color: 'var(--app-text)', fontSize: 22, fontWeight: 600 }}>
          Backtesting is not available yet
        </h1>
        <p style={{ margin: '10px 0 0', color: 'var(--app-text-muted)', fontSize: 13, lineHeight: 1.6 }}>
          This page is temporarily disabled while the backtesting workspace is being prepared.
        </p>
      </section>
    </div>
  );
}
