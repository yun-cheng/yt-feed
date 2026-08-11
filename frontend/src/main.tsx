import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import ErrorBoundary from './ErrorBoundary'
import SignInGate from './components/SignInGate'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <SignInGate>
        <App />
      </SignInGate>
    </ErrorBoundary>
  </StrictMode>,
)