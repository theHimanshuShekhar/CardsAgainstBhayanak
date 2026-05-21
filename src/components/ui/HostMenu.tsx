import { useEffect, useRef, useState } from 'react'

type HostMenuProps = {
  onEndEarly: () => void
}

// Host-only overflow menu surfaced in the session topbar. Today it carries
// a single action (Happy Ending → forced Haiku final round); kept as a
// menu rather than a bare button so future host actions (kick, pause)
// don't have to re-shape the topbar.
export function HostMenu({ onEndEarly }: HostMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  const handleEnd = () => {
    setOpen(false)
    onEndEarly()
  }

  return (
    <div className="host-menu" ref={ref}>
      <button
        className="btn btn-ghost btn-sm"
        onClick={() => setOpen((v) => !v)}
        data-testid="host-menu"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        ⋯
      </button>
      {open && (
        <div className="host-menu-pop" role="menu">
          <button
            className="host-menu-item"
            onClick={handleEnd}
            data-testid="end-early-btn"
            role="menuitem"
          >
            End game (Happy Ending)
          </button>
        </div>
      )}
    </div>
  )
}
