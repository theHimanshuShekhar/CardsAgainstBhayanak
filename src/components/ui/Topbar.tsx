import type { ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'

type TopbarProps = {
  right?: ReactNode
}

export function Topbar({ right }: TopbarProps) {
  if (!right) return null
  return (
    <div className="topbar topbar-minimal">
      <div className="topbar-right">{right}</div>
    </div>
  )
}

type FullTopbarProps = {
  right?: ReactNode
}

export function FullTopbar({ right }: FullTopbarProps) {
  const navigate = useNavigate()
  return (
    <div className="topbar">
      <button className="brand" onClick={() => navigate({ to: '/' })}>
        <span className="brand-name">
          <span className="brand-name-full">Cards Against Bhayanak</span>
          <span className="brand-name-short">CAB</span>
        </span>
      </button>
      {right && <div className="topbar-right">{right}</div>}
    </div>
  )
}
