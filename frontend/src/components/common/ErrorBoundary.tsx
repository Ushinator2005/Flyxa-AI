import React from 'react';

interface State {
  hasError: boolean;
}

export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught render error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          minHeight: 320,
          gap: 16,
          padding: '40px 24px',
          fontFamily: 'var(--font-sans)',
          textAlign: 'center',
        }}>
          <div style={{
            width: 48,
            height: 48,
            borderRadius: '50%',
            background: 'rgba(248,113,113,0.12)',
            border: '1px solid rgba(248,113,113,0.25)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 22,
          }}>
            ⚠
          </div>
          <div>
            <h2 style={{
              fontSize: 16,
              fontWeight: 600,
              color: 'var(--app-text)',
              margin: '0 0 8px',
              letterSpacing: '-0.02em',
            }}>
              Something went wrong
            </h2>
            <p style={{
              fontSize: 13,
              color: 'var(--app-text-subtle)',
              margin: 0,
              maxWidth: 360,
              lineHeight: 1.6,
            }}>
              An unexpected error occurred in this section.
              Refresh the page or navigate to another part of the app.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false })}
              style={{
                height: 34,
                padding: '0 16px',
                background: 'var(--app-panel-strong)',
                border: '1px solid var(--app-border)',
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--app-text-muted)',
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                height: 34,
                padding: '0 16px',
                background: '#f59e0b',
                border: 'none',
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                color: '#000',
                cursor: 'pointer',
              }}
            >
              Refresh page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
