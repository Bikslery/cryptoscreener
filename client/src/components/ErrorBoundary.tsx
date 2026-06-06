import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  componentStack: string | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, componentStack: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, componentStack: null }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // DIAG: log to console with full stack + componentStack so we can see WHICH
    // component crashed and where in the React tree. Tagged with [DIAG-err] for
    // easy cleanup via grep.
    // eslint-disable-next-line no-console
    console.error(
      `[DIAG-err] ErrorBoundary caught: ${error?.message ?? error}\n` +
      `stack: ${error?.stack ?? '(no stack)'}\n` +
      `componentStack: ${info?.componentStack ?? '(none)'}`
    )
    // also stash on state so fallback can show it during dev
    this.setState({ componentStack: info?.componentStack ?? null })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback
      return (
        <div style={{ padding: 16, color: '#e74c3c', fontFamily: 'monospace' }}>
          <div><b>Error:</b> {this.state.error?.message ?? 'Unknown'}</div>
          {this.state.componentStack && (
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, marginTop: 8 }}>
              {this.state.componentStack}
            </pre>
          )}
        </div>
      )
    }
    return this.props.children
  }
}
