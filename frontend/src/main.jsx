import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import DesignSystem from './components/DesignSystem.jsx'
import AdminApp from './AdminApp.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
      <Routes>
        <Route path="/admin/*" element={<AdminApp />} />
        <Route path="/design" element={<DesignSystem />} />
        <Route path="/*" element={<App />} />
      </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
