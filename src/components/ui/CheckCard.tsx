import type { ReactNode } from 'react'

export function CheckCard({
  on,
  onClick,
  title,
  description,
  meta,
  disabled = false,
}: {
  on: boolean
  onClick: () => void
  title: ReactNode
  description?: ReactNode
  meta?: ReactNode
  disabled?: boolean
}) {
  return (
    <div
      className={`check-card ${on ? 'on' : ''}`}
      onClick={disabled ? undefined : onClick}
      style={disabled ? { opacity: 0.85, cursor: 'default' } : undefined}
    >
      <div className="check-box" />
      <div className="grow">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="check-card-title">{title}</div>
          {meta && (
            <div className="mono" style={{ fontSize: 11, color: 'var(--color-gray-3)' }}>
              {meta}
            </div>
          )}
        </div>
        {description && <div className="check-card-desc">{description}</div>}
      </div>
    </div>
  )
}
