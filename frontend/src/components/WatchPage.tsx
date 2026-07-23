import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from '../lib/api'
import type { ReactNode } from 'react'
import type { VideoItem } from '../App'
import { ensureYTApi } from './VideoCard'
import SaveToPlaylist from './SaveToPlaylist'
import { useVolume, setAudioVolume } from '../hooks/audioStore'

type Props = {
  videoId: string
  // Metadata when we arrived from a card (renders instantly, no fetch flash).
  // Absent on a cold load / back-forward, where we fetch by id instead.
  video?: VideoItem | null
  onChannelClick: (channelId: string) => void
  onDownload: (video: VideoItem) => void
  isDownloaded: boolean
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function timeAgo(iso: string): string {
  const then = new Date(iso.endsWith('Z') ? iso : iso + 'Z').getTime()
  const hours = Math.floor((Date.now() - then) / 3_600_000)
  if (hours < 1) return 'Just now'
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

// A timed caption cue from /feed/captions. `words` carries per-word timing (for
// auto-generated tracks) so we can reveal a line word-by-word; manual subs get a
// single word = the whole line.
type CaptionWord = { t: number; text: string }
type Cue = { start: number; dur: number; text: string; words?: CaptionWord[] }

/** A transcript line with the searched-for text marked. */
function highlight(text: string, query: string): ReactNode {
  const q = query.trim()
  if (!q) return text
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'))
  return parts.map((p, i) =>
    i % 2 ? <mark key={i} className="rounded bg-[#3ea6ff]/30 px-0.5 text-white">{p}</mark> : p
  )
}

/** Seconds → M:SS (H:MM:SS past the hour), for transcript row stamps. */
function formatTime(s: number): string {
  const t = Math.max(0, Math.floor(s))
  const mm = Math.floor(t / 60) % 60
  const ss = t % 60
  const hh = Math.floor(t / 3600)
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`
}

// H:MM:SS, MM:SS, or M:SS timestamps in a description → clickable seeks.
const TIMESTAMP_RE = /(?:(\d{1,2}):)?(\d{1,2}):([0-5]\d)/g

/** Split a plain (non-URL) chunk, turning timestamps into seek buttons. */
function withTimestamps(text: string, keyBase: string, onSeek: (s: number) => void): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  TIMESTAMP_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TIMESTAMP_RE.exec(text)) !== null) {
    const [full, hh, mm, ss] = m
    const total = (hh ? Number(hh) * 3600 : 0) + Number(mm) * 60 + Number(ss)
    if (m.index > last) nodes.push(text.slice(last, m.index))
    nodes.push(
      <button
        key={`${keyBase}-${m.index}`}
        onClick={() => onSeek(total)}
        className="text-blue-400 hover:underline"
      >
        {full}
      </button>
    )
    last = m.index + full.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/** Render a description with URLs as links and timestamps as seek buttons. */
function linkify(text: string, onSeek: (s: number) => void) {
  return text.split(/(https?:\/\/\S+)/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noreferrer noopener"
        className="text-blue-400 hover:underline [overflow-wrap:anywhere]"
      >
        {part}
      </a>
    ) : (
      <span key={i}>{withTimestamps(part, String(i), onSeek)}</span>
    )
  )
}

// A rendered caption line: its text and whether it came from a word-by-word
// (auto) track — which drives left-alignment vs centering.
type CaptionLine = { text: string; wordByWord: boolean }

// Sentinel for the second-subtitle slot meaning "AI-translate the main track into
// Traditional Chinese" rather than "use the video's own track for this language".
const AI_ZH = 'ai-zh'

// AI translation streams as playback approaches, the way a video buffers ahead —
// the first lines land in seconds on a long video and we never pay to translate a
// stretch nobody watches. It arrives as whole SENTENCES, not per-cue text: a cue
// is a mid-clause fragment whose split point doesn't survive translation (English
// trails its modifiers where Chinese leads them), so demanding a per-cue mapping
// makes the model drop lines. See the backend's `_to_sentences`.
const AI_SENTENCES = 10        // sentences per request
const AI_LOOKAHEAD_SEC = 20    // keep this many seconds ahead of the play head translated

// Caption preferences persist in localStorage so they carry across videos and
// sessions — the watch overlay remounts per video, re-reading these on mount.
const CAPTION_PREFS_KEY = 'ytfeed:caption-prefs'
type CaptionPrefs = { on: boolean; lang: string; lang2: string; mode: 'word' | 'sentence' }
function loadCaptionPrefs(): CaptionPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(CAPTION_PREFS_KEY) || '{}')
    return {
      on: p.on === true,
      lang: typeof p.lang === 'string' ? p.lang : '',
      // AI translation is never restored (see the persist effect) — drop it here
      // too, so a value saved before that rule can't auto-fire a translation.
      lang2: typeof p.lang2 === 'string' && p.lang2 !== AI_ZH ? p.lang2 : '',
      // 'line' is the old name for this mode — keep reading it so a saved
      // preference doesn't silently reset.
      mode: p.mode === 'sentence' || p.mode === 'line' ? 'sentence' : 'word',
    }
  } catch {
    return { on: false, lang: '', lang2: '', mode: 'word' }
  }
}

// The caption lines to show at `curTime` for one cue list. Auto-caption cues
// overlap in time (the next line starts while the previous is still up), which
// is how YouTube's rolling 2-line effect is encoded — so we show EVERY cue
// spanning curTime, oldest first. Each cue reveals its words up to the play head
// (a hair of lookahead hides the 120ms poll lag); a cue without per-word timing
// (manual subs) shows its whole line at once. Shared by the main + second tracks.
function linesAt(cues: Cue[] | null, curTime: number): CaptionLine[] {
  if (!cues?.length) return []
  return cues
    .filter((c) => c.start <= curTime && curTime < c.start + c.dur)
    .sort((a, b) => a.start - b.start)
    .map((c) => {
      // Reveal word-by-word only when the track carries per-word timing (auto
      // captions); manual/translated subs are one "word" = the whole cue.
      const wordByWord = !!c.words && c.words.length > 1
      const text = wordByWord
        ? c.words!.filter((w) => w.t <= curTime + 0.15).map((w) => w.text).join('').trim()
        : c.text
      return { text, wordByWord }
    })
    .filter((l) => l.text)
}

// A token whose text ends a sentence (Latin or CJK terminals, optional closing quote).
const SENTENCE_END = /[.!?。！？][")'”’」』]?\s*$/
const CJK = /[　-鿿＀-￯]/
// Where a too-long sentence may be broken, and how long "too long" is. Roughly two
// subtitle lines' worth: the Latin convention is ~42 characters a line, and CJK is
// far denser so it caps lower. Only word-segment tracks (English/Japanese, in
// practice) are ever chunked — see toSentences.
const BREAK_AFTER = /[,;:，、；：][")'”’」』]?\s*$/
const MAX_LINE_CHARS = 84
const MAX_CJK_LINE_CHARS = 36

/** Append one token to a running string, spacing Latin but not CJK. */
function appendToken(s: string, t: string): string {
  if (!t) return s
  if (!s) return t
  // Auto-word tokens carry their own leading space; add one only when neither
  // side already has whitespace and it isn't a CJK boundary (which needs none).
  const gap = !/\s$/.test(s) && !/^\s/.test(t) && !(CJK.test(s.slice(-1)) && CJK.test(t[0]))
  return s + (gap ? ' ' + t : t)
}

/** Join tokens [from, to) into one string, spacing Latin but not CJK. */
function joinTokens(toks: { t: number; text: string }[], from: number, to: number): string {
  let s = ''
  for (let i = from; i < to; i++) s = appendToken(s, toks[i].text)
  return s.trim()
}
// Group a cue list into whole SENTENCES for "Whole sentence" mode. Sentence ends fall
// *mid-cue* (tracks break lines at phrase boundaries, and rolling auto captions
// pack several phrases per cue), so we segment on the WORD stream, not on cues.
// Cue order is reading order and word times run sequentially even though the
// display cues overlap (the rolling 2-line effect), so flattening is safe. Each
// sentence shows until the next one begins. Memoize per cue list.
// `chunk` splits an over-long sentence into display-sized pieces — right for an
// on-video caption block, wrong for the transcript panel, which reads better as
// whole sentences and has the width to hold them.
function toSentences(cues: Cue[] | null, chunk = true): { start: number; end: number; text: string }[] {
  if (!cues?.length) return []
  // Does this track even use sentence punctuation? Chinese ASR often has none, so
  // there's nothing to merge on — showing one line per cue (each is already a
  // short phrase) beats collapsing the whole video into one block. Latin tracks
  // split sentences across cues, so they cross this bar and get merged below.
  const punctuated = cues.reduce((n, c) => n + (/[.!?。！？]/.test(c.text) ? 1 : 0), 0) / cues.length >= 0.05
  if (!punctuated) {
    return cues
      .map((c, i) => ({ start: c.start, end: i + 1 < cues.length ? cues[i + 1].start : Number.POSITIVE_INFINITY, text: c.text.trim() }))
      .filter((s) => s.text)
  }

  const toks: { t: number; text: string }[] = []
  for (const c of cues) {
    if (c.words && c.words.length) for (const w of c.words) toks.push({ t: w.t, text: w.text })
    else toks.push({ t: c.start, text: c.text })  // manual sub = one token (whole cue)
  }

  const sents: { start: number; text: string }[] = []
  let buf: { t: number; text: string }[] = []

  const flush = () => {
    if (!buf.length) return
    // A stitched sentence can run far longer than is readable in one block, so
    // break it into display-sized pieces. Only word-segment tracks reach here with
    // real tokens, so each piece takes an exact start from its own token.
    //
    // Pieces are sized EVENLY rather than greedily filled to the cap. Greedy
    // filling breaks at the last comma before the cap, which emits a runt whenever
    // the sentence's only comma sits near the start ("She woke up," + a full line)
    // and leaves a stray few words as the tail. So: decide up front how many
    // pieces are needed, then put each break as near its ideal length as possible,
    // treating a comma as a preference (a scoring bonus) rather than a command.
    const whole = joinTokens(buf, 0, buf.length)
    if (!chunk) {
      if (whole) sents.push({ start: buf[0].t, text: whole })
      buf = []
      return
    }
    const limit = CJK.test(whole) ? MAX_CJK_LINE_CHARS : MAX_LINE_CHARS
    const pieces = Math.ceil(whole.length / limit)
    const target = whole.length / pieces

    let from = 0
    for (let p = 1; p < pieces && from < buf.length; p++) {
      let best = -1
      let bestScore = Infinity
      let s = ''
      for (let i = from; i < buf.length - 1; i++) {
        s = appendToken(s, buf[i].text)
        const len = s.trim().length
        if (len > limit) break
        // Distance from the ideal length, with a comma worth a modest discount —
        // enough to prefer a nearby comma, not enough to accept a bad one.
        const score = Math.abs(len - target) - (BREAK_AFTER.test(buf[i].text) ? target * 0.25 : 0)
        if (score < bestScore) { bestScore = score; best = i }
      }
      if (best < 0) break
      const piece = joinTokens(buf, from, best + 1)
      if (piece) sents.push({ start: buf[from].t, text: piece })
      from = best + 1
    }
    const tail = joinTokens(buf, from, buf.length)
    if (tail) sents.push({ start: buf[from].t, text: tail })
    buf = []
  }

  for (const w of toks) {
    buf.push(w)
    if (SENTENCE_END.test(w.text)) flush()
  }
  flush()  // trailing run with no terminal punctuation

  return sents.map((s, i) => ({
    start: s.start,
    end: i + 1 < sents.length ? sents[i + 1].start : Number.POSITIVE_INFINITY,
    text: s.text,
  }))
}

// The whole-sentence line(s) to show now — one centered block per active sentence.
function sentenceLinesAt(sentences: { start: number; end: number; text: string }[], curTime: number): CaptionLine[] {
  return sentences
    .filter((s) => s.start <= curTime && curTime < s.end)
    .map((s) => ({ text: s.text, wordByWord: false }))
}

// One language's caption block, cloning youtube.com's rolling captions: per-line
// rgba(8,8,8,.75) box hugging the text, white sans-serif scaled to the player,
// stacked oldest-on-top. Word-by-word lines pin LEFT in a fixed-width box so a
// building line grows without shoving earlier words; whole-line (manual) subs
// center and use the full width. Rendered once for the main track and, with dual
// subtitles on, again for the second — the two blocks stack.
function CaptionBlock({ lines }: { lines: CaptionLine[] }) {
  // A track is all one kind, so if none are word-by-word they're manual subs.
  const manual = lines.every((l) => !l.wordByWord)
  return (
    <div
      style={{
        // Manual (centered) captions use the full width; word-by-word gets a
        // fixed ≈40-char box so its left edge stays put as words append.
        width: manual ? '100%' : 'min(90%, 20em)',
        // Measured from youtube.com's own player: 2.5%-of-width font, weight 400,
        // normal line-height, its exact font stack.
        fontFamily: '"YouTube Noto", Roboto, Arial, Helvetica, Verdana, "PT Sans Caption", sans-serif',
        fontSize: '2.5cqw',
        fontWeight: 400,
        lineHeight: 'normal',
        // YouTube renders captions with grayscale smoothing, which on macOS looks
        // lighter than the default subpixel — a big part of why ours read "bolder".
        WebkitFontSmoothing: 'antialiased',
        MozOsxFontSmoothing: 'grayscale',
      }}
    >
      {lines.map((line, i) => (
        // display:flex blockifies the span so its background fills the whole line
        // box (leading included) — stacked lines then abut with no gap, like
        // YouTube. Word-by-word lines pin left; whole-line (manual) captions center.
        <div key={i} style={{ display: 'flex', justifyContent: line.wordByWord ? 'flex-start' : 'center' }}>
          <span
            style={{
              color: '#fff',
              background: 'rgba(8, 8, 8, 0.75)',
              padding: '0 0.25em',  // YouTube: 0 vertical, ~6px horizontal
              textAlign: line.wordByWord ? 'left' : 'center',
            }}
          >
            {line.text}
          </span>
        </div>
      ))}
    </div>
  )
}

export default function WatchPage({ videoId, video, onChannelClick, onDownload, isDownloaded }: Props) {
  const [meta, setMeta] = useState<VideoItem | null>(video ?? null)
  // Fetched separately and never stored server-side (see /api/feed/description).
  // Usually a cache hit: hovering the card already warmed it.
  const [description, setDescription] = useState('')
  const [embedError, setEmbedError] = useState(false)
  const [showSavePanel, setShowSavePanel] = useState(false)
  const saveRef = useRef<HTMLDivElement>(null)
  // Pinned (default): the player holds its place and only the details below
  // scroll. Unpinned: the whole page scrolls, so a tall video can move away.
  const [pinned, setPinned] = useState(true)
  // Set by the stall watchdog when an unmuted autoplay gets blocked (it doesn't
  // error — it wedges on a buffering spinner). Flipping this recreates the
  // player muted, which always plays. Resets per video (overlay is keyed by id).
  const [forcedMuted, setForcedMuted] = useState(false)
  // Our own captions, rendered from the transcript so we control position/size
  // (the embed's are locked inside the iframe). `c` toggles them; curTime drives
  // the word-by-word reveal. Resets per video (the overlay is keyed by id).
  // Seed caption UI state from the persisted prefs (read once per mount).
  const prefsRef = useRef<CaptionPrefs | undefined>(undefined)
  if (!prefsRef.current) prefsRef.current = loadCaptionPrefs()
  const savedPrefs = prefsRef.current
  const [captions, setCaptions] = useState<Cue[] | null>(null)
  const [showCaptions, setShowCaptions] = useState(savedPrefs.on)
  const [curTime, setCurTime] = useState(0)
  // Language switcher for our captions. `captionLangs` = what this video offers
  // (empty until fetched / when none); `captionLang` = the user's pick ('' =
  // native default); `activeLang` = the base code the backend actually served,
  // so the menu can tick the right row even when native resolved to a language.
  const [captionLangs, setCaptionLangs] = useState<{ code: string; label: string }[]>([])
  // The native track's code, reported by /caption-langs. It's the same answer
  // /captions gives as `activeLang`, but arrives a round-trip earlier — the menu
  // would otherwise wait for a caption track to download before it could tell
  // whether the source is already Chinese (i.e. whether to offer AI translation).
  const [nativeLang, setNativeLang] = useState('')
  const [captionLang, setCaptionLang] = useState(savedPrefs.lang)
  const [activeLang, setActiveLang] = useState<string | null>(null)
  // Dual subtitles: an optional SECOND track rendered stacked under the main one
  // (e.g. original + translation, for language learning). '' = none.
  const [captions2, setCaptions2] = useState<Cue[] | null>(null)
  const [captionLang2, setCaptionLang2] = useState(savedPrefs.lang2)
  const [activeLang2, setActiveLang2] = useState<string | null>(null)
  // A saved pick is only honoured on a video that actually offers that language.
  // Asking the backend for one it doesn't have gets YouTube's machine TRANSLATION
  // of some other track — which is how a video with no Japanese captions ended up
  // showing a Japanese transcript, carried over from the last video watched. The
  // pref itself is left alone: it still applies to the next video that has it.
  const offersLang = (code: string) => captionLangs.some((l) => l.code === code)
  const effCaptionLang = !captionLang || !captionLangs.length || offersLang(captionLang) ? captionLang : ''
  const effCaptionLang2 = !captionLang2 || captionLang2 === AI_ZH || !captionLangs.length || offersLang(captionLang2)
    ? captionLang2
    : ''
  // AI translation is a slow LLM round-trip on a cache miss, so the menu shows
  // progress instead of looking broken.
  const [translating, setTranslating] = useState(false)
  // Translated sentences with the time span each covers, accumulated as playback
  // advances. Sparse: only what's been reached (plus the read-ahead) is translated.
  const [aiSents, setAiSents] = useState<{ start: number; end: number; text: string }[]>([])
  // One request at a time, so the 120ms play-head tick can't pile up duplicates.
  // A ref: this must not trigger a re-render.
  const aiBusy = useRef(false)
  // Play-head positions already asked about, so an uncoverable one is tried once.
  const aiTried = useRef<Set<number>>(new Set())
  // Caption display mode: 'word' reveals word-by-word when the track carries
  // per-word timing (the default); 'sentence' stitches cues into whole sentences
  // and shows each at once, centered. Applies to both the main and second tracks.
  const [captionMode, setCaptionMode] = useState<'word' | 'sentence'>(savedPrefs.mode)
  const [showCaptionMenu, setShowCaptionMenu] = useState(false)
  const captionMenuRef = useRef<HTMLDivElement>(null)
  // The transcript panel beside the video's details — closed until asked for,
  // since it's a long read most visits don't want.
  const [showTranscript, setShowTranscript] = useState(false)
  // The "…" overflow menu next to Save, holding download + the transcript toggle.
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  const activeRowRef = useRef<HTMLButtonElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  // Whether the transcript still tracks the play head. Scrolling away turns it off
  // and raises the sync button; that button (or a row click) turns it back on.
  const [following, setFollowing] = useState(true)
  const [transcriptQuery, setTranscriptQuery] = useState('')
  // Transient volume HUD shown while adjusting with the keyboard, YouTube-style.
  const [volHint, setVolHint] = useState<{ vol: number; muted: boolean } | null>(null)
  const volHintTimer = useRef<number | undefined>(undefined)
  const showVolHint = (vol: number, muted: boolean) => {
    setVolHint({ vol, muted })
    if (volHintTimer.current) window.clearTimeout(volHintTimer.current)
    volHintTimer.current = window.setTimeout(() => setVolHint(null), 900)
  }
  useEffect(() => () => { if (volHintTimer.current) window.clearTimeout(volHintTimer.current) }, [])
  const hostRef = useRef<HTMLDivElement>(null)
  // The player box wraps the iframe AND our overlays (HUD, pin). It is both the
  // fullscreen target — so the HUD is inside the fullscreen layer and the video
  // still fills the screen — and the keyboard-focus target, so our shortcut
  // handler owns the keyboard instead of the cross-origin iframe (which would
  // otherwise swallow its own key events, in fullscreen especially).
  const playerBoxRef = useRef<HTMLDivElement>(null)
  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`

  // Share the preview volume: apply it to the watch player, follow live changes,
  // and mirror the player's own volume back so the value stays shared everywhere.
  const volume = useVolume()
  const volumeRef = useRef(volume)
  volumeRef.current = volume
  const playerRef = useRef<{
    setVolume: (v: number) => void
    getVolume: () => number
    isMuted: () => boolean
    mute: () => void
    unMute: () => void
    playVideo: () => void
    pauseVideo: () => void
    getPlayerState: () => number
    getCurrentTime: () => number
    seekTo: (seconds: number, allowSeekAhead: boolean) => void
  } | null>(null)

  // Jump to a description timestamp and play from there.
  const seekTo = (seconds: number) => {
    const p = playerRef.current
    if (!p) return
    p.seekTo(seconds, true)
    p.playVideo()
  }

  // Close the "…" menu on an outside click.
  useEffect(() => {
    if (!showMoreMenu) return
    const onDown = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setShowMoreMenu(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [showMoreMenu])

  // Close the save-to-playlist popover on an outside click.
  useEffect(() => {
    if (!showSavePanel) return
    const onDown = (e: MouseEvent) => {
      if (saveRef.current && !saveRef.current.contains(e.target as Node)) setShowSavePanel(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [showSavePanel])

  // Show whatever we arrived with instantly, then enrich from the endpoint
  // (description + fresh stats). On a cold load `video` is null and this is the
  // only source of metadata.
  useEffect(() => {
    setMeta(video ?? null)
    let cancelled = false
    apiFetch(`/api/feed/video/${videoId}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d && d.youtube_id) setMeta(d) })
      .catch(() => { /* keep the card metadata / minimal chrome */ })
    return () => { cancelled = true }
  }, [videoId, video])

  useEffect(() => {
    setDescription('')
    let cancelled = false
    apiFetch(`/api/feed/description/${videoId}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setDescription(d?.description || '') })
      .catch(() => { /* no description box */ })
    return () => { cancelled = true }
  }, [videoId])

  // Prefetch the transcript so `c` toggles instantly. [] = no captions available.
  // Refetches when the chosen language changes; the response's `lang` is the base
  // code actually served (native resolves to a real language), tracked for the menu.
  useEffect(() => {
    setCaptions(null)
    let cancelled = false
    const q = effCaptionLang ? `?lang=${effCaptionLang}` : ''
    apiFetch(`/api/feed/captions/${videoId}${q}`, { quiet: true })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        setCaptions(Array.isArray(d?.cues) ? d.cues : [])
        setActiveLang(d?.lang ?? null)
      })
      .catch(() => { if (!cancelled) setCaptions([]) })
    return () => { cancelled = true }
  }, [videoId, effCaptionLang])

  // The second (dual-subtitle) track, for a real language the video provides.
  // AI translation doesn't come through here — it streams in blocks below.
  useEffect(() => {
    if (!effCaptionLang2 || effCaptionLang2 === AI_ZH) { setCaptions2(null); setActiveLang2(null); return }
    setCaptions2(null)
    let cancelled = false
    apiFetch(`/api/feed/captions/${videoId}?lang=${effCaptionLang2}`, { quiet: true })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        setCaptions2(Array.isArray(d?.cues) ? d.cues : [])
        setActiveLang2(d?.lang ?? null)
      })
      .catch(() => { if (!cancelled) setCaptions2([]) })
    return () => { cancelled = true }
  }, [videoId, effCaptionLang2])

  // Reset the translation buffer whenever the video or the source track changes.
  useEffect(() => {
    setAiSents([])
    aiBusy.current = false
    aiTried.current = new Set()
    setTranslating(false)
  }, [videoId, effCaptionLang, captionLang2])

  // Translate ahead of the play head, like a video buffering. Runs on the caption
  // tick: walks the contiguous translated span forward from the play head and, if
  // it doesn't reach far enough ahead, asks for the next run of sentences from
  // there. A seek needs no special case — it just lands somewhere uncovered, and
  // the same check fetches that spot next.
  useEffect(() => {
    if (captionLang2 !== AI_ZH || !showCaptions || !captions?.length) return
    if (aiBusy.current) return

    const target = curTime + AI_LOOKAHEAD_SEC
    let at = curTime
    for (;;) {
      const covering = aiSents.find((s) => s.start <= at && at < s.end)
      if (!covering) break
      at = covering.end
      if (at >= target) return  // buffered far enough ahead
    }

    // Some positions can never be covered: past the last sentence (the final
    // AI_LOOKAHEAD_SEC of every video walks off the end), or a gap the model left
    // empty. Without this the walk breaks, we refetch the same spot, the response
    // doesn't extend coverage, and the effect fires again — an endless request
    // loop that flickered the menu between "翻譯中…" and "AI" on a fully
    // translated video. One attempt per position; a failure clears it to retry.
    const spot = Math.round(at)
    if (aiTried.current.has(spot)) return
    aiTried.current.add(spot)

    aiBusy.current = true
    setTranslating(true)
    apiFetch(
      `/api/feed/captions-translate/${videoId}?lang=${effCaptionLang}&at=${at}&count=${AI_SENTENCES}`,
      { quiet: true }
    )
      .then((r) => r.json())
      .then((d) => {
        const got = Array.isArray(d?.sentences) ? d.sentences : []
        if (got.length) {
          setAiSents((prev) => {
            const byStart = new Map(prev.map((s) => [s.start, s]))
            got.forEach((s: { start: number; end: number; text: string }) => byStart.set(s.start, s))
            return [...byStart.values()].sort((a, b) => a.start - b.start)
          })
        }
        setActiveLang2(d?.lang ?? null)
      })
      .catch(() => { aiTried.current.delete(spot) /* transient — let a later tick retry */ })
      .finally(() => {
        aiBusy.current = false
        setTranslating(false)
      })
  }, [captionLang2, showCaptions, captions, curTime, aiSents, videoId, effCaptionLang])

  // Persist caption prefs so they carry to the next video and next session — but
  // never the AI selection. Restoring that would fire a translation (real tokens,
  // real latency) on every video you open, without you asking for it; it stays an
  // explicit per-video opt-in.
  useEffect(() => {
    try {
      localStorage.setItem(CAPTION_PREFS_KEY, JSON.stringify({
        on: showCaptions,
        lang: captionLang,
        lang2: captionLang2 === AI_ZH ? '' : captionLang2,
        mode: captionMode,
      }))
    } catch { /* storage disabled — prefs just won't persist */ }
  }, [showCaptions, captionLang, captionLang2, captionMode])

  // Which of English/Chinese/Japanese/Korean this video offers (native, uploaded,
  // or auto-translated) — populates the caption language switcher.
  useEffect(() => {
    let cancelled = false
    apiFetch(`/api/feed/caption-langs/${videoId}`, { quiet: true })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        setCaptionLangs(Array.isArray(d?.langs) ? d.langs : [])
        setNativeLang(typeof d?.native === 'string' ? d.native : '')
      })
      .catch(() => { if (!cancelled) { setCaptionLangs([]); setNativeLang('') } })
    return () => { cancelled = true }
  }, [videoId])

  // Close the caption menu on an outside click (mirrors the save popover).
  useEffect(() => {
    if (!showCaptionMenu) return
    const onDown = (e: MouseEvent) => {
      if (captionMenuRef.current && !captionMenuRef.current.contains(e.target as Node)) setShowCaptionMenu(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [showCaptionMenu])

  // While captions are on, sample the play position to drive the word reveal. The
  // open transcript needs the same tick to follow along, at a lazier rate — its
  // highlight moves once a sentence, so 120ms would be ~8 renders per useful change.
  useEffect(() => {
    if (!showCaptions && !showTranscript) return
    const id = window.setInterval(() => {
      const p = playerRef.current
      if (p) setCurTime(p.getCurrentTime())
    }, showCaptions ? 120 : 500)
    return () => window.clearInterval(id)
  }, [showCaptions, showTranscript])

  // The main and (dual-subtitle) second caption lines to show now — see linesAt.
  // The second track's cues. For a real language that's the fetched track; for AI
  // translation it's the MAIN track's timings zipped with whatever text has been
  // translated so far (translation is 1:1 with the main cues), so partially
  // buffered stretches simply render as far as they've got.
  const secondCues = useMemo(() => {
    if (captionLang2 !== AI_ZH) return captions2
    // Each translated sentence is already a whole line covering its own span.
    return aiSents.map((s) => ({
      start: s.start, dur: s.end - s.start, text: s.text,
      words: [{ t: s.start, text: s.text }],
    }))
  }, [captionLang2, captions2, aiSents])

  // Sentence groupings for "Whole sentence" mode (independent of curTime, so memoize
  // per cue list rather than recomputing every poll tick).
  const sentences = useMemo(() => toSentences(captions), [captions])
  const sentences2 = useMemo(() => toSentences(secondCues), [secondCues])

  // An open transcript on a wide screen turns the details pane into a fixed-height
  // two-column layout. Only while pinned: unpinned, the page itself scrolls and
  // there's no pane height to fill.
  const twoCol = showTranscript && !!captions?.length
  const fillsPane = pinned && twoCol

  // The transcript reads as sentences whatever the on-video caption mode is: the
  // rolling word-segment fragments a player shows make for terrible prose. Unlike
  // the caption block it keeps each sentence whole (no display-width chunking).
  const transcript = useMemo(() => toSentences(captions, false), [captions])
  const activeRow = useMemo(() => {
    if (!showTranscript) return -1
    let i = -1
    while (i + 1 < transcript.length && transcript[i + 1].start <= curTime + 0.05) i++
    return i
  }, [showTranscript, transcript, curTime])

  // Centre the active row in the transcript's own box — scrollIntoView would drag
  // the whole details column along with it. Measured from the rects rather than
  // offsetTop: the row's offsetParent is an ancestor of the box, so its offsetTop
  // is in the wrong coordinate space and lands the row off-centre.
  // The jump is instant, not smooth: a smooth scroll emits scroll events the whole
  // way, and for most of that trip the active row is still off-screen, so
  // onTranscriptScroll would read it as the reader scrolling away and cancel the
  // very scroll that's running. Instant lands in one event with the row already
  // centred, and the hops are one sentence long anyway.
  const centerActiveRow = () => {
    const row = activeRowRef.current
    const box = transcriptRef.current
    if (!row || !box) return
    const delta = row.getBoundingClientRect().top - box.getBoundingClientRect().top
    box.scrollTo({ top: box.scrollTop + delta - (box.clientHeight - row.clientHeight) / 2 })
  }

  // The rows on screen, each carrying its index in the full transcript so the
  // active-row highlight survives filtering. A search narrows the list rather than
  // just marking hits: the point is to find a moment, then click into it.
  const searching = transcriptQuery.trim().length > 0
  const visibleRows = useMemo(() => {
    const q = transcriptQuery.trim().toLowerCase()
    const rows = transcript.map((s, i) => ({ s, i }))
    return q ? rows.filter(({ s }) => s.text.toLowerCase().includes(q)) : rows
  }, [transcript, transcriptQuery])

  // Follow the play head, unless the reader has scrolled away (see
  // onTranscriptScroll) or is searching — a filtered list is theirs to read.
  useEffect(() => {
    if (following && !searching) centerActiveRow()
  }, [activeRow, showTranscript, following, searching])

  // Reading somewhere else stops the auto-scroll fighting the reader. "Somewhere
  // else" = the active row scrolled out of the box; our own centering leaves it
  // centred, so this needs no flag to tell programmatic scrolls from real ones.
  const onTranscriptScroll = () => {
    const row = activeRowRef.current
    const box = transcriptRef.current
    if (!row || !box) return
    const r = row.getBoundingClientRect()
    const b = box.getBoundingClientRect()
    setFollowing(r.bottom > b.top && r.top < b.bottom)
  }

  // A new video (or reopening the panel) starts back in sync, with a clean search.
  useEffect(() => { setFollowing(true); setTranscriptQuery('') }, [videoId, showTranscript])

  // "Whole sentence" ONLY transforms word-segment tracks — auto captions that reveal
  // word-by-word (some cue carries per-word timing). It stitches their rolling
  // fragments back into whole sentences. Whole-cue tracks (manual/translated subs,
  // and word-less ASR) are already whole lines authored by the source, so the mode
  // is a no-op for them: we render their cues as-is in both modes.
  const captionLines = useMemo(
    () => {
      if (!showCaptions) return []
      const wordSegment = !!captions?.some((c) => c.words && c.words.length > 1)
      return captionMode === 'sentence' && wordSegment ? sentenceLinesAt(sentences, curTime) : linesAt(captions, curTime)
    },
    [showCaptions, captionMode, sentences, captions, curTime]
  )
  const captionLines2 = useMemo(
    () => {
      if (!showCaptions || !captionLang2) return []
      // A persisted second language can coincide with the main once the main
      // resolves (e.g. native → zh, saved second also zh) — don't show it twice.
      if (activeLang2 && activeLang2 === activeLang) return []
      const wordSegment = !!secondCues?.some((c) => c.words && c.words.length > 1)
      return captionMode === 'sentence' && wordSegment ? sentenceLinesAt(sentences2, curTime) : linesAt(secondCues, curTime)
    },
    [showCaptions, captionLang2, sentences2, secondCues, curTime, captionMode, activeLang, activeLang2]
  )

  // Second-subtitle choices: the video's other provided languages, plus an AI
  // translation into Traditional Chinese — offered only once we know the main
  // track's language and it isn't already Chinese.
  const mainLang = activeLang || effCaptionLang || nativeLang
  const secondLangOptions = captionLangs.filter((l) => l.code !== mainLang)
  // `nativeLang` stands in until the track itself resolves, so the row appears
  // with the rest of the menu rather than a round-trip later.
  const aiSourceLang = activeLang || (effCaptionLang || nativeLang)
  const aiTranslateAvailable = !!aiSourceLang && aiSourceLang !== 'zh'

  // The reveal toggle only means something for a word-segment track — a whole-cue
  // track is already whole lines, so it would be a control that does nothing. It
  // hangs off the main track's row, so only that track decides whether it shows.
  const mainIsWordSegment = !!captions?.some((c) => c.words && c.words.length > 1)

  // Create the full-size player. Opening the page is a click (a page gesture), so
  // we FIRST try unmuted autoplay — when the browser honors it, the video plays
  // with sound immediately (no muted-start, no audio-refetch spinner). But the
  // browser can still block it (no gesture on a cold load / refresh, or Chrome
  // deciding the origin lacks media engagement), and a blocked unmuted autoplay
  // doesn't error — it wedges on a buffering spinner. So a watchdog checks
  // whether playback actually started; if not, it recreates the player MUTED,
  // which always plays (unmute via the embed's speaker — that click is a real
  // gesture inside the iframe, so the audio loads properly).
  useEffect(() => {
    setEmbedError(false)
    const hasGesture = typeof navigator !== 'undefined' && navigator.userActivation
      ? navigator.userActivation.hasBeenActive
      : true
    const startMuted = !hasGesture || forcedMuted
    let player: { destroy: () => void } | null = null
    let cancelled = false
    let watchdog: number | undefined
    ensureYTApi().then(() => {
      if (cancelled || !hostRef.current) return
      // YT.Player replaces the node it's given with an iframe, so hand it a fresh
      // child that React never reconciles (mirrors the VideoCard preview pattern).
      const el = document.createElement('div')
      el.style.width = '100%'
      el.style.height = '100%'
      hostRef.current.innerHTML = ''
      hostRef.current.appendChild(el)
      player = new window.YT.Player(el, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: {
          autoplay: 1, mute: startMuted ? 1 : 0, controls: 1, rel: 0, modestbranding: 1, playsinline: 1, fs: 1,
        },
        events: {
          onReady: (e) => {
            playerRef.current = e.target
            e.target.setVolume(volumeRef.current)
            // Focus the player box (not the iframe) so OUR shortcut handler
            // owns the keyboard from the start — including ArrowUp/Down for
            // volume, which the embedded iframe doesn't handle, and f/m, which
            // otherwise only work while the iframe holds focus.
            playerBoxRef.current?.focus()
            // Stall watchdog for the unmuted attempt: if we're not actually
            // PLAYING within 4s of ready, the autoplay was blocked → rebuild
            // muted rather than spinning forever.
            if (!startMuted) {
              const readyAt = Date.now()
              watchdog = window.setInterval(() => {
                const p = playerRef.current
                if (!p) return
                if (p.getPlayerState() === 1) { window.clearInterval(watchdog); return }
                if (Date.now() - readyAt > 4000) {
                  window.clearInterval(watchdog)
                  if (!cancelled) setForcedMuted(true)
                }
              }, 250)
            }
          },
          // 101 / 150 = embedding disabled by the uploader — fall back to YouTube.
          onError: () => { if (!cancelled) setEmbedError(true) },
        },
      })
    })
    return () => {
      cancelled = true
      if (watchdog) window.clearInterval(watchdog)
      playerRef.current = null
      try { player?.destroy() } catch { /* already gone */ }
      if (hostRef.current) hostRef.current.innerHTML = ''
    }
  }, [videoId, forcedMuted])

  // Store → player: apply shared-volume changes to a live player.
  useEffect(() => { playerRef.current?.setVolume(volume) }, [volume])

  // Player → store: if you change volume with the embed's own control, push it
  // back so previews follow. (No update while muted — that shouldn't zero it.)
  useEffect(() => {
    const id = setInterval(() => {
      const p = playerRef.current
      if (!p || p.isMuted()) return
      const v = Math.round(p.getVolume())
      if (v >= 0 && v !== volumeRef.current) setAudioVolume(v)
    }, 1000)
    return () => clearInterval(id)
  }, [])

  // Player keyboard shortcuts, handled at the window level so they work wherever
  // focus is on the page (the details below, the action pills, empty space) —
  // not only while the cross-origin iframe holds focus. We drive the player
  // through the IFrame API and preventDefault so keys don't scroll the page.
  //
  // ArrowUp/Down (volume) is implemented here on purpose: YouTube's *embedded*
  // iframe doesn't bind them to volume the way youtube.com does, so focusing the
  // video can't help — we adjust the shared volume ourselves. (Any of these can
  // only fire while focus isn't trapped inside the iframe, since a cross-origin
  // iframe swallows its own key events; that's why we focus the container above.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
        || (t instanceof HTMLElement && t.isContentEditable)) return
      const p = playerRef.current
      if (!p) return
      const k = e.key
      if (e.code === 'Space' || k === 'k') {
        e.preventDefault()
        if (p.getPlayerState() === 1) p.pauseVideo(); else p.playVideo()
      } else if (k === 'm') {
        e.preventDefault()
        const willMute = !p.isMuted()
        if (willMute) p.mute(); else p.unMute()
        showVolHint(volumeRef.current, willMute)
      } else if (k === 'f') {
        e.preventDefault()
        // Fullscreen OUR box, not the iframe. A fullscreen cross-origin iframe
        // traps keyboard focus (our shortcuts die, YouTube's native ones take
        // over) and still doesn't give a clean pause — so the box wins: our
        // overlays and shortcuts keep working, at the cost of YouTube's inline
        // pause UI showing the control bar.
        if (document.fullscreenElement) document.exitFullscreen()
        else playerBoxRef.current?.requestFullscreen?.()
      } else if (k === 'ArrowUp' || k === 'ArrowDown') {
        e.preventDefault()
        const next = Math.max(0, Math.min(100, Math.round(volumeRef.current + (k === 'ArrowUp' ? 5 : -5))))
        if (k === 'ArrowUp' && p.isMuted()) p.unMute()  // raising volume unmutes, like YouTube
        volumeRef.current = next  // update now so key-repeat bursts accumulate (ref lags a render)
        setAudioVolume(next)  // shared store → applies to the player and previews
        showVolHint(next, k !== 'ArrowUp' && p.isMuted())
      } else if (k === 'c') {
        // Toggle OUR caption overlay (rendered from the transcript). YouTube's
        // native `c` only works while the iframe is focused, which we avoid.
        e.preventDefault()
        setShowCaptions((v) => !v)
      } else if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'j' || k === 'l') {
        e.preventDefault()
        const step = (k === 'j' || k === 'l' ? 10 : 5) * (k === 'ArrowLeft' || k === 'j' ? -1 : 1)
        p.seekTo(Math.max(0, p.getCurrentTime() + step), true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Keep the keyboard on our handler even after the user clicks the video.
  // Clicking a cross-origin iframe moves focus into it, and it then swallows its
  // own key events — so ArrowUp/Down (and f/m) would stop working. When we see
  // the iframe has taken focus, pull it back to the player box; the click's own
  // action (play/pause) has already happened. This runs in fullscreen too — the
  // player box IS the fullscreen element, so refocusing it is allowed and is
  // what lets `f` reliably exit after a click landed in the video.
  useEffect(() => {
    const onBlur = () => {
      window.setTimeout(() => {
        const iframe = hostRef.current?.querySelector('iframe')
        if (iframe && document.activeElement === iframe) {
          // A click landed in the video. document-level "outside click" listeners
          // never fire for it (the cross-origin iframe swallows the mousedown), so
          // dismiss the caption menu here instead, then reclaim keyboard focus.
          setShowCaptionMenu(false)
          playerBoxRef.current?.focus()
        }
      }, 0)
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [])

  // The caption + volume overlays. Rendered inside the player box, which is also
  // the fullscreen target, so they show in both windowed and fullscreen modes.
  const overlays = (
    <>
      {/* Caption overlay — the main track, plus the optional second (dual-
          subtitle) track stacked beneath it. Bottom-anchored above the control
          bar so new lines push the stack upward; see CaptionBlock for styling. */}
      {showCaptions && (captionLines.length > 0 || captionLines2.length > 0) && (
        <div
          className="pointer-events-none absolute inset-x-0 z-10 flex flex-col items-center gap-[2px] px-[5%]"
          // Sit above the control bar. 11% of the player height tracks the bar
          // on big players, but on a short player the embed scales the bar UP
          // ("big mode"), so it dips into 11% — the 5.5rem floor clears the
          // scrubber (measured ~73px above the bottom on a 281px-tall player).
          style={{ bottom: 'max(11%, 5.5rem)' }}
        >
          {/* With AI translation on, the Chinese is what you're actually reading,
              so it takes the top (primary) line and the source track sits under it
              for reference. A real second-language track stays secondary. */}
          {captionLang2 === AI_ZH && captionLines2.length > 0 && <CaptionBlock lines={captionLines2} />}
          {captionLines.length > 0 && <CaptionBlock lines={captionLines} />}
          {captionLang2 !== AI_ZH && captionLines2.length > 0 && <CaptionBlock lines={captionLines2} />}
        </div>
      )}

      {/* Volume HUD — a brief overlay while adjusting volume / mute by keyboard. */}
      {volHint && (
        <div className="pointer-events-none absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/75 px-3 py-1.5 text-white shadow-lg">
          <svg className="h-5 w-5 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            {volHint.muted || volHint.vol === 0 ? (
              <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3 2.7-2.7a1 1 0 0 0-1.4-1.4L14.1 10.6l-.1.1V13.4l2.9 2.9a1 1 0 0 0 1.4-1.4L16.5 12z" />
            ) : (
              <path d="M3 9v6h4l5 5V4L7 9H3zm11.5 3a4 4 0 0 0-2.2-3.6v7.2A4 4 0 0 0 14.5 12z" />
            )}
          </svg>
          {volHint.muted ? (
            <span className="text-sm font-medium">Muted</span>
          ) : (
            <>
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/25">
                <div className="h-full rounded-full bg-white" style={{ width: `${volHint.vol}%` }} />
              </div>
              <span className="w-9 text-right text-sm font-medium tabular-nums">{volHint.vol}%</span>
            </>
          )}
        </div>
      )}
    </>
  )

  return (
    // Pinned: a fixed column where the player stays put and the details scroll on
    // their own. Unpinned: a plain block, so the overlay scrolls the whole thing.
    <div className={pinned ? 'flex h-full flex-col' : 'w-full'}>
      {/* Full-bleed player: full width, square corners, no side padding. Keeps its
          natural 16:9 height in both modes (shrink-0 so the flex column can't
          squash it while pinned). Focusable + the fullscreen target (see refs). */}
      <div
        ref={playerBoxRef}
        tabIndex={-1}
        // container-type so captions can size by player width (2.5cqw ≈ YouTube's
        // 2.5%-of-player-width caption size), matching at any player scale.
        style={{ containerType: 'inline-size' }}
        className={`relative w-full bg-black outline-none aspect-video [&:fullscreen]:aspect-auto ${pinned ? 'shrink-0' : ''}`}
      >
        <div ref={hostRef} className="absolute inset-0" />

        {/* Caption + volume-HUD overlays (defined above). They stay inside the
            box, which is also the fullscreen target, so they show in fullscreen. */}
        {overlays}

        {/* Caption language switcher — a third button in the player's bottom-left
            row, sitting just right of the embed's built-in share / watch-later
            buttons (which live at a fixed offset inside the iframe) and matching
            their ~44px size. Only shown when the video offers a track in one of our
            languages. Picking a language turns captions on and re-renders from that
            track; "Off" hides them (same as the `c` shortcut). */}
        {captionLangs.length > 0 && (
          <div ref={captionMenuRef} className="absolute bottom-[14px] left-[8.25rem] z-20">
            {showCaptionMenu && (
              <div className="absolute bottom-full left-0 mb-2 min-w-[10rem] overflow-hidden rounded-lg bg-[#282828] py-1 text-sm text-white shadow-2xl ring-1 ring-white/10">
                <div className="px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-[#888]">Subtitles</div>
                <button
                  onClick={() => setShowCaptions(false)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/10"
                >
                  <span className="w-4 shrink-0">{!showCaptions && '✓'}</span>
                  Off
                </button>
                {captionLangs.map((l) => {
                  const active = showCaptions && (activeLang === l.code || captionLang === l.code)
                  return (
                    <Fragment key={l.code}>
                      <button
                        onClick={() => { setCaptionLang(l.code); setShowCaptions(true) }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/10"
                      >
                        <span className="w-4 shrink-0">{active && '✓'}</span>
                        {l.label}
                      </button>
                      {/* Reveal words as they're spoken. Nested under the track
                          because it's a property OF that track, and only offered
                          when the track actually carries per-word timing —
                          otherwise it's a control that does nothing. Off = the
                          cues are stitched into whole sentences instead. */}
                      {active && mainIsWordSegment && (
                        <button
                          onClick={() => setCaptionMode(captionMode === 'word' ? 'sentence' : 'word')}
                          className="flex w-full items-center gap-2 py-1.5 pl-9 pr-3 text-left text-[13px] text-[#bbb] hover:bg-white/10"
                        >
                          <span className="w-4 shrink-0">{captionMode === 'word' && '✓'}</span>
                          As spoken
                        </button>
                      )}
                    </Fragment>
                  )
                })}

                {/* Second subtitles (dual) — shown once the main track is on and
                    the video offers another language. Excludes the main language
                    so the same track can't be picked twice. */}
                {showCaptions && (secondLangOptions.length > 0 || aiTranslateAvailable) && (
                  <>
                    <div className="mt-1 border-t border-white/10 px-3 pb-1.5 pt-2 text-xs font-medium uppercase tracking-wide text-[#888]">Second subtitles</div>
                    <button
                      onClick={() => setCaptionLang2('')}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/10"
                    >
                      <span className="w-4 shrink-0">{!captionLang2 && '✓'}</span>
                      Off
                    </button>
                    {secondLangOptions.map((l) => {
                      const active = captionLang2 === l.code
                      return (
                        <button
                          key={l.code}
                          onClick={() => setCaptionLang2(l.code)}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/10"
                        >
                          <span className="w-4 shrink-0">{active && '✓'}</span>
                          {l.label}
                        </button>
                      )
                    })}
                    {/* AI translation — only when the main track isn't Chinese. */}
                    {aiTranslateAvailable && (
                      <button
                        onClick={() => setCaptionLang2(AI_ZH)}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/10"
                      >
                        <span className="w-4 shrink-0">{captionLang2 === AI_ZH && '✓'}</span>
                        中文（繁體）
                        <span className="ml-auto pl-2 text-xs text-[#888]">
                          {captionLang2 === AI_ZH && translating ? '翻譯中…' : 'AI'}
                        </span>
                      </button>
                    )}
                  </>
                )}

              </div>
            )}
            <button
              onClick={() => setShowCaptionMenu((o) => !o)}
              className="group relative flex h-11 w-11 items-center justify-center text-white"
              title="Subtitles / captions"
              aria-pressed={showCaptions}
            >
              {/* 40px Material-style hover circle, centered in the 44px hit area. */}
              <span className="pointer-events-none absolute inset-0 m-auto h-10 w-10 rounded-full transition-colors group-hover:bg-white/10" />
              {/* YouTube's exact CC glyph (filled), sized to match the embed's
                  own bottom-left buttons. A stroke-drawn version reads thinner and
                  smaller even at the same 24px viewBox. */}
              <svg className="relative h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M21 3H3a2 2 0 00-2 2v14a2 2 0 002 2h18a2 2 0 002-2V5a2 2 0 00-2-2ZM3 19V5h18v14H3ZM6.972 8.346c-.631.336-1.131.881-1.466 1.526A4.6 4.6 0 005 12c-.004.74.17 1.47.506 2.128.336.645.835 1.191 1.466 1.526a2.86 2.86 0 002.066.257c.697-.178 1.294-.606 1.737-1.176a1 1 0 00-1.578-1.228c-.21.27-.444.413-.654.467a.86.86 0 01-.632-.085c-.222-.119-.453-.342-.631-.684A2.64 2.64 0 017 12a2.6 2.6 0 01.281-1.205c.177-.342.408-.565.63-.684a.86.86 0 01.632-.085c.209.054.444.197.654.467a1 1 0 001.578-1.228c-.443-.57-1.04-.998-1.737-1.176a2.86 2.86 0 00-2.066.257Zm8 0c-.631.336-1.131.881-1.466 1.526A4.6 4.6 0 0013 12c-.004.74.17 1.47.506 2.128.336.645.835 1.191 1.466 1.526a2.86 2.86 0 002.066.257c.697-.178 1.294-.606 1.737-1.176a1 1 0 00-1.578-1.228c-.21.27-.444.413-.654.467a.86.86 0 01-.632-.085c-.222-.119-.453-.342-.631-.684A2.64 2.64 0 0115 12a2.6 2.6 0 01.281-1.205c.177-.342.408-.565.63-.684a.86.86 0 01.632-.085c.209.054.444.197.654.467a1 1 0 001.578-1.228c-.443-.57-1.04-.998-1.737-1.176a2.86 2.86 0 00-2.066.257Z" />
              </svg>
              {/* Active indicator: a YouTube-style underline (no background
                  circle, to match the embed's bare share / watch-later buttons). */}
              {showCaptions && (
                <span className="pointer-events-none absolute bottom-[7px] left-1/2 h-[3px] w-[18px] -translate-x-1/2 rounded-sm bg-white" />
              )}
            </button>
          </div>
        )}

        {/* Pin toggle, bottom-right corner — equal 8px gap on the bottom and
            right, sat on the button-row line so it clears the progress scrubber. */}
        <button
          onClick={() => setPinned((p) => !p)}
          className="absolute bottom-2 right-2 z-20 rounded-full bg-black/60 p-2 text-white hover:bg-black/80 transition-colors"
          title={pinned ? 'Unpin — scroll the whole page' : 'Pin — keep the video in view'}
          aria-pressed={pinned}
        >
          {pinned ? (
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 3a1 1 0 0 1 .117 1.993L16 5v4.764l1.447 2.895c.55 1.098-.2 2.38-1.41 2.34L16 15h-3v5a1 1 0 0 1-1.993.117L11 20v-5H8c-1.23.05-2.02-1.2-1.51-2.28l.063-.125L8 9.764V5a1 1 0 0 1-.117-1.993L8 3h8z" />
            </svg>
          ) : (
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v5M8 9.5V5h8v4.5l1.5 3H6.5L8 9.5z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4l16 16" />
            </svg>
          )}
        </button>

        {embedError && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-black/95 px-6 text-center">
            <p className="text-sm text-[#aaa]">This video can’t be played in-app (the uploader disabled embedding).</p>
            <a
              href={youtubeUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-full bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 transition-colors"
            >
              Open on YouTube
            </a>
          </div>
        )}
      </div>

      {/* Details. While pinned this is the only scroll region (min-h-0 lets it
          shrink inside the flex column); the title, meta row, and description all
          scroll together. Unpinned, it's plain flow and the page scrolls.

          fillsPane flips that for an open transcript on a wide screen: the pane
          stops scrolling as a whole and becomes a fixed-height column, so the
          transcript can run its full height beside the description instead of
          being a short box in the middle of a long scroll. */}
      <div className={pinned ? `min-h-0 flex-1 overflow-y-auto${fillsPane ? ' lg:overflow-hidden' : ''}` : ''}>

      {/* Metadata — padded + width-limited for readability under the full player.
          With the transcript open this is the two-column split: everything about
          the video on the left, the transcript as its own panel on the right. */}
      <div className={`px-4 py-4 md:px-6 ${twoCol ? 'lg:flex lg:max-w-none lg:gap-4' : 'max-w-[1100px]'} ${fillsPane ? 'lg:h-full lg:min-h-0' : ''}`}>

      {/* Left panel: title, stats, actions, description — scrolls on its own once
          the pane is a fixed-height row. The readability cap lives here rather
          than on the row, so the transcript gets its own width beside it instead
          of the two sharing one 1100px budget. */}
      <div className={`${twoCol ? 'lg:min-w-0 lg:grow lg:basis-[650px] lg:max-w-[1100px]' : ''} ${fillsPane ? 'lg:overflow-y-auto' : ''}`}>
        <h1 className="text-lg md:text-xl font-semibold leading-snug text-white [overflow-wrap:anywhere]">
          {meta?.title ?? '…'}
        </h1>
        {/* Stats on the left, action pills on the right of the same row. */}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[#aaa]">
            {meta && (
              <>
                {meta.channel_thumbnail && (
                  <a
                    href={`/channel/${meta.channel_id}`}
                    onClick={(e) => { e.preventDefault(); onChannelClick(meta.channel_id) }}
                    className="flex-shrink-0"
                    title={meta.channel_name || 'Channel'}
                  >
                    <img
                      src={meta.channel_thumbnail}
                      alt=""
                      className="w-8 h-8 rounded-full object-cover bg-[#3a3a3a]"
                    />
                  </a>
                )}
                <a
                  href={`/channel/${meta.channel_id}`}
                  onClick={(e) => { e.preventDefault(); onChannelClick(meta.channel_id) }}
                  className="font-medium text-white hover:text-blue-400 transition-colors"
                >
                  {meta.channel_name || 'Unknown'}
                </a>
                <span className="text-[#444]">·</span>
                <span>{formatCount(meta.view_count)} views</span>
                <span className="text-[#444]">·</span>
                <span>{timeAgo(meta.published_at)}</span>
                {meta.view_count > 0 && (
                  <>
                    <span className="text-[#444]">·</span>
                    <span>{formatCount(meta.like_count)} likes</span>
                  </>
                )}
              </>
            )}
          </div>

          {/* Action pills — Save to playlist / Download, mirroring the card menu. */}
          {meta && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative" ref={saveRef}>
              <button
                onClick={() => setShowSavePanel((o) => !o)}
                className="flex items-center gap-2 rounded-full bg-[#272727] px-4 py-2 text-sm font-medium text-white hover:bg-[#3f3f3f] transition-colors"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z" />
                </svg>
                Save
              </button>
              {showSavePanel && (
                <div className="absolute left-0 top-full mt-2 z-40 rounded-xl bg-[#282828] shadow-2xl ring-1 ring-white/10 py-2">
                  <SaveToPlaylist video={meta} onBack={() => setShowSavePanel(false)} />
                </div>
              )}
            </div>

            {/* Overflow menu — home for the actions that don't earn a pill of
                their own: download, and the transcript when there is one. */}
            <div className="relative" ref={moreRef}>
              <button
                onClick={() => setShowMoreMenu((o) => !o)}
                aria-label="More actions"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-[#272727] text-white transition-colors hover:bg-[#3f3f3f]"
              >
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="5" cy="12" r="1.8" />
                  <circle cx="12" cy="12" r="1.8" />
                  <circle cx="19" cy="12" r="1.8" />
                </svg>
              </button>
              {showMoreMenu && (
                <div className="absolute right-0 top-full z-40 mt-2 min-w-[12rem] rounded-xl bg-[#282828] py-1.5 shadow-2xl ring-1 ring-white/10">
                  <button
                    onClick={() => { onDownload(meta); setShowMoreMenu(false) }}
                    disabled={isDownloaded}
                    className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-white transition-colors hover:bg-white/10 disabled:opacity-50 disabled:hover:bg-transparent"
                  >
                    {isDownloaded ? (
                      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
                      </svg>
                    )}
                    {isDownloaded ? 'Downloaded' : 'Download'}
                  </button>
                  {!!captions?.length && (
                    <button
                      onClick={() => { setShowTranscript((v) => !v); setShowMoreMenu(false) }}
                      className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-white transition-colors hover:bg-white/10"
                    >
                      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h10" />
                      </svg>
                      {showTranscript ? 'Hide transcript' : 'Show transcript'}
                    </button>
                  )}
                </div>
              )}
            </div>
            </div>
          )}
        </div>

        {/* This video's topics — the channel-page labels derived from its title. */}
        {meta?.title_labels && meta.title_labels.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {meta.title_labels.map((label) => (
              <span
                key={label}
                className="inline-flex items-center rounded-full bg-[#272727] px-2.5 py-1 text-xs text-[#ddd]"
              >
                {label}
              </span>
            ))}
          </div>
        )}

        {/* No own scroll here: the left panel (or the details wrapper) owns it, so
            the description flows at full height and scrolls with the rest. */}
        {description && (
          <div className="mt-4 whitespace-pre-wrap rounded-xl bg-[#1a1a1a] p-4 text-sm leading-relaxed text-[#ccc] [overflow-wrap:anywhere]">
            {linkify(description, seekTo)}
          </div>
        )}
        </div>

        {/* Right panel: the caption track as readable prose. Toggled from the "…"
            menu in the action row. Below lg it just stacks under everything. */}
        {twoCol && (
          <div className={`mt-4 lg:mt-0 lg:grow-[999] lg:shrink-0 lg:basis-[26rem] lg:max-w-[56rem] ${fillsPane ? 'lg:flex lg:min-h-0 lg:flex-col' : ''}`}>
            {/* Search the lines, and close the panel. */}
            <div className="mb-2 flex items-center gap-2">
              <div className="relative flex-1">
                <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#888]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <circle cx="11" cy="11" r="7" />
                  <path strokeLinecap="round" d="M20 20l-3.5-3.5" />
                </svg>
                <input
                  value={transcriptQuery}
                  onChange={(e) => setTranscriptQuery(e.target.value)}
                  // Esc clears the search; on an already-empty field it just gives
                  // the keyboard back to the player instead of doing nothing.
                  onKeyDown={(e) => {
                    if (e.key !== 'Escape') return
                    e.stopPropagation()
                    if (searching) setTranscriptQuery('')
                    else e.currentTarget.blur()
                  }}
                  placeholder="Search transcript"
                  className="w-full rounded-full bg-[#121212] py-1.5 pl-9 pr-8 text-sm text-white ring-1 ring-white/10 placeholder:text-[#888] focus:outline-none focus:ring-white/25"
                />
                {searching && (
                  <button
                    onClick={() => setTranscriptQuery('')}
                    aria-label="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-[#888] transition-colors hover:bg-white/10 hover:text-white"
                  >
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                )}
              </div>
              <button
                onClick={() => setShowTranscript(false)}
                aria-label="Close transcript"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#aaa] transition-colors hover:bg-white/10 hover:text-white"
              >
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            <div className={`relative ${fillsPane ? 'lg:min-h-0 lg:flex-1' : ''}`}>
              <div
                ref={transcriptRef}
                onScroll={onTranscriptScroll}
                className={`max-h-[26rem] overflow-y-auto rounded-xl bg-[#1a1a1a] p-2 ${fillsPane ? 'lg:h-full lg:max-h-none' : 'lg:max-h-[34rem]'}`}
              >
                {visibleRows.map(({ s, i }) => (
                  <button
                    key={`${s.start}-${i}`}
                    ref={i === activeRow ? activeRowRef : undefined}
                    onClick={() => { setFollowing(true); seekTo(s.start) }}
                    className={`flex w-full gap-3 rounded-lg px-2 py-1.5 text-left transition-colors ${
                      i === activeRow ? 'bg-white/10' : 'hover:bg-white/5'
                    }`}
                  >
                    <span className="shrink-0 pt-px font-mono text-xs tabular-nums text-[#3ea6ff]">
                      {formatTime(s.start)}
                    </span>
                    <span className={`text-sm leading-relaxed [overflow-wrap:anywhere] ${i === activeRow ? 'text-white' : 'text-[#ccc]'}`}>
                      {highlight(s.text, transcriptQuery)}
                    </span>
                  </button>
                ))}
                {searching && !visibleRows.length && (
                  <p className="px-2 py-3 text-sm text-[#888]">No lines match “{transcriptQuery.trim()}”.</p>
                )}
              </div>

              {/* Floats over the list (outside the scroll box, so it stays put)
                  only while the reader has scrolled off the play head. */}
              {!following && !searching && (
                <button
                  onClick={() => { setFollowing(true); centerActiveRow() }}
                  className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-[#3ea6ff] px-3 py-1.5 text-xs font-medium text-black shadow-lg transition-colors hover:bg-[#65b8ff]"
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    {/* Crosshair: "put me back on the play head" — a directional
                        arrow would be wrong half the time (it can be either way). */}
                    <circle cx="12" cy="12" r="6" />
                    <path strokeLinecap="round" d="M12 2v3m0 14v3M2 12h3m14 0h3" />
                  </svg>
                  Sync to video
                </button>
              )}
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  )
}
