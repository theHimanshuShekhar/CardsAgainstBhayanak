export function Stepper({
  value,
  min,
  max,
  onChange,
}: {
  value: number
  min: number
  max: number
  onChange: (n: number) => void
}) {
  return (
    <div className="stepper">
      <button
        type="button"
        className="stepper-btn"
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
        aria-label="decrement"
      >
        −
      </button>
      <div className="stepper-val">{value}</div>
      <button
        type="button"
        className="stepper-btn"
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
        aria-label="increment"
      >
        +
      </button>
    </div>
  )
}
