import { Component, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center h-screen bg-[#0d0d0d] text-white gap-4">
          <p className="text-red-400 font-medium">Something went wrong</p>
          <p className="text-[#aaa] text-sm max-w-md text-center">{this.state.error.message}</p>
          <button
            className="px-4 py-2 bg-white text-black rounded text-sm font-medium"
            onClick={() => { this.setState({ error: null }); window.location.reload() }}
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
