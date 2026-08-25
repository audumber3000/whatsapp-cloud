import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { ConfirmProvider } from './components/ui/ConfirmDialog.jsx'

/**
 * The design page and the admin console are split out of the main bundle.
 * Neither is on the path a clinic takes to sign in, and the design page pulls
 * in the whole charting library — which a receptionist on a phone should not
 * download to look at a login form.
 */
const DesignSystem = lazy(() => import('./components/DesignSystem.jsx'))
const AdminApp = lazy(() => import('./AdminApp.jsx'))

/** Deliberately plain: it is on screen for a few hundred milliseconds at most. */
function RouteFallback() {
  return (
    <div style={{
      minHeight: '60vh', display: 'flex', alignItems: 'center',
      justifyContent: 'center', color: 'var(--text-muted)', fontSize: 14,
    }}>
      Loading…
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <ConfirmProvider>
        <BrowserRouter>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/admin/*" element={<AdminApp />} />
              <Route path="/design" element={<DesignSystem />} />
              <Route path="/*" element={<App />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </ConfirmProvider>
    </ErrorBoundary>
  </StrictMode>,
)
