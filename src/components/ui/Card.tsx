import type { Card, BlackCard } from '~/lib/types'

type CardSize = 'sm' | 'md' | 'lg' | 'xl'

// Renders the blank text of a black card, substituting any provided fills
function PromptText({ text, fills }: { text: string; fills?: string[] }) {
  const parts = text.includes('__________') ? text.split(/(__________)/g) : [text]
  let blankIdx = 0
  return (
    <p className="card-text" data-ph-no-capture>
      {parts.map((p, i) => {
        if (p === '__________') {
          const fill = fills?.[blankIdx]
          blankIdx++
          return <u key={i}>{fill ? fill.replace(/\.$/, '') : ' '.repeat(7)}</u>
        }
        return <span key={i}>{p}</span>
      })}
    </p>
  )
}

type PromptCardProps = {
  card: BlackCard
  fills?: string[]
  size?: CardSize
  className?: string
  style?: React.CSSProperties
  onClick?: () => void
}

export function PromptCard({
  card,
  fills,
  size = 'lg',
  className = '',
  style,
  onClick,
}: PromptCardProps) {
  return (
    <div
      className={`card card-prompt card-${size} ${onClick ? 'card-clickable' : ''} ${className}`}
      style={style}
      onClick={onClick}
    >
      <PromptText text={card.text} fills={fills} />
    </div>
  )
}

type ResponseCardProps = {
  card: Card
  size?: CardSize
  className?: string
  style?: React.CSSProperties
  onClick?: () => void
  selected?: boolean
  pickOrder?: number
}

export function ResponseCard({
  card,
  size = 'md',
  className = '',
  style,
  onClick,
  selected,
  pickOrder,
}: ResponseCardProps) {
  return (
    <div
      className={`card card-response card-${size} ${onClick ? 'card-clickable' : ''} ${selected ? 'card-selected' : ''} ${className}`}
      style={style}
      onClick={onClick}
    >
      {pickOrder != null && <div className="pick-order-badge">{pickOrder}</div>}
      <p className="card-text" data-ph-no-capture>
        {card.text}
      </p>
    </div>
  )
}

type CardBackProps = {
  size?: CardSize
  className?: string
  style?: React.CSSProperties
}

export function CardBack({ size = 'sm', className = '', style }: CardBackProps) {
  return (
    <div className={`card card-prompt card-back card-${size} ${className}`} style={style}>
      <div className="card-back-mark" data-ph-no-capture>
        <span className="card-back-full">CardsAgainstBhayanak</span>
        <span className="card-back-short">CAB</span>
      </div>
    </div>
  )
}
