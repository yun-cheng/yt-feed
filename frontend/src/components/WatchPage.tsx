import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from '../lib/api'
import type { ReactNode, RefObject } from 'react'
import type { VideoItem } from '../App'
import { ensureYTApi } from './VideoCard'
import SaveToPlaylist from './SaveToPlaylist'
import { useVolume, setAudioVolume } from '../hooks/audioStore'
import { formatTime } from '../lib/time'
import LocalControls, { localPlayer, BAR_BUTTON } from './LocalControls'
import type { PlayerApi } from './LocalControls'
import { usePlayerMarks, EmbedMarkRail, LoopMenu, MarksFlash } from './PlayerMarks'
import { hasCleanEmbed } from '../lib/ext'
import { formatCount, linkify } from '../lib/richText'
import Comments from './Comments'
import AskPanel from './AskPanel'
import type { StoryboardInfo } from '../lib/storyboard'

// Turn YouTube's own controls off and drive the embed with OUR control bar — the
// same one a downloaded file gets.
//
// What it buys: one bar everywhere, our marks drawn on a track we own, and no
// guessing about YouTube's chrome — the fade timing can't drift out of sync with
// controls that no longer exist, and the sheet that watches for mouse movement
// can stay put instead of dodging YouTube's buttons.
//
// What it costs: YouTube's quality / speed / subtitle menus go with them.
//
// Gated on the extension because `controls=0` alone isn't enough: it takes away
// the control BAR and leaves the title, avatar, centre play button and share row
// sitting on top of ours. Without the extension there is no way to remove those,
// so we leave YouTube's controls up and lay our marks over them instead — the
// other branch of every conditional below. Both paths ship.
//
// Read at module scope on purpose: it decides a playerVar, so it has to be
// settled before the first player is built and must not change under one.
const EMBED_OWN_CONTROLS = hasCleanEmbed()

type Props = {
  videoId: string
  // Metadata when we arrived from a card (renders instantly, no fetch flash).
  // Absent on a cold load / back-forward, where we fetch by id instead.
  video?: VideoItem | null
  // The filters in force on the page behind this overlay, as a query string,
  // so the up-next suggestion comes from the list you were actually browsing.
  // Empty when nothing is filtering it (the feed, a cold load).
  nextFilter?: string
  // Seconds to start at, when the URL's `?t=` said so — a handoff from
  // somewhere that already knew the position, which beats stored history.
  startAt?: number | null
  // Which side panel to open on. Set when we were sent here to look at
  // something in particular — a summary notification opens Ask on its answer.
  initialPanel?: 'transcript' | 'ask' | null
  onChannelClick: (channelId: string) => void
  onDownload: (video: VideoItem) => void
  isDownloaded: boolean
  // A finished download exists on disk, so we play that file instead of the
  // YouTube embed (see the player effect).
  hasLocalFile: boolean
  // Whether hasLocalFile is an answer yet: the downloads list is fetched once at
  // startup, so on a cold load of /watch/:id it can still be in flight here.
  downloadsKnown: boolean
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
// Runaway guard for the transcript's translate-everything loop: 40 x 10 sentences
// covers a very long video, and a bug can't spend the API key past it.
const AI_TRANSCRIPT_MAX_BATCHES = 40

// Watch history. Ten seconds is often enough that closing the tab loses almost
// nothing, and rare enough to be invisible next to the caption traffic.
const HISTORY_REPORT_SEC = 10
// Resuming below this isn't worth the jump — you'd re-watch it anyway.
const RESUME_MIN_SEC = 10
// Nor is resuming this close to the end: the video restarts instead, so a
// finished video doesn't reopen onto its own credits.
const RESUME_TAIL_SEC = 20
// How often we ask the player whether it has ended. Half a second is under the
// threshold where the up-next card would feel like it arrived late, and the call
// is a property read on an object we already hold.
const END_POLL_MS = 500

// Caption preferences persist in localStorage so they carry across videos and
// sessions — the watch overlay remounts per video, re-reading these on mount.
const CAPTION_PREFS_KEY = 'ytfeed:caption-prefs'
// How the caption block is drawn, as opposed to which track it draws. Size is a
// multiplier on YouTube's own 2.5%-of-player-width, so 1 is "the same size
// YouTube would have drawn it". YouTube's own ladder jumps 100 → 150 → 200; on a
// player this wide those are different decisions rather than adjustments, so this
// steps by 10% and lets you stop where it actually looks right.
const CAPTION_SIZE_MIN = 0.5
const CAPTION_SIZE_MAX = 3
const CAPTION_SIZE_STEP = 0.1
// Every size passes through here, so a tenth stays a tenth instead of drifting
// into 1.2000000000000002 and printing as 120.00000000000001%.
const roundSize = (n: number) =>
  Math.round(Math.min(CAPTION_SIZE_MAX, Math.max(CAPTION_SIZE_MIN, n)) * 10) / 10
const CAPTION_DISPLAY_DEFAULTS = { pos: 'bottom' as const, size: 1 }
type CaptionPrefs = {
  on: boolean
  lang: string
  lang2: string
  mode: 'word' | 'sentence'
  pos: 'top' | 'bottom'
  size: number
}
function loadCaptionPrefs(): CaptionPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(CAPTION_PREFS_KEY) || '{}')
    return {
      on: p.on === true,
      // AI translation is never restored in EITHER slot (see the persist effect) —
      // drop it here too, so a value saved before that rule can't auto-fire a
      // translation (real tokens, real latency) on every video you open.
      lang: typeof p.lang === 'string' && p.lang !== AI_ZH ? p.lang : '',
      lang2: typeof p.lang2 === 'string' && p.lang2 !== AI_ZH ? p.lang2 : '',
      // 'line' is the old name for this mode — keep reading it so a saved
      // preference doesn't silently reset.
      mode: p.mode === 'sentence' || p.mode === 'line' ? 'sentence' : 'word',
      pos: p.pos === 'top' ? 'top' : 'bottom',
      // Clamped rather than rejected: a size saved by an older build (the first
      // version of this stepped 50/75/100/150/200/300) is still a size someone
      // chose, and every one of those lands inside the range anyway.
      size: typeof p.size === 'number' && Number.isFinite(p.size)
        ? roundSize(p.size)
        : CAPTION_DISPLAY_DEFAULTS.size,
    }
  } catch {
    return { on: false, lang: '', lang2: '', mode: 'word', ...CAPTION_DISPLAY_DEFAULTS }
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
function CaptionBlock({ lines, size }: { lines: CaptionLine[]; size: number }) {
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
        // `size` scales that: everything else here is in em or a share of the
        // width, so the whole block — box, padding, the word-by-word line's
        // fixed width — grows with the text rather than around it.
        fontSize: `${2.5 * size}cqw`,
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

export default function WatchPage({ videoId, video, nextFilter = '', startAt, initialPanel, onChannelClick, onDownload, isDownloaded, hasLocalFile, downloadsKnown }: Props) {
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
  // Where the block sits and how big it is. Kept apart from the language picks:
  // these say nothing about which track is showing, and the Reset below puts
  // only these two back — losing your languages is not what "reset" should mean.
  const [captionPos, setCaptionPos] = useState<'top' | 'bottom'>(savedPrefs.pos)
  const [captionSize, setCaptionSize] = useState(savedPrefs.size)
  // Base codes observed to carry per-word timing (auto-caption tracks). A track only
  // reveals this once loaded, so we accumulate it and keep it for the video — that's
  // what lets the "word-by-word" variant show in BOTH columns, and even while the
  // track isn't the one currently displayed. Reset per video.
  const [wordSegLangs, setWordSegLangs] = useState<Set<string>>(() => new Set())
  const [showCaptionMenu, setShowCaptionMenu] = useState(false)
  const captionMenuRef = useRef<HTMLDivElement>(null)
  // The list of passages, opened from the loop button. Holds the chrome up the
  // same way the caption menu does — see chromeUp.
  const [showLoopMenu, setShowLoopMenu] = useState(false)
  // The transcript panel beside the video's details — closed until asked for,
  // since it's a long read most visits don't want.
  // The right-hand panel holds one of two things at a time. A single state
  // rather than a boolean each, because they share the slot: opening one closes
  // the other, and `null` is the page back at its one-column shape.
  const [sidePanel, setSidePanel] = useState<'transcript' | 'ask' | null>(initialPanel ?? null)
  const showTranscript = sidePanel === 'transcript'
  const showAsk = sidePanel === 'ask'
  // The "…" overflow menu next to Save, holding download + the transcript toggle.
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  const activeRowRef = useRef<HTMLButtonElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  // Whether the transcript still tracks the play head. Scrolling away turns it off
  // and raises the sync button; that button (or a row click) turns it back on.
  const [following, setFollowing] = useState(true)
  const [transcriptQuery, setTranscriptQuery] = useState('')
  // The transcript's own track, independent of the on-video captions: reading
  // along in one language while the video shows another is the whole point of
  // having both. '' follows whatever the caption switcher resolved to.
  const [transcriptLang, setTranscriptLang] = useState('')
  const [transcriptCues, setTranscriptCues] = useState<Cue[] | null>(null)
  // The AI-translated transcript, accumulated batch by batch across the whole video.
  const [aiTranscript, setAiTranscript] = useState<{ start: number; end: number; text: string }[]>([])
  const [aiTranscriptBusy, setAiTranscriptBusy] = useState(false)
  // Mirrors of the above for the walk below, which must not re-run when they change.
  const aiTranscriptRef = useRef<{ start: number; end: number; text: string }[]>([])
  aiTranscriptRef.current = aiTranscript
  const aiTranscriptDone = useRef(false)
  const [showTranscriptLangMenu, setShowTranscriptLangMenu] = useState(false)
  const transcriptLangRef = useRef<HTMLDivElement>(null)
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
  const playerRef = useRef<PlayerApi | null>(null)
  // The <video> for a downloaded file. Same-origin, so the range requests that
  // make seeking work go straight to the backend's FileResponse.
  const videoRef = useRef<HTMLVideoElement>(null)
  const localSrc = `/api/downloads/${videoId}/file`
  // Our control bar shows while the pointer is over the player (or it's paused).
  const [pointerOverPlayer, setPointerOverPlayer] = useState(false)
  // Whether the player is playing, polled below. Only used for the fade rule.
  const [playing, setPlaying] = useState(false)
  // Fullscreen OUR box, not the video/iframe — see the `f` shortcut for why.
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen()
    else playerBoxRef.current?.requestFullscreen?.()
  }
  // Which source we're playing. Chosen ONCE, the moment the downloads list is
  // known, and never revisited: swapping players mid-playback would drop the
  // video back to zero, so a download that finishes while you watch applies the
  // next time you open it.
  //
  // The wait matters on a cold load of /watch/:id, where the list is still in
  // flight when the overlay mounts: without it we'd read "not downloaded",
  // build the YouTube embed, and leave a downloaded video playing from YouTube.
  // Neither player exists until then — a frame of black beats the wrong one.
  const [playLocal, setPlayLocal] = useState(downloadsKnown && hasLocalFile)
  const [sourceChosen, setSourceChosen] = useState(downloadsKnown)
  useEffect(() => {
    if (!downloadsKnown || sourceChosen) return
    setPlayLocal(hasLocalFile)
    setSourceChosen(true)
  }, [downloadsKnown, sourceChosen, hasLocalFile])

  // Jump to a description timestamp and play from there.
  const seekTo = (seconds: number) => {
    const p = playerRef.current
    if (!p) return
    p.seekTo(seconds, true)
    p.playVideo()
  }

  // Bookmarks (`b`) and the A–B repeat loop (`[`, `]`, `\`). Owns its own key
  // handler and drives the player through the same PlayerApi as everything else
  // here, so it works over the embed and over a downloaded file alike.
  const marks = usePlayerMarks(videoId, playerRef)

  // Our chrome — the control bar over a local file, and the caption button, pin
  // and mark rail over the embed — goes away after a few seconds of stillness,
  // the way a player's does. Leaving the player was the only signal at first,
  // which is no signal at all in FULLSCREEN: the player is the whole screen, so
  // the pointer never leaves it and the chrome sat there forever.
  //
  // Stillness is measured from the last mouse move over the player or shortcut
  // key pressed. A cross-origin iframe keeps its own mouse events, so movement
  // over the EMBED is caught by a sheet laid over it while the chrome is down
  // (see the render) — without that, moving the pointer brought YouTube's
  // controls back and left ours hidden.
  const CHROME_IDLE_MS = 3000
  const activityAt = useRef(Date.now())
  const wakeChrome = () => { activityAt.current = Date.now() }
  const [chromeIdle, setChromeIdle] = useState(false)
  useEffect(() => {
    // Cheaper than it looks: setting state to the value it already holds doesn't
    // re-render, so this is two renders per idle/active transition, not 2.5/s.
    const id = window.setInterval(
      () => setChromeIdle(Date.now() - activityAt.current > CHROME_IDLE_MS),
      400
    )
    return () => window.clearInterval(id)
  }, [])
  // Awake while the pointer is on the player and moving, and whenever playback
  // isn't running — a paused player keeps its controls, like every other one.
  const chromeAwake = (pointerOverPlayer && !chromeIdle) || !playing
  // An open caption menu pins the chrome up wherever the chrome lives. It would
  // be absurd for a button to fade out from under the menu it opened — and with
  // our own bar the menu goes with it, so the menu faded out from under the
  // pointer that was working it.
  const chromeUp = chromeAwake || showCaptionMenu || showLoopMenu

  // Whether the controls under the video are OURS — either because it's a file
  // we play ourselves, or because we turned YouTube's off. The caption button and
  // the pin sit in that bar's button row when it's ours, and float over the
  // embed's own chrome when it isn't.
  const ownBar = playLocal || EMBED_OWN_CONTROLS

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

  // ── Watch history ─────────────────────────────────────
  // Where we left off last time, fetched in parallel with the player's own
  // startup; `resumeAt` stays null until we know, so the seek effect below can
  // tell "not loaded yet" from "start at 0".
  const [resumeAt, setResumeAt] = useState<number | null>(null)
  // Bumped every time a player becomes ready. The seek below keys off it rather
  // than firing once for the life of the page, because the embed can be REBUILT
  // under us: a blocked unmuted autoplay is replaced by a muted player, and that
  // one starts at 0 with the old seek already spent. One-shot resume meant the
  // rebuilt player kept the position only when no rebuild happened — which is
  // why a refresh (no gesture, so muted from the first build) always worked.
  const [playerGen, setPlayerGen] = useState(0)
  const resumedForRef = useRef(-1)
  // Read once, on mount. App strips `?t=` from the URL as soon as it's handed
  // over, and this component is keyed by video id so a different video gets a
  // fresh instance — between them, "start here" can't be applied twice.
  const startAtRef = useRef(startAt)
  useEffect(() => {
    // An explicit `?t=` came from something that already knew the position —
    // the extension's watch-page button, handing over where YouTube had got to.
    // It's an instruction rather than a guess, so it beats stored history and
    // skips the near-the-end rule below: landing on the credits is exactly what
    // you asked for if that's where you were.
    const handoff = startAtRef.current
    if (handoff !== null && handoff !== undefined) {
      setResumeAt(handoff)
      return
    }

    let cancelled = false
    apiFetch(`/api/history/${videoId}`, { quiet: true })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        const pos = Number(d?.position_seconds) || 0
        const dur = Number(d?.duration_seconds) || 0
        // Don't drop someone back onto the credits: a finished video (or one
        // stopped within RESUME_TAIL_SEC of the end) restarts from the top.
        const resumable = pos > RESUME_MIN_SEC && !(dur > 0 && dur - pos <= RESUME_TAIL_SEC)
        setResumeAt(resumable ? pos : 0)
      })
      .catch(() => setResumeAt(0))
    return () => { cancelled = true }
  }, [videoId])

  // Seek once per player, as soon as BOTH the position and a ready player exist
  // — either can land first. `playerGen` is the ready signal from out here, so
  // a player replaced later gets its own seek and a position that arrived late
  // still finds the player waiting.
  useEffect(() => {
    if (resumeAt === null || playerGen === 0) return
    if (resumedForRef.current === playerGen) return
    resumedForRef.current = playerGen
    if (resumeAt === 0) return
    playerRef.current?.seekTo(resumeAt, true)
  }, [resumeAt, playerGen])

  // Report progress on a timer while the video plays, and once more on the way
  // out (closing the overlay, switching video, navigating away). The backend
  // ignores anything under a few seconds, so a misclick never lands in history.
  useEffect(() => {
    const report = (keepalive = false) => {
      const p = playerRef.current
      if (!p) return
      const position = p.getCurrentTime()
      const duration = p.getDuration?.() || meta?.duration_seconds || 0
      if (!position) return
      apiFetch('/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // keepalive lets the final report survive the page being torn down.
        keepalive,
        quiet: true,
        body: JSON.stringify({
          youtube_id: videoId,
          position_seconds: position,
          duration_seconds: Math.round(duration),
          title: meta?.title ?? '',
          channel_id: meta?.channel_id ?? '',
          channel_name: meta?.channel_name ?? '',
          channel_thumbnail: meta?.channel_thumbnail ?? '',
          thumbnail_url: meta?.thumbnail_url ?? '',
          published_at: meta?.published_at ?? '',
          view_count: meta?.view_count ?? 0,
          like_count: meta?.like_count ?? 0,
          is_short: meta?.is_short ?? false,
          score: meta?.score ?? 0,
        }),
      }).catch(() => { /* progress is best-effort */ })
    }
    const id = window.setInterval(() => {
      // 1 = PLAYING. Paused or buffering means the position hasn't moved, so
      // there's nothing new to say.
      if (playerRef.current?.getPlayerState() === 1) report()
    }, HISTORY_REPORT_SEC * 1000)
    const onHide = () => { if (document.visibilityState === 'hidden') report(true) }
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onHide)
      report(true)
    }
  }, [videoId, meta])

  // ── Up next ───────────────────────────────────────────
  // The channel's next video FORWARD IN TIME, offered when this one ends. Asked
  // for on arrival rather than at the end, so the card is already in hand the
  // moment the video finishes instead of appearing a beat afterwards.
  const [nextUp, setNextUp] = useState<VideoItem | null>(null)
  const [ended, setEnded] = useState(false)
  const [nextDismissed, setNextDismissed] = useState(false)
  useEffect(() => {
    setNextUp(null)
    let cancelled = false
    apiFetch(`/api/feed/next/${videoId}${nextFilter ? `?${nextFilter}` : ''}`, { quiet: true })
      .then((r) => r.json())
      // null is the ordinary answer on a channel's newest video — nothing to
      // suggest is a result, not a failure.
      .then((d) => { if (!cancelled && d && d.youtube_id) setNextUp(d) })
      .catch(() => { /* a suggestion is a nicety; losing it costs nothing */ })
    return () => { cancelled = true }
  }, [videoId, nextFilter])

  // 0 = ENDED, 1 = PLAYING. Polled rather than taken from an event, because the
  // embed and a local <video> answer through the same PlayerApi and nothing here
  // needs to know which one it's holding.
  //
  // A running A–B loop is excluded: it reaches the end deliberately, every lap,
  // and being handed the next video each time would be the opposite of what the
  // loop is for.
  const looping = marks.looping
  useEffect(() => {
    const id = window.setInterval(() => {
      const state = playerRef.current?.getPlayerState()
      if (state === 0) { if (!looping) setEnded(true) }
      // Playing again — a replay, or a seek back into the video — takes the card
      // away and re-arms the dismissal for the next ending.
      else if (state === 1) { setEnded(false); setNextDismissed(false) }
    }, END_POLL_MS)
    return () => window.clearInterval(id)
  }, [looping, playerRef])

  useEffect(() => {
    setDescription('')
    let cancelled = false
    apiFetch(`/api/feed/description/${videoId}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setDescription(d?.description || '') })
      .catch(() => { /* no description box */ })
    return () => { cancelled = true }
  }, [videoId])

  // Scrub-preview frames for the embed. Only fetched where they can be shown:
  // our own bar, over a video we're streaming rather than playing off disk (a
  // file seeks its own frames, which are better and free). Hovering the card is
  // almost always how you got here and warms the same server-side cache, so this
  // is usually a hit rather than another yt-dlp extraction. An empty object
  // means the video has no storyboards — the popup falls back to the timestamp.
  const [storyboard, setStoryboard] = useState<StoryboardInfo | null>(null)
  useEffect(() => {
    setStoryboard(null)
    if (!EMBED_OWN_CONTROLS || playLocal || !downloadsKnown) return
    let cancelled = false
    apiFetch(`/api/feed/storyboard/${videoId}`, { quiet: true })
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d?.fragment_urls?.length) setStoryboard(d) })
      .catch(() => { /* timestamp-only preview */ })
    return () => { cancelled = true }
  }, [videoId, playLocal, downloadsKnown])

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
  }, [videoId, effCaptionLang])

  // Translate ahead of the play head, like a video buffering. Runs on the caption
  // tick: walks the contiguous translated span forward from the play head and, if
  // it doesn't reach far enough ahead, asks for the next run of sentences from
  // there. A seek needs no special case — it just lands somewhere uncovered, and
  // the same check fetches that spot next.
  useEffect(() => {
    const aiActive = captionLang === AI_ZH || captionLang2 === AI_ZH
    if (!aiActive || !showCaptions || !captions?.length) return
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
        // `d.lang` is the AI target (zh-Hant). Only record it as the second
        // track's active lang when AI actually IS the second track — otherwise a
        // real second track owns activeLang2.
        if (captionLang2 === AI_ZH) setActiveLang2(d?.lang ?? null)
      })
      .catch(() => { aiTried.current.delete(spot) /* transient — let a later tick retry */ })
      .finally(() => {
        aiBusy.current = false
        setTranslating(false)
      })
  }, [captionLang, captionLang2, showCaptions, captions, curTime, aiSents, videoId, effCaptionLang])

  // Persist caption prefs so they carry to the next video and next session — but
  // never the AI selection. Restoring that would fire a translation (real tokens,
  // real latency) on every video you open, without you asking for it; it stays an
  // explicit per-video opt-in.
  useEffect(() => {
    try {
      localStorage.setItem(CAPTION_PREFS_KEY, JSON.stringify({
        on: showCaptions,
        lang: captionLang === AI_ZH ? '' : captionLang,
        lang2: captionLang2 === AI_ZH ? '' : captionLang2,
        mode: captionMode,
        pos: captionPos,
        size: captionSize,
      }))
    } catch { /* storage disabled — prefs just won't persist */ }
  }, [showCaptions, captionLang, captionLang2, captionMode, captionPos, captionSize])

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

  // Same guard as the caption languages: only honour a pick this video offers.
  // AI_ZH is exempt — it's a translation of the source track, not a track the
  // video provides, so it appears in no video's language list.
  const transcriptIsAI = transcriptLang === AI_ZH
  const pickedTranscriptLang = transcriptIsAI || offersLang(transcriptLang) ? transcriptLang : ''

  // The transcript's track, when it differs from the one already fetched for the
  // captions. Null means "use the caption cues" — no second request for the
  // common case where both are the same language.
  useEffect(() => {
    const same = !pickedTranscriptLang || pickedTranscriptLang === (activeLang || effCaptionLang)
    if (!showTranscript || same || transcriptIsAI) { setTranscriptCues(null); return }
    let cancelled = false
    apiFetch(`/api/feed/captions/${videoId}?lang=${pickedTranscriptLang}`, { quiet: true })
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setTranscriptCues(Array.isArray(d?.cues) ? d.cues : []) })
      .catch(() => { if (!cancelled) setTranscriptCues([]) })
    return () => { cancelled = true }
  }, [videoId, showTranscript, pickedTranscriptLang, activeLang, effCaptionLang, transcriptIsAI])

  // The AI transcript translates the WHOLE video, unlike the caption version that
  // only stays ahead of the play head: a transcript is for reading and searching
  // end to end, so a half-translated one is barely useful. It still arrives in
  // batches, rendered as they land, walking forward from the last covered end
  // until a short response says we've run out of video.
  useEffect(() => {
    if (!showTranscript || !transcriptIsAI || !captions?.length) return
    let cancelled = false
    // Resume from the end of what's already here rather than restarting at 0:
    // closing and reopening the panel would otherwise replay the whole walk as
    // cache hits — harmless but a burst of pointless requests.
    let resumeAt = 0
    for (;;) {
      const covering = aiTranscriptRef.current.find((s) => s.start <= resumeAt && resumeAt < s.end)
      if (!covering) break
      resumeAt = covering.end
    }
    if (aiTranscriptDone.current) return
    setAiTranscriptBusy(true)
    ;(async () => {
      let at = resumeAt
      for (let batch = 0; batch < AI_TRANSCRIPT_MAX_BATCHES; batch++) {
        if (cancelled) return
        try {
          const r = await apiFetch(
            `/api/feed/captions-translate/${videoId}?lang=${effCaptionLang}&at=${at}&count=${AI_SENTENCES}`,
            { quiet: true }
          )
          const d = await r.json()
          const got: { start: number; end: number; text: string }[] = Array.isArray(d?.sentences) ? d.sentences : []
          if (cancelled) return
          if (!got.length) break
          setAiTranscript((prev) => {
            const byStart = new Map(prev.map((s) => [s.start, s]))
            got.forEach((s) => byStart.set(s.start, s))
            return [...byStart.values()].sort((a, b) => a.start - b.start)
          })
          const end = got[got.length - 1].end
          if (got.length < AI_SENTENCES || !(end > at)) {  // ran out of video
            if (!cancelled) aiTranscriptDone.current = true
            break
          }
          at = end
        } catch {
          break  // leave what we have; reopening the panel retries
        }
      }
      if (!cancelled) setAiTranscriptBusy(false)
    })()
    return () => { cancelled = true; setAiTranscriptBusy(false) }
  }, [videoId, showTranscript, transcriptIsAI, captions, effCaptionLang])

  // A new video or a different source track invalidates the translation.
  useEffect(() => { setAiTranscript([]); aiTranscriptDone.current = false }, [videoId, effCaptionLang])

  // Close the transcript's language menu on an outside click.
  useEffect(() => {
    if (!showTranscriptLangMenu) return
    const onDown = (e: MouseEvent) => {
      if (transcriptLangRef.current && !transcriptLangRef.current.contains(e.target as Node)) setShowTranscriptLangMenu(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [showTranscriptLangMenu])

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

  // The AI-translated sentences as whole-line cues. Shared by whichever slot picked
  // AI (main or second): each translated sentence already covers its own span, and
  // partially buffered stretches simply render as far as they've got.
  const aiCues = useMemo<Cue[]>(
    () => aiSents.map((s) => ({
      start: s.start, dur: s.end - s.start, text: s.text,
      words: [{ t: s.start, text: s.text }],
    })),
    [aiSents]
  )
  // The second (dual-subtitle) track's cues: a real fetched track, or the AI cues.
  const secondCues = useMemo(
    () => (captionLang2 === AI_ZH ? aiCues : captions2),
    [captionLang2, aiCues, captions2]
  )

  // Sentence groupings for "Whole sentence" mode (independent of curTime, so memoize
  // per cue list rather than recomputing every poll tick).
  const sentences = useMemo(() => toSentences(captions), [captions])
  const sentences2 = useMemo(() => toSentences(secondCues), [secondCues])

  // An open transcript on a wide screen turns the details pane into a fixed-height
  // two-column layout. Only while pinned: unpinned, the page itself scrolls and
  // there's no pane height to fill.
  const twoCol = sidePanel !== null && !!captions?.length
  const fillsPane = pinned && twoCol

  // Word-segment tracks (auto captions) reveal word-by-word and split sentences
  // mid-clause across cues, so stitching them into whole sentences reads far
  // better as prose. Whole-cue tracks (manual/translated subs) are already
  // author-written lines — stitching only glues together lines that happen not to
  // end in punctuation — so those render one row per cue, like the caption block.
  // AI rows arrive pre-split into sentences (the backend does its own pass).
  const transcript = useMemo(() => {
    if (transcriptIsAI) return aiTranscript
    const src = transcriptCues ?? captions
    if (!src?.length) return []
    if (src.some((c) => c.words && c.words.length > 1)) return toSentences(src, false)
    return src
      .map((c, i) => ({ start: c.start, end: i + 1 < src.length ? src[i + 1].start : Number.POSITIVE_INFINITY, text: c.text.trim() }))
      .filter((s) => s.text)
  }, [transcriptIsAI, aiTranscript, transcriptCues, captions])
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
  // The track the transcript is actually showing, and its label for the button.
  const transcriptTrackLang = pickedTranscriptLang || activeLang || effCaptionLang
  const transcriptLangLabel = transcriptIsAI
    ? 'Chinese'
    : captionLangs.find((l) => l.code === transcriptTrackLang)?.label ?? 'Language'

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

  // A different track is a different set of rows — re-centre on the play head.
  useEffect(() => { setFollowing(true) }, [transcriptLang])

  // "Whole sentence" ONLY transforms word-segment tracks — auto captions that reveal
  // word-by-word (some cue carries per-word timing). It stitches their rolling
  // fragments back into whole sentences. Whole-cue tracks (manual/translated subs,
  // and word-less ASR) are already whole lines authored by the source, so the mode
  // is a no-op for them: we render their cues as-is in both modes.
  const captionLines = useMemo(
    () => {
      if (!showCaptions) return []
      // AI as the main track: render the translated sentences directly (whole
      // lines, no word-by-word mode). The source track is still fetched into
      // `captions` — it feeds the translation — but isn't shown here.
      if (captionLang === AI_ZH) return linesAt(aiCues, curTime)
      const wordSegment = !!captions?.some((c) => c.words && c.words.length > 1)
      return captionMode === 'sentence' && wordSegment ? sentenceLinesAt(sentences, curTime) : linesAt(captions, curTime)
    },
    [showCaptions, captionLang, aiCues, captionMode, sentences, captions, curTime]
  )
  const captionLines2 = useMemo(
    () => {
      if (!showCaptions || !captionLang2) return []
      // A persisted second language can coincide with the main once the main
      // resolves (e.g. native → zh, saved second also zh) — don't show it twice.
      // Only when the main slot actually SHOWS that track, though: with AI as the
      // main, `activeLang` is its English source but the display is Chinese, so an
      // English second is not a duplicate of anything on screen.
      if (captionLang !== AI_ZH && activeLang2 && activeLang2 === activeLang) return []
      const wordSegment = !!secondCues?.some((c) => c.words && c.words.length > 1)
      return captionMode === 'sentence' && wordSegment ? sentenceLinesAt(sentences2, curTime) : linesAt(secondCues, curTime)
    },
    [showCaptions, captionLang, captionLang2, sentences2, secondCues, curTime, captionMode, activeLang, activeLang2]
  )

  // AI translation into Traditional Chinese — offered only once we know the source
  // track's language and it isn't already Chinese. `nativeLang` stands in until the
  // track itself resolves, so the row appears with the rest of the menu rather than
  // a round-trip later.
  const aiSourceLang = activeLang || (effCaptionLang || nativeLang)
  const aiTranslateAvailable = !!aiSourceLang && aiSourceLang !== 'zh'

  // The caption menu is two mirrored columns — Main and Second — each listing every
  // track the video offers plus (when available) the AI translation. There's no
  // "Off" row: an empty slot IS off. `curMain`/`curSecond` are the resolved codes
  // each slot currently shows, so the menu can tick the right rows — the main slot's
  // '' native default resolves through activeLang/nativeLang.
  const curMain = showCaptions ? (captionLang || activeLang || nativeLang || '') : ''
  // A restored second pick can coincide with the main once the main resolves (e.g.
  // native → en, saved second also en). The overlay already dedupes it; treat it as
  // off here too so the menu doesn't tick the same track in both columns.
  const curSecond = captionLang2 && captionLang2 !== curMain ? captionLang2 : ''
  // Commit a (main, second) pair. Invariant: no second without a main — an empty
  // main with a second set promotes the second up. Slots can't hold the same track.
  const setSlots = (main: string, second: string) => {
    if (!main && second) { main = second; second = '' }
    setShowCaptions(!!main)
    if (main) setCaptionLang(main)
    setCaptionLang2(second)
  }
  // Clicking a Main row: the active one toggles the slot off (promoting any second);
  // a row already in the second slot moves up (clearing second); anything else just
  // becomes the new main.
  const pickMain = (code: string) =>
    code === curMain ? setSlots(curSecond, '')
      : code === curSecond ? setSlots(code, '')
      : setSlots(code, curSecond)
  // Clicking a Second row: the active one toggles off; picking the current main
  // swaps the two; anything else becomes the new second.
  const pickSecond = (code: string) =>
    code === curSecond ? setSlots(curMain, '')
      : code === curMain ? setSlots(curSecond, code)
      : setSlots(curMain, code)
  // A word-segment track shows two rows — whole sentences vs word-by-word — instead
  // of a nested toggle. Picking a variant switches to that display mode and selects
  // the track in the given slot (if it isn't already there); re-picking the active
  // variant toggles the slot off, like any other active row. captionMode is global
  // — it drives both slots' rendering — so the variant rows appear in whichever
  // column holds a word-segment track.
  const pickMode = (
    pick: (code: string) => void,
    cur: string,
    code: string,
    mode: 'word' | 'sentence',
  ) => {
    if (code === cur && captionMode === mode) { pick(code); return }
    setCaptionMode(mode)
    if (code !== cur) pick(code)
  }

  // One tenth per press, clamped at both ends (roundSize does the clamping, and
  // keeps the value printable — see the note on it).
  const stepCaptionSize = (delta: number) =>
    setCaptionSize((cur) => roundSize(cur + delta * CAPTION_SIZE_STEP))
  const captionDisplayIsDefault =
    captionPos === CAPTION_DISPLAY_DEFAULTS.pos && captionSize === CAPTION_DISPLAY_DEFAULTS.size

  // Whether the currently-loaded main / second tracks carry per-word timing. Only a
  // word-segment track (auto captions) supports the word-by-word reveal; a whole-cue
  // track (manual/translated subs) is already whole lines, so the mode is a no-op.
  const mainIsWordSegment = !!captions?.some((c) => c.words && c.words.length > 1)
  const secondIsWordSegment = !!captions2?.some((c) => c.words && c.words.length > 1)
  // Remember which languages are word-segment as we load them, so the "word-by-word"
  // variant shows for that language in both columns regardless of what's selected.
  useEffect(() => {
    setWordSegLangs((prev) => {
      const next = new Set(prev)
      if (mainIsWordSegment && activeLang) next.add(activeLang)
      if (secondIsWordSegment && activeLang2) next.add(activeLang2)
      return next.size === prev.size ? prev : next
    })
  }, [mainIsWordSegment, secondIsWordSegment, activeLang, activeLang2])
  useEffect(() => { setWordSegLangs(new Set()) }, [videoId])

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
    // Wait for the source decision, then build the embed only if it won. A
    // downloaded copy is played by the <video> below instead — no embed at all,
    // so nothing here (including the muted-autoplay dance) applies.
    if (!sourceChosen || playLocal) return
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
          autoplay: 1, mute: startMuted ? 1 : 0, controls: EMBED_OWN_CONTROLS ? 0 : 1,
          rel: 0, modestbranding: 1, playsinline: 1, fs: 1,
        },
        events: {
          onReady: (e) => {
            playerRef.current = e.target
            setPlayerGen((n) => n + 1)
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
  }, [videoId, forcedMuted, playLocal, sourceChosen])

  // Publish the local <video> as the player once its metadata is in. Waiting for
  // that matters: publishing it is what releases the resume seek, and a
  // currentTime set before the duration is known is silently dropped. Autoplay follows the same rule as
  // the embed — try with sound, fall back to muted when the browser refuses.
  const onLocalReady = () => {
    const el = videoRef.current
    if (!el) return
    playerRef.current = localPlayer(el)
    setPlayerGen((n) => n + 1)
    el.volume = Math.max(0, Math.min(1, volumeRef.current / 100))
    playerBoxRef.current?.focus()
    el.play().catch(() => {
      el.muted = true
      el.play().catch(() => { /* leave it paused; the controls still work */ })
    })
  }
  useEffect(() => () => { playerRef.current = null }, [videoId])

  // Store → player: apply shared-volume changes to a live player.
  useEffect(() => { playerRef.current?.setVolume(volume) }, [volume])

  // Player → store: if you change volume with the embed's own control, push it
  // back so previews follow. (No update while muted — that shouldn't zero it.)
  // The same tick answers "is it playing?", which is what tells our overlays
  // over the embed when to fade (see chromeUp) — the embed fires no events
  // we can listen to, and one poll serves both.
  useEffect(() => {
    const id = setInterval(() => {
      const p = playerRef.current
      if (!p) return
      // BUFFERING (3) counts as running: a stall shouldn't raise the chrome and
      // then drop it again every time the network hiccups.
      const s = p.getPlayerState()
      setPlaying(s === 1 || s === 3)
      if (p.isMuted()) return
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
      // A shortcut is a BARE key. Chords belong to the browser and the OS:
      // ⌘C/⌘F/⌘L, and on a Mac ⌘[ / ⌘] are back and forward — all of which we
      // would otherwise swallow, since we match on `key` alone. Copying text out
      // of the page was the one people hit.
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const p = playerRef.current
      if (!p) return
      // Any shortcut counts as being here — in fullscreen it's the only activity
      // we can see at all (see chromeAwake). Safe from this once-bound listener:
      // it only writes a ref.
      wakeChrome()
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
        // pause UI showing the control bar. (Safe to call the render-scope
        // closure from this once-bound listener: it only reads refs.)
        toggleFullscreen()
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

  // How far the caption block sits from the edge it's anchored to.
  //
  // At the bottom it has to clear a control bar. Ours comes to ~4.5rem — bottom
  // padding, the button row and the progress bar's own hit area, the same stack
  // the scrub preview measures itself against — so the old 3.5rem drew the text
  // straight through the progress track. When our bar is down there's nothing
  // left to clear and the captions drop, the way a player's do.
  //
  // YouTube's bar we can neither measure nor see the state of from out here, so
  // that one keeps a fixed clearance: 11% of the player height tracks it on big
  // players, but a short player scales the bar UP ("big mode") into that 11% —
  // hence the 5.5rem floor (measured ~73px above the bottom on a 281px-tall
  // player).
  //
  // At the top the only thing in the way is the volume HUD, which sits at 1rem
  // and stands ~2rem tall whether or not any chrome is showing — over the embed
  // YouTube's title bar wants more room than that anyway.
  const captionInset = captionPos === 'top'
    ? (ownBar ? '3.25rem' : 'max(9%, 4rem)')
    : ownBar
      ? (chromeUp ? '4.75rem' : '1.5rem')
      : 'max(11%, 5.5rem)'

  // The caption + volume overlays. Rendered inside the player box, which is also
  // the fullscreen target, so they show in both windowed and fullscreen modes.
  const overlays = (
    <>
      {/* Not part of chromeUp below: a keypress has to be acknowledged even
          when the chrome is down — that's usually exactly when you pressed it. */}
      <MarksFlash flash={marks.flash} />

      {/* Caption overlay — the main track, plus the optional second (dual-
          subtitle) track stacked beneath it. Bottom-anchored above the control
          bar so new lines push the stack upward; see CaptionBlock for styling. */}
      {showCaptions && (captionLines.length > 0 || captionLines2.length > 0) && (
        <div
          className="pointer-events-none absolute inset-x-0 z-10 flex flex-col items-center gap-[2px] px-[5%]"
          // Anchored to whichever edge the block was sent to. Bottom-anchored,
          // new lines push the stack upward; top-anchored it grows downward,
          // which is the same reading order either way.
          style={captionPos === 'top' ? { top: captionInset } : { bottom: captionInset }}
        >
          {/* The main track is the primary line (top); the second track sits under
              it. Now that either slot can hold any language or the AI translation,
              the pick — not the content — decides which reads on top. */}
          {captionLines.length > 0 && <CaptionBlock lines={captionLines} size={captionSize} />}
          {captionLines2.length > 0 && <CaptionBlock lines={captionLines2} size={captionSize} />}
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

  // The caption switcher and the pin toggle. Against the embed they float over
  // the player — its control bar is inside the iframe, out of reach. With our
  // own bar (local playback) they sit in its button row like any other control.
  const captionControl = captionLangs.length > 0 && (
    <div
      ref={captionMenuRef}
      // The embed placement slots it into the iframe's own bottom-left button
      // row, whose buttons sit at a fixed offset.
      className={ownBar ? 'relative' : 'absolute bottom-[14px] left-[8.25rem] z-20'}
    >
      {showCaptionMenu && (
        // Two mirrored columns: Main | Second. Each lists every track the
        // video offers, plus the AI translation. No "Off" row — an empty slot
        // is off (toggle by clicking the active row). The same track can't sit
        // in both columns; picking it in the other slot moves/swaps it.
        <div className="absolute bottom-full left-0 mb-2 overflow-hidden rounded-lg bg-[#282828] text-sm text-white shadow-2xl ring-1 ring-white/10">
          <div className="flex">
            {([
              { title: 'Main', cur: curMain, pick: pickMain },
              { title: 'Second', cur: curSecond, pick: pickSecond },
            ] as const).map((col, ci) => (
              <div key={col.title} className={`min-w-[9rem] py-1 ${ci > 0 ? 'border-l border-white/10' : ''}`}>
                <div className="px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-[#888]">{col.title}</div>
                {captionLangs.map((l) => {
                  const active = col.cur === l.code
                  // A word-segment track splits into two rows: the plain label for
                  // whole sentences, and "(word-by-word)" for the reveal-as-spoken
                  // mode. Shown in both columns for any language known to carry
                  // per-word timing. Every other row is a single entry.
                  if (wordSegLangs.has(l.code)) {
                    return (
                      <Fragment key={l.code}>
                        {(['sentence', 'word'] as const).map((mode) => (
                          <button
                            key={mode}
                            onClick={() => pickMode(col.pick, col.cur, l.code, mode)}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/10"
                          >
                            <span className="w-4 shrink-0">{active && captionMode === mode && '✓'}</span>
                            {mode === 'word' ? `${l.label} (word-by-word)` : l.label}
                          </button>
                        ))}
                      </Fragment>
                    )
                  }
                  return (
                    <button
                      key={l.code}
                      onClick={() => col.pick(l.code)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/10"
                    >
                      <span className="w-4 shrink-0">{active && '✓'}</span>
                      {l.label}
                    </button>
                  )
                })}
                {/* AI translation — only when the source track isn't Chinese. */}
                {aiTranslateAvailable && (
                  <button
                    onClick={() => col.pick(AI_ZH)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/10"
                  >
                    <span className="w-4 shrink-0">{col.cur === AI_ZH && '✓'}</span>
                    Chinese
                    <span className="ml-auto pl-2 text-xs text-[#888]">
                      {col.cur === AI_ZH && translating ? '翻譯中…' : 'AI'}
                    </span>
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* How the block is drawn, under the two track columns because it
              applies to both of them. Position and size are the two things
              YouTube's own settings get wrong for a player this size: its
              captions are locked to the bottom and to a size chosen for a
              phone. Reset is greyed once there's nothing to undo. */}
          <div className="border-t border-white/10 py-1">
            <div className="px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-[#888]">Display</div>
            <div className="flex items-center gap-1.5 px-3 py-1">
              <span className="mr-auto pr-3 text-[#ccc]">Position</span>
              {(['top', 'bottom'] as const).map((pos) => (
                <button
                  key={pos}
                  onClick={() => setCaptionPos(pos)}
                  className={`rounded px-2 py-0.5 capitalize ${
                    captionPos === pos ? 'bg-white text-black' : 'bg-white/10 hover:bg-white/20'
                  }`}
                  aria-pressed={captionPos === pos}
                >
                  {pos}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5 px-3 py-1">
              <span className="mr-auto pr-3 text-[#ccc]">Size</span>
              <button
                onClick={() => stepCaptionSize(-1)}
                disabled={captionSize <= CAPTION_SIZE_MIN}
                className="h-6 w-6 rounded bg-white/10 leading-none hover:bg-white/20 disabled:opacity-30 disabled:hover:bg-white/10"
                title="Smaller"
                aria-label="Smaller captions"
              >
                −
              </button>
              <span className="w-11 text-center tabular-nums text-[#ccc]">{Math.round(captionSize * 100)}%</span>
              <button
                onClick={() => stepCaptionSize(1)}
                disabled={captionSize >= CAPTION_SIZE_MAX}
                className="h-6 w-6 rounded bg-white/10 leading-none hover:bg-white/20 disabled:opacity-30 disabled:hover:bg-white/10"
                title="Bigger"
                aria-label="Bigger captions"
              >
                +
              </button>
            </div>
            <button
              onClick={() => {
                setCaptionPos(CAPTION_DISPLAY_DEFAULTS.pos)
                setCaptionSize(CAPTION_DISPLAY_DEFAULTS.size)
              }}
              disabled={captionDisplayIsDefault}
              className="w-full px-3 py-1.5 text-left text-[#ccc] hover:bg-white/10 disabled:text-[#666] disabled:hover:bg-transparent"
            >
              Reset position and size
            </button>
          </div>
        </div>
      )}
      <button
        onClick={() => setShowCaptionMenu((o) => !o)}
        // In our row it IS a bar button — the same BAR_BUTTON as play, mute and
        // fullscreen, including its hover pill. Only the floating placement over
        // YouTube's own chrome keeps a bespoke box, because there it has to line
        // up with the iframe's row rather than ours.
        className={ownBar
          ? `group relative ${BAR_BUTTON}`
          : 'group relative flex h-11 w-11 items-center justify-center text-white'}
        title="Subtitles / captions"
        aria-pressed={showCaptions}
      >
        {/* Floating placement only: BAR_BUTTON brings its own hover pill. */}
        {!ownBar && (
          <span className="pointer-events-none absolute inset-0 m-auto h-10 w-10 rounded-full transition-colors group-hover:bg-white/10" />
        )}
        {/* YouTube's exact CC glyph (filled), sized to match the embed's
            own bottom-left buttons. A stroke-drawn version reads thinner and
            smaller even at the same 24px viewBox. */}
        <svg className="relative h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M21 3H3a2 2 0 00-2 2v14a2 2 0 002 2h18a2 2 0 002-2V5a2 2 0 00-2-2ZM3 19V5h18v14H3ZM6.972 8.346c-.631.336-1.131.881-1.466 1.526A4.6 4.6 0 005 12c-.004.74.17 1.47.506 2.128.336.645.835 1.191 1.466 1.526a2.86 2.86 0 002.066.257c.697-.178 1.294-.606 1.737-1.176a1 1 0 00-1.578-1.228c-.21.27-.444.413-.654.467a.86.86 0 01-.632-.085c-.222-.119-.453-.342-.631-.684A2.64 2.64 0 017 12a2.6 2.6 0 01.281-1.205c.177-.342.408-.565.63-.684a.86.86 0 01.632-.085c.209.054.444.197.654.467a1 1 0 001.578-1.228c-.443-.57-1.04-.998-1.737-1.176a2.86 2.86 0 00-2.066.257Zm8 0c-.631.336-1.131.881-1.466 1.526A4.6 4.6 0 0013 12c-.004.74.17 1.47.506 2.128.336.645.835 1.191 1.466 1.526a2.86 2.86 0 002.066.257c.697-.178 1.294-.606 1.737-1.176a1 1 0 00-1.578-1.228c-.21.27-.444.413-.654.467a.86.86 0 01-.632-.085c-.222-.119-.453-.342-.631-.684A2.64 2.64 0 0115 12a2.6 2.6 0 01.281-1.205c.177-.342.408-.565.63-.684a.86.86 0 01.632-.085c.209.054.444.197.654.467a1 1 0 001.578-1.228c-.443-.57-1.04-.998-1.737-1.176a2.86 2.86 0 00-2.066.257Z" />
        </svg>
        {/* Active indicator: a YouTube-style underline (no background
            circle, to match the embed's bare share / watch-later buttons). */}
        {showCaptions && (
          <span className={`pointer-events-none absolute left-1/2 h-[3px] w-[18px] -translate-x-1/2 rounded-sm bg-white ${ownBar ? 'bottom-[5px]' : 'bottom-[7px]'}`} />
        )}
      </button>
    </div>
  )

  // Bookmark + A–B repeat, as buttons.
  //
  // The keyboard already does all of this (`b`, `[`, `]`, `\\`) and does it
  // faster — but a feature that only exists on a shortcut is one you have to
  // have been told about, and these two are the only marks on the bar you can't
  // otherwise put there. Same two placements as the pin and the YouTube button:
  // in our row when we own the bar, floating over YouTube's chrome when we
  // don't, there sitting just right of the caption button.
  const MARK_BUTTON_FLOAT = 'group relative flex h-11 w-11 items-center justify-center text-white'
  const marksControls = (
    <div className={ownBar ? 'flex items-center' : 'absolute bottom-[14px] left-[11rem] z-20 flex items-center'}>
      <button
        onClick={marks.toggleBookmarkHere}
        // In the bookmarks' own colour while you're standing on one, so the
        // button, the tick on the bar and the line that confirmed the press are
        // visibly one feature. `!` beats the `text-white` both placements bring
        // — between two colours of the same specificity it's stylesheet order
        // that decides, which is not something to leave to chance.
        className={`${ownBar ? BAR_BUTTON : MARK_BUTTON_FLOAT} ${marks.markHere ? '!text-sky-400' : ''}`}
        // The one press both makes a bookmark and clears it, so it says which
        // one it's about to do. Standing on a mark is a thing you arrive at by
        // clicking its tick, which seeks exactly to it — so clearing one is
        // click the tick, press this, and the button has already changed to
        // tell you that's what it will do.
        title={marks.markHere ? 'Clear this bookmark (b)' : 'Bookmark this moment (b)'}
        aria-label={marks.markHere ? 'Clear this bookmark' : 'Bookmark this moment'}
        aria-pressed={marks.markHere}
      >
        {!ownBar && (
          <span className="pointer-events-none absolute inset-0 m-auto h-10 w-10 rounded-full transition-colors group-hover:bg-white/10" />
        )}
        {/* Filled while you're standing on one, outlined while you aren't — the
            same solid-vs-hollow the pin uses two buttons along. */}
        <svg className="relative h-6 w-6" viewBox="0 0 24 24" aria-hidden>
          {marks.markHere
            ? <path fill="currentColor" d="M17 3H7a2 2 0 0 0-2 2v16l7-3.5 7 3.5V5a2 2 0 0 0-2-2z" />
            : <path fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" d="M17 3H7a2 2 0 0 0-2 2v16l7-3.5 7 3.5V5a2 2 0 0 0-2-2z" />}
        </svg>
      </button>
      <div className="relative">
      <button
        onClick={() => setShowLoopMenu((open) => !open)}
        // Opens the list of passages. It used to cycle — pin one end, pin the
        // other, clear — but once a video can hold several passages the question
        // stopped being "what's the next step" and became "which one", and that
        // has as many answers as you've marked. The cycle lives on in the
        // keyboard, which is where it was always faster.
        // `relative` because the badge and underline below are positioned
        // against it, and BAR_BUTTON doesn't bring its own — without it they
        // resolve against the control bar instead and paint themselves across
        // the bottom middle of the video. (The caption button already adds it
        // for the same reason; MARK_BUTTON_FLOAT has it built in.)
        className={`relative ${ownBar ? BAR_BUTTON : MARK_BUTTON_FLOAT}`}
        title={
          marks.loopStage === 'idle' ? 'Repeat A–B ([)'
            : marks.loopStage === 'arming' ? `Repeat A–B: the ${marks.loop.a === null ? 'start ([' : 'end (]'}) is still open`
              : 'Repeat A–B (\\ stops it)'
        }
        aria-haspopup="menu"
        aria-expanded={showLoopMenu}
        // Whether it's repeating, not how far along the pinning is: one end
        // pinned already repeats, from the start of the video or to the end.
        aria-pressed={marks.looping}
      >
        {!ownBar && (
          <span className="pointer-events-none absolute inset-0 m-auto h-10 w-10 rounded-full transition-colors group-hover:bg-white/10" />
        )}
        <svg className="relative h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" />
        </svg>
        {/* Armed, it says which end the next press pins — the one thing the
            stage alone can't tell you, and otherwise only a tooltip would.
            Repeating, it takes the caption button's underline. Both at once is
            the ordinary state of a one-ended loop: it runs, and the next press
            still pins the other end. Both in white: the loop wears no colour of
            its own anywhere, on the bar or here. */}
        {marks.loopStage === 'arming' && (
          <span className={`pointer-events-none absolute text-[10px] font-bold leading-none ${ownBar ? 'bottom-[3px] right-[7px]' : 'bottom-[5px] right-[5px]'}`}>
            {marks.loop.a === null ? 'A' : 'B'}
          </span>
        )}
        {marks.looping && (
          <span className={`pointer-events-none absolute left-1/2 h-[3px] w-[18px] -translate-x-1/2 rounded-sm bg-white ${ownBar ? 'bottom-[5px]' : 'bottom-[7px]'}`} />
        )}
      </button>
      {showLoopMenu && (
        <LoopMenu
          loops={marks.loops}
          duration={meta?.duration_seconds ?? 0}
          stage={marks.loopStage}
          onPin={marks.pinLoopEnd}
          onUse={marks.useLoop}
          onDrop={marks.dropLoop}
          onStop={marks.clearLoop}
          onNew={marks.newLoop}
          onClose={() => setShowLoopMenu(false)}
        />
      )}
      </div>
    </div>
  )

  const pinButton = (
    <button
      onClick={() => setPinned((p) => !p)}
      // Over the embed: a pill in the bottom-right corner, on the button-row
      // line so it clears the progress scrubber. In our bar: a plain button.
      className={ownBar
        ? BAR_BUTTON
        : 'absolute bottom-2 right-2 z-20 rounded-full bg-black/60 p-2 text-white transition-colors hover:bg-black/80'}
      title={pinned ? 'Unpin — scroll the whole page' : 'Pin — keep the video in view'}
      aria-pressed={pinned}
    >
      {pinned ? (
        <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor">
          <path d="M16 3a1 1 0 0 1 .117 1.993L16 5v4.764l1.447 2.895c.55 1.098-.2 2.38-1.41 2.34L16 15h-3v5a1 1 0 0 1-1.993.117L11 20v-5H8c-1.23.05-2.02-1.2-1.51-2.28l.063-.125L8 9.764V5a1 1 0 0 1-.117-1.993L8 3h8z" />
        </svg>
      ) : (
        <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v5M8 9.5V5h8v4.5l1.5 3H6.5L8 9.5z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4l16 16" />
        </svg>
      )}
    </button>
  )

  // Hand the video over to youtube.com at the moment you're on.
  //
  // The timestamp is read off the player at CLICK time rather than tracked in
  // state: a value wanted once per click doesn't earn a subscription that
  // re-renders this page four times a second. It works for a downloaded file
  // too — playerRef holds localPlayer there, and the position means the same
  // thing in the copy on YouTube.
  const youtubeButton = (
    <button
      onClick={() => {
        const p = playerRef.current
        const at = Math.max(0, Math.floor(p?.getCurrentTime() ?? 0))
        // Pause on the way out. The overlay keeps playing behind the new tab
        // otherwise, and two copies of the same audio is a worse greeting than
        // having to press play again.
        p?.pauseVideo()
        window.open(`${youtubeUrl}&t=${at}s`, '_blank', 'noopener,noreferrer')
      }}
      // Same two placements as the pin: a button in our row, or a floating pill
      // over YouTube's chrome — there sitting left of the pin, the only other
      // thing in that corner.
      className={ownBar
        ? BAR_BUTTON
        : 'absolute bottom-2 right-12 z-20 rounded-full bg-black/60 p-2 text-white transition-colors hover:bg-black/80'}
      title="Open on YouTube at this moment"
    >
      <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M23.5 6.2a3 3 0 0 0-2.12-2.12C19.5 3.55 12 3.55 12 3.55s-7.5 0-9.38.53A3 3 0 0 0 .5 6.2C0 8.08 0 12 0 12s0 3.92.5 5.8a3 3 0 0 0 2.12 2.12c1.88.53 9.38.53 9.38.53s7.5 0 9.38-.53a3 3 0 0 0 2.12-2.12C24 15.92 24 12 24 12s0-3.92-.5-5.8zM9.55 15.57V8.43L15.82 12l-6.27 3.57z" />
      </svg>
    </button>
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
        // Drives our control bar (local playback) and, over the embed, when our
        // own overlays fade — see chromeAwake. onMouseMove is what keeps the
        // chrome up while you're using it; over the embed it only fires on our
        // own overlays, so there the keyboard does most of the waking.
        onMouseEnter={() => { setPointerOverPlayer(true); wakeChrome() }}
        // A move over the box also SETS "over the player", not just the activity
        // stamp: entering fullscreen by keyboard makes the player the whole
        // screen without the pointer ever crossing its edge, so mouseenter never
        // fires and it would otherwise be stuck reading "pointer is elsewhere".
        onMouseMove={() => { setPointerOverPlayer(true); wakeChrome() }}
        onMouseLeave={() => setPointerOverPlayer(false)}
      >
        {/* A finished download plays from disk: no ads, no embed restrictions,
            and it keeps working offline. Everything else on this page (captions,
            history, shortcuts) reads it through the same PlayerApi. */}
        {playLocal ? (
          <>
            <video
              ref={videoRef}
              src={localSrc}
              onLoadedMetadata={onLocalReady}
              onClick={() => {
                const el = videoRef.current
                if (!el) return
                if (el.paused) void el.play().catch(() => { /* autoplay policy */ })
                else el.pause()
              }}
              autoPlay
              playsInline
              className="absolute inset-0 h-full w-full bg-black"
            />
            <LocalControls
              videoRef={videoRef}
              src={localSrc}
              hovering={(pointerOverPlayer && !chromeIdle) || showCaptionMenu || showLoopMenu}
              onFullscreen={toggleFullscreen}
              leftControls={<>{captionControl}{marksControls}</>}
              extraControls={<>{youtubeButton}{pinButton}</>}
              bookmarks={marks.bookmarks}
              loop={marks.loop}
              others={marks.others}
            />
          </>
        ) : (
          // Empty until the source is chosen — see playLocal.
          sourceChosen && <div ref={hostRef} className="absolute inset-0" />
        )}

        {/* Move-to-wake over the embed. A cross-origin iframe keeps its own
            mouse events, so moving the pointer across the video tells us
            nothing — YouTube's controls come back and ours don't, which in
            fullscreen (where the pointer never leaves the player) left no way
            at all to bring the marks back.

            This sheet sits over the video for exactly as long as our chrome is
            down, catching that first movement; the moment it wakes anything,
            it unmounts and every pixel belongs to the embed again. So it can
            only ever swallow one gesture — and when that gesture is a click, we
            do what the click was going to do anyway: play/pause, through the
            same PlayerApi. (Only ONE case escapes: a double-click begun while
            the chrome was down toggles play instead of leaving fullscreen,
            because the second click lands after this is gone. `f` and Esc still
            do it.) */}
        {/* With our own bar the sheet can simply STAY: there are no YouTube
            controls left for it to swallow clicks meant for, so it sees every
            move and our fade times exactly like a player's. */}
        {!playLocal && (EMBED_OWN_CONTROLS || !chromeUp) && (
          <div
            className="absolute inset-0 z-10"
            onMouseMove={wakeChrome}
            onClick={() => {
              wakeChrome()
              const p = playerRef.current
              if (!p) return
              if (p.getPlayerState() === 1) p.pauseVideo(); else p.playVideo()
            }}
            onDoubleClick={EMBED_OWN_CONTROLS ? toggleFullscreen : undefined}
          />
        )}

        {/* Caption + volume-HUD overlays (defined above). They stay inside the
            box, which is also the fullscreen target, so they show in fullscreen. */}
        {overlays}

        {/* Everything we draw over the EMBED — the caption button, the pin, and
            the bookmark / A–B rail on its progress bar. They fade together with
            YouTube's own controls, or they'd be left sitting alone over an
            otherwise clean video once the embed hides its chrome.

            We can't ask the iframe whether its controls are up, so this follows
            the rule our own control bar uses: shown while the pointer is on the
            player and moving, and whenever it isn't playing. Movement over the
            video is caught by the sheet above. An open caption menu pins them
            too — it would be absurd for the button to fade out from under the
            menu it opened. */}
        {!playLocal && (EMBED_OWN_CONTROLS ? (
          /* Our bar, driven through PlayerApi. The marks go on ITS track, so
             there's no rail to lay over anyone else's, and no offset to measure.
             Nothing covers YouTube's chrome because there is none left: this
             branch only runs with the extension installed, and it has already
             stripped the title, avatar, centre play button and share row from
             inside the iframe. See extension/embed.css. */
          <LocalControls
            player={playerRef}
            storyboard={storyboard}
            hovering={chromeUp}
            onFullscreen={toggleFullscreen}
            leftControls={<>{captionControl}{marksControls}</>}
            extraControls={<>{youtubeButton}{pinButton}</>}
            bookmarks={marks.bookmarks}
            loop={marks.loop}
            others={marks.others}
          />
        ) : (
          <div
            className={`transition-opacity duration-200 ${
              chromeUp ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
          >
            {captionControl}
            {marksControls}
            {youtubeButton}
            {pinButton}
            {/* Over the embed the progress bar lives inside the iframe, so the
                marks are laid over it — see EmbedMarkRail. */}
            <EmbedMarkRail
              bookmarks={marks.bookmarks}
              loop={marks.loop}
              others={marks.others}
              duration={meta?.duration_seconds ?? 0}
              onSeek={seekTo}
            />
          </div>
        ))}

        {/* Up next. Only once the video has actually ENDED, so it can never cover
            something still playing — which also means it lands on top of the
            related-video grid the embed puts up at the end, in place of a wall of
            other people's channels. Dismissing leaves the finished frame alone. */}
        {ended && nextUp && !nextDismissed && (
          <div
            data-testid="up-next"
            className="absolute inset-0 z-20 flex items-center justify-center bg-black/85 px-4"
          >
            <div className="w-full max-w-[22rem] text-center">
              <p className="mb-3 text-xs font-medium uppercase tracking-wide text-[#aaa]">
                Next from {nextUp.channel_name || meta?.channel_name || 'this channel'}
              </p>
              <button
                type="button"
                // Same event a card's plain-click sends, so the overlay swaps
                // video exactly as if you'd clicked this one in the feed.
                onClick={() => window.dispatchEvent(new CustomEvent<VideoItem>('app:watch', { detail: nextUp }))}
                className="block w-full overflow-hidden rounded-xl bg-[#282828] text-left ring-1 ring-white/10 transition-colors hover:bg-[#3f3f3f]"
              >
                <span className="relative block aspect-video w-full bg-black">
                  {nextUp.thumbnail_url && (
                    <img src={nextUp.thumbnail_url} alt="" className="h-full w-full object-cover" />
                  )}
                  {nextUp.duration_seconds > 0 && (
                    <span className="absolute bottom-1.5 right-1.5 rounded bg-black/80 px-1 py-0.5 text-[11px] font-medium text-white">
                      {formatTime(nextUp.duration_seconds)}
                    </span>
                  )}
                </span>
                <span className="block px-3 py-2 text-sm font-medium leading-snug text-white line-clamp-2">
                  {nextUp.title}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setNextDismissed(true)}
                className="mt-3 text-xs text-[#aaa] transition-colors hover:text-white"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

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
                <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
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
                      onClick={() => { setSidePanel((v) => (v === 'transcript' ? null : 'transcript')); setShowMoreMenu(false) }}
                      className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-white transition-colors hover:bg-white/10"
                    >
                      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h10" />
                      </svg>
                      {showTranscript ? 'Hide transcript' : 'Show transcript'}
                    </button>
                  )}
                  {/* Same gate as the transcript, and for the same reason: the
                      answers are read off the caption track, so a video without
                      one has nothing to ask about. */}
                  {!!captions?.length && (
                    <button
                      onClick={() => { setSidePanel((v) => (v === 'ask' ? null : 'ask')); setShowMoreMenu(false) }}
                      className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-white transition-colors hover:bg-white/10"
                    >
                      {/* The sparkle every product uses for "a model did this".
                          A speech bubble would read as chat with a person, and
                          the point of the entry is that it isn't one. */}
                      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                        <path d="M12 2l1.9 5.2L19 9l-5.1 1.8L12 16l-1.9-5.2L5 9l5.1-1.8L12 2z" />
                        <path d="M18.5 14l.85 2.3 2.15.7-2.15.7-.85 2.3-.85-2.3-2.15-.7 2.15-.7.85-2.3z" />
                      </svg>
                      {showAsk ? 'Hide Ask AI' : 'Ask AI'}
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

        {/* Under the description, where YouTube puts them — and in the LEFT
            column, so an open transcript is still the only thing that changes
            this pane's shape. Closed until asked for; see Comments.tsx. */}
        <Comments videoId={videoId} onSeek={seekTo} onChannelClick={onChannelClick} />
        </div>

        {/* Right panel: the caption track as readable prose. Toggled from the "…"
            menu in the action row. Below lg it just stacks under everything. */}
        {twoCol && (
          <div className={`mt-4 lg:mt-0 lg:grow-[999] lg:shrink-0 lg:basis-[26rem] lg:max-w-[56rem] ${fillsPane ? 'lg:flex lg:min-h-0 lg:flex-col' : ''}`}>
            {/* Which of the two the slot is showing, and the way out of both.
                A strip rather than two menu entries fighting over one pane: the
                pane is already open, so switching should be one press and should
                not look like closing and reopening the page. */}
            <div className="mb-2 flex items-center gap-1">
              {([['transcript', 'Transcript'], ['ask', 'Ask AI']] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setSidePanel(key)}
                  aria-pressed={sidePanel === key}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                    sidePanel === key ? 'bg-white text-black' : 'bg-[#272727] text-[#ddd] hover:bg-white/15 hover:text-white'
                  }`}
                >
                  {label}
                </button>
              ))}
              <button
                onClick={() => setSidePanel(null)}
                aria-label="Close panel"
                className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#aaa] transition-colors hover:bg-white/10 hover:text-white"
              >
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            {showTranscript && (<>
            {/* Pick the language and search the lines. */}
            <div className="mb-2 flex items-center gap-2">
              {(captionLangs.length > 1 || aiTranslateAvailable) && (
                <div className="relative shrink-0" ref={transcriptLangRef}>
                  <button
                    onClick={() => setShowTranscriptLangMenu((o) => !o)}
                    aria-label="Transcript language"
                    // The current language lives in the menu's tick; the header is
                    // tight, so the button is just the icon, named on hover.
                    title={`Transcript language: ${transcriptLangLabel}`}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#aaa] transition-colors hover:bg-white/10 hover:text-white"
                  >
                    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <circle cx="12" cy="12" r="9" />
                      <path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18" />
                    </svg>
                  </button>
                  {showTranscriptLangMenu && (
                    <div className="absolute left-0 top-full z-40 mt-2 min-w-[9rem] rounded-xl bg-[#282828] py-1.5 shadow-2xl ring-1 ring-white/10">
                      {captionLangs.map((l) => {
                        const on = l.code === transcriptTrackLang
                        return (
                          <button
                            key={l.code}
                            onClick={() => { setTranscriptLang(l.code); setShowTranscriptLangMenu(false) }}
                            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-white/10 ${on ? 'text-white' : 'text-[#ccc]'}`}
                          >
                            <span className="w-3.5 text-[#3ea6ff]">{on ? '✓' : ''}</span>
                            {l.label}
                          </button>
                        )
                      })}
                      {/* The AI translation, same offer the caption menu makes:
                          only when the source isn't already Chinese. */}
                      {aiTranslateAvailable && (
                        <button
                          onClick={() => { setTranscriptLang(AI_ZH); setShowTranscriptLangMenu(false) }}
                          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-white/10 ${transcriptIsAI ? 'text-white' : 'text-[#ccc]'}`}
                        >
                          <span className="w-3.5 text-[#3ea6ff]">{transcriptIsAI ? '✓' : ''}</span>
                          Chinese
                          <span className="ml-auto pl-3 text-[10px] uppercase tracking-wide text-[#888]">AI</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
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
                {/* The AI transcript fills in batch by batch, so say so rather than
                    letting a partial read look like the whole thing. */}
                {aiTranscriptBusy && (
                  <p className="px-2 py-3 text-sm text-[#888]">翻譯中…</p>
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
            </>)}

            {showAsk && (
              <AskPanel
                videoId={videoId}
                currentTime={curTime}
                onSeek={seekTo}
                fillsPane={fillsPane}
              />
            )}
          </div>
        )}
        </div>
      </div>
    </div>
  )
}
