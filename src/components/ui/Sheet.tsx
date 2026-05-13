import type { CSSProperties, ReactNode } from 'react'

export function Sheet({
  children,
  className = '',
  style,
}: {
  children: ReactNode
  className?: string
  style?: CSSProperties
}) {
  return (
    <div className={`sheet ${className}`} style={style}>
      {children}
    </div>
  )
}

export function SheetHd({
  title,
  sub,
  right,
}: {
  title: ReactNode
  sub?: ReactNode
  right?: ReactNode
}) {
  return (
    <div className="sheet-hd">
      <div>
        <div className="sheet-title">{title}</div>
        {sub && <div className="sheet-sub">{sub}</div>}
      </div>
      {right}
    </div>
  )
}
