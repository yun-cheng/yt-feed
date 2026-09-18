import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import ErrorBoundary from './ErrorBoundary'
import SignInGate from './components/SignInGate'
import DefaultsLoader from './components/DefaultsLoader'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <SignInGate>
        <DefaultsLoader>
          <App />
        </DefaultsLoader>
      </SignInGate>
    </ErrorBoundary>
  </StrictMode>,
)