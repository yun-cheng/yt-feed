import * as Slider from '@radix-ui/react-slider'
import { MAX_TICK, TICK_LABELS, clampRange, rangeLabel, type TimeRange } from '../lib/timeWindow'

type Props = {
  value: TimeRange
  onChange: (r: TimeRange) => void
  /** Result count for the current range, shown beside the label when known. */
  count?: number
}

/** Percent along the track for a tick. The ladder is spaced by index, not by
 *  days — 1d and 1y are one notch apart either way, which is what makes the
 *  short windows (the ones you actually use) reachable instead of crushed
 *  into the first 1% of the track. */
function tickLeft(i: number): string {
  return `${((i / MAX_TICK) * 100).toFixed(2)}%`
}

/** Keep the end labels inside the track instead of hanging off either edge. */
function tickShift(i: number): string {
  return i === 0 ? 'translateX(0)' : i === MAX_TICK ? 'translateX(-100%)' : 'translateX(-50%)'
}

export default function TimeRangeSlider({ value, onChange, count }: Props) {
  // Clicking a label sets the older edge. Your recent edge is kept when it
  // still fits, so the one-click "just show me the past week" move survives
  // from the button row this replaced.
  const pick = (i: number) => onChange(clampRange({ lo: i > value.lo ? value.lo : 0, hi: i }))

  return (
    <div className="w-full min-w-0 md:max-w-xs">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-sm font-medium text-white">{rangeLabel(value)}</span>
        {count !== undefined && (
          <span className="text-xs text-[#888]">{count.toLocaleString()} videos</span>
        )}
      </div>

      <Slider.Root
        className="relative flex h-4 w-full cursor-pointer touch-none select-none items-center"
        value={[value.lo, value.hi]}
        onValueChange={([lo, hi]) => onChange(clampRange({ lo, hi }))}
        min={0}
        max={MAX_TICK}
        step={1}
        minStepsBetweenThumbs={1}
        aria-label="Time window"
      >
        <Slider.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-[#272727]">
          <Slider.Range className="absolute h-full bg-white" />
          {/* Notch the track at every tick, so the ladder the thumbs snap to is
              something you can see rather than something you discover by
              dragging. Cut in the page colour: legible over the filled range
              and the empty track alike. The two ends are the track's own
              edges and need no notch. */}
          {TICK_LABELS.slice(1, -1).map((label, i) => (
            <span
              key={label}
              data-testid="time-tick"
              aria-hidden
              style={{ left: tickLeft(i + 1) }}
              className="absolute top-0 h-full w-0.5 -translate-x-1/2 bg-[#0f0f0f]"
            />
          ))}
        </Slider.Track>
        <Slider.Thumb
          data-testid="time-thumb-lo"
          aria-label="Newest edge"
          aria-valuetext={TICK_LABELS[value.lo]}
          className="block h-3.5 w-3.5 cursor-grab rounded-full bg-white transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 active:cursor-grabbing"
        />
        <Slider.Thumb
          data-testid="time-thumb-hi"
          aria-label="Oldest edge"
          aria-valuetext={TICK_LABELS[value.hi]}
          className="block h-3.5 w-3.5 cursor-grab rounded-full bg-white transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 active:cursor-grabbing"
        />
      </Slider.Root>

      <div className="relative mt-1.5 h-4">
        {TICK_LABELS.map((label, i) => {
          const inRange = i >= value.lo && i <= value.hi
          const style = { left: tickLeft(i), transform: tickShift(i) }
          // 'now' is the track's origin, never an older edge — so it's a marker,
          // not a target.
          return i === 0 ? (
            <span
              key={label}
              style={style}
              className={`absolute text-[11px] ${inRange ? 'text-white' : 'text-[#717171]'}`}
            >
              {label}
            </span>
          ) : (
            <button
              key={label}
              onClick={() => pick(i)}
              style={style}
              className={`absolute cursor-pointer text-[11px] transition-colors hover:text-white ${
                inRange ? 'text-white' : 'text-[#717171]'
              }`}
            >
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
