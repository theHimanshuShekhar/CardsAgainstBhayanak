import type { ReactNode } from 'react'

export function ErrorNotice({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="error-notice">
      <strong className="error-notice-label">Error</strong>
      <span>{children}</span>
    </div>
  )
}
