type AvatarSize = 'sm' | 'md' | 'lg'

type Props = {
  name: string
  size?: AvatarSize
  you?: boolean
}

export function Avatar({ name, size = 'md', you = false }: Props) {
  const cls = size === 'lg' ? 'avatar avatar-lg' : size === 'sm' ? 'avatar avatar-sm' : 'avatar'
  const initial = (name || '?').slice(0, 1).toUpperCase()
  return (
    <div
      className={cls}
      style={
        you
          ? { background: 'var(--white)', color: 'var(--black)', borderColor: 'var(--white)' }
          : undefined
      }
      title={name}
    >
      {initial}
    </div>
  )
}
