// ErrorBoundary — prevents one component's crash from unmounting the whole
// React tree. Wrap any region that might throw (Sparkline with bad data,
// query callbacks with shape mismatches, etc.) and the rest of the page
// stays interactive even on error.

import { Component, ReactNode, ErrorInfo } from 'react'

type Props = {
  children: ReactNode
  /** Short label shown in the fallback UI ("Throughput", "Interfaces", etc.) */
  label?: string
}

type State = { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface to console with our label so it's findable in Sentry / devtools.
    // eslint-disable-next-line no-console
    console.error(`[ErrorBoundary:${this.props.label || 'unknown'}]`, error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: 12, background: 'var(--danger-soft, #fee)',
          border: '1px solid var(--danger, #c00)', borderRadius: 6,
          color: 'var(--danger-ink, #c00)', fontSize: 12, lineHeight: 1.5,
        }}>
          <div style={{ fontWeight: 500, marginBottom: 4 }}>
            {this.props.label || 'Component'} crashed
          </div>
          <div className="mono" style={{ fontSize: 11 }}>
            {this.state.error.message}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: 8, padding: '4px 10px', fontSize: 11,
              background: 'transparent', border: '1px solid currentColor',
              borderRadius: 3, cursor: 'pointer', color: 'inherit',
            }}>retry</button>
        </div>
      )
    }
    return this.props.children
  }
}
