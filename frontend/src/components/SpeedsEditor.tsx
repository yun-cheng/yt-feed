import { useEffect, useState } from 'react'
import {
  DEFAULT_SPEEDS, MAX_SPEEDS, cleanSpeeds, formatSpeeds, parseSpeeds,
} from '../lib/playbackSpeeds'
import { t } from '../lib/i18n'

/**
 * The speeds the player offers, as one line you type.
 *
 * A text field rather than a row of steppers because the thing being edited is
 * a *list*: adding 1.1, dropping 0.25 and keeping the rest is one edit here and
 * four clicks anywhere else. What you type is normalised on the way in — sorted,
 * de-duplicated, with normal speed put back if you left it out — and written
 * back into the field, so the list you see is exactly the menu you'll get.
 *
 * Saved when you leave the field or press Enter, not per keystroke: half a
 * number ("1.") is not a speed, and saving it would be saving nonsense.
 */
export default function SpeedsEditor({ value, onChange }: {
  value: unknown
  onChange: (next: number[]) => void
}) {
  const saved = cleanSpeeds(value) ?? DEFAULT_SPEEDS
  const savedText = formatSpeeds(saved)
  const [text, setText] = useState(savedText)
  const [bad, setBad] = useState(false)

  // Follow the stored value when it changes under us — the save comes back from
  // the server, and Reset writes it from outside this field.
  useEffect(() => { setText(savedText); setBad(false) }, [savedText])

  const commit = () => {
    if (text.trim() === savedText) { setBad(false); return }
    const parsed = parseSpeeds(text)
    if (!parsed) { setBad(true); return }
    setBad(false)
    setText(formatSpeeds(parsed))
    if (formatSpeeds(parsed) !== savedText) onChange(parsed)
  }

  return (
    <div className="mt-2">
      <div className="flex items-center gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit() }
            // Leave the field the way it was, rather than half-edited.
            if (e.key === 'Escape') { setText(savedText); setBad(false) }
          }}
          aria-label={t('Playback speeds')}
          spellCheck={false}
          className={`min-w-0 flex-1 rounded-lg border bg-[#1c1c1c] px-3 py-2 font-mono text-xs text-[#ddd] ${
            bad ? 'border-[#5c2b2b]' : 'border-[#3f3f3f]'
          }`}
        />
        <button
          onClick={() => onChange(DEFAULT_SPEEDS)}
          disabled={savedText === formatSpeeds(DEFAULT_SPEEDS)}
          className="flex-shrink-0 cursor-pointer rounded-full border border-[#3f3f3f] px-3 py-1.5 text-xs text-[#ccc] hover:bg-white/5 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
        >
          {t('Reset')}
        </button>
      </div>
      <p className={`mt-1 text-xs ${bad ? 'text-[#e0a0a0]' : 'text-[#777]'}`}>
        {bad
          ? t('Speeds are numbers, up to {max} of them — like 0.5, 1, 1.5, 2.', { max: MAX_SPEEDS })
          : t('Separated by commas. Normal speed is always in the list.')}
      </p>
    </div>
  )
}
