import { ResponseCard } from '~/components/ui/Card'
import type { Card } from '~/lib/types'

type Props = {
  hand: Card[]
  selected: string[] // card IDs in pick order
  blanks: number
  onToggle: (cardId: string) => void
  onSubmit: () => void
  pending?: boolean
}

export function HandDock({ hand, selected, blanks, onToggle, onSubmit, pending = false }: Props) {
  return (
    <div className="hand-dock">
      <div className="hand-dock-hd">
        <div className="eyebrow">
          {blanks > 1 ? `Your hand · pick ${blanks} in order` : 'Your hand · pick one'}
        </div>
        <button
          className="btn btn-primary btn-sm"
          disabled={pending || selected.length < blanks}
          onClick={onSubmit}
        >
          {pending
            ? 'Sending…'
            : selected.length < blanks
              ? blanks > 1
                ? `Pick ${blanks - selected.length} more`
                : 'Pick a card'
              : blanks > 1
                ? 'Submit cards →'
                : 'Submit card →'}
        </button>
      </div>
      <div className="hand">
        {hand.map((card, i) => {
          const pickIdx = selected.indexOf(card.id)
          const isSelected = pickIdx !== -1
          return (
            <div
              key={card.id}
              className="hand-card-wrap deal"
              style={{ animationDelay: `${i * 0.06}s` } as React.CSSProperties}
            >
              <ResponseCard
                card={card}
                size="md"
                selected={isSelected}
                pickOrder={blanks > 1 && isSelected ? pickIdx + 1 : undefined}
                onClick={pending ? undefined : () => onToggle(card.id)}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
