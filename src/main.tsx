import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/geist-mono/latin-400.css'
import '@fontsource/geist-mono/latin-500.css'
import '@fontsource/geist-mono/latin-600.css'
import App from './App'
import './app.css'

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
