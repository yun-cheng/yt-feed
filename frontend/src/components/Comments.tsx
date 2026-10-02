/**
 * The comment section — the watch page's Comments tab, beside Info, and the
 * same comments on the Comments tab of the panel over the player (VideoPanel).
 *
 * Everything here is shaped by one rule: nothing is fetched until you ask for
 * it. There is no prefetch on hover, no warm-up while the video plays, and no
 * remembered "open" state carried to the next video — that last one is the
 * subtle way this feature would break its own rule, since a remembered
 * preference would quietly fetch on every video you opened afterwards.
 *
 * The cost is why. Comments come from yt-dlp walking YouTube's own pages (no
 * Data API, no quota, see `_extract_comments` in the backend), which takes a
 * couple of seconds — affordable when you asked for it, wasteful otherwise.
 *
 * Replies are a second WALK, but not a second ask. YouTube hands them over one
 * thread at a time, so they cost a request per thread and several times the
 * wait (see `COMMENT_PARENTS` in the backend) — too long to hold the comments
 * back for, and not something to make anyone press a button for either. They
 * run behind the comments and fold in when they land.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../lib/api'
import { formatCount, linkify } from '../lib/richText'
import { looksWrittenIn, t, tn, translateTarget } from '../lib/i18n'

export type Comment = {
  id: string
  text: string
  author: string
  author_id: string
  author_thumbnail: string
  author_is_uploader: boolean
  author_is_verified: boolean
  is_pinned: boolean
  hearted: boolean
  like_count: number
  timestamp: number | null
  time_text: string
  replies: Comment[]
}

type Payload = {
  disabled: boolean
  fetched: number
  capped: boolean
  has_replies: boolean
  threads: Comment[]
}

export type Sort = 'top' | 'new'

/* Long comments are usually long because someone pasted a chapter list, and a
 * wall of those between two short remarks makes the thread unreadable. Clamped
 * to this many lines with a "Read more" underneath. */
const CLAMP_LINES = 4

/* A comment in another language offers to translate itself — into the app's
 * language, or the one Settings → Language names for comments — the way
 * YouTube's own comments do. Asked for per comment, on the press: most of a
 * section is never read, and translating it up front would pay for all of it.
 * The press toggles: once translated, it switches back and forth without
 * asking again. */
type Translation = { status: 'loading' } | { status: 'error' } | { status: 'done'; text: string }

function CommentBody({ text, onSeek, videoId, compact }: { text: string; onSeek: (s: number) => void; videoId: string; compact: boolean }) {
  const [open, setOpen] = useState(false)
  const [translation, setTranslation] = useState<Translation | null>(null)
  const [showTranslated, setShowTranslated] = useState(false)
  const lang = translateTarget()
  const offerTranslate = !looksWrittenIn(text, lang)

  const toggleTranslate = async () => {
    if (translation?.status === 'done') { setShowTranslated((v) => !v); return }
    if (translation?.status === 'loading') return
    setTranslation({ status: 'loading' })
    try {
      const res = await apiFetch('/api/feed/comments-translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, target: lang, video_id: videoId }),
        // Said under the comment, where it was asked for, rather than as a toast.
        quiet: true,
      })
      if (!res.ok) throw new Error()
      const d = await res.json()
      setTranslation({ status: 'done', text: String(d.text ?? '') })
      setShowTranslated(true)
    } catch {
      setTranslation({ status: 'error' })
    }
  }

  const shown = showTranslated && translation?.status === 'done' ? translation.text : text
  // A cheap proxy for "will this clamp": measuring the real thing needs a
  // layout pass per comment, and being wrong here costs a "Read more" that
  // reveals nothing rather than anything broken.
  const long = text.length > 300 || text.split('\n').length > CLAMP_LINES

  return (
    <>
      <div
        className={`whitespace-pre-wrap ${compact ? 'text-(length:--panel-body) leading-snug' : 'text-sm leading-relaxed'} text-shade-f1 [overflow-wrap:anywhere]${
          long && !open ? ' line-clamp-4' : ''
        }`}
      >
        {linkify(shown, onSeek)}
      </div>
      {(long || offerTranslate) && (
        <div className="mt-0.5 flex items-center gap-3 text-xs font-medium">
          {long && (
            <button
              onClick={() => setOpen((v) => !v)}
              className="text-shade-aa hover:text-white"
            >
              {open ? t('Show less') : t('Read more')}
            </button>
          )}
          {offerTranslate && (
            <button
              onClick={toggleTranslate}
              disabled={translation?.status === 'loading'}
              className="text-shade-aa hover:text-white disabled:cursor-default disabled:hover:text-shade-aa"
            >
              {translation?.status === 'loading' ? t('Translating…')
                : translation?.status === 'error' ? t('Couldn\'t translate — try again')
                : showTranslated ? t('Show original')
                : t('Translate')}
            </button>
          )}
        </div>
      )}
    </>
  )
}

/** How many replies hang off a comment, at any depth. */
function replyCount(comment: Comment): number {
  return comment.replies.reduce((n, r) => n + 1 + replyCount(r), 0)
}

/* Replies chain — A answers B answers C — and each level is drawn one step in,
 * with a rule down the left to show what answers what. Past this depth the
 * indent stops and only the rule continues: a long argument would otherwise
 * walk itself off the right-hand side and end up a column two words wide. */
const MAX_INDENT = 3

function Thread({
  comment, depth, onSeek, onChannelClick, videoId, compact,
}: {
  comment: Comment
  depth: number
  videoId: string
  compact: boolean
  onSeek: (s: number) => void
  onChannelClick?: (id: string) => void
}) {
  const [openReplies, setOpenReplies] = useState(false)
  const avatar = compact ? (depth ? 'h-5 w-5' : 'h-6 w-6') : depth ? 'h-6 w-6' : 'h-9 w-9'
  /* One toggle governs a whole thread, and it counts every reply under it
   * rather than only the direct ones — which is what "12 replies" means to
   * someone deciding whether to open it. Below the top level there is no
   * toggle: the thread is already open, so its shape is simply shown. */
  const replies = comment.replies
  const total = depth ? 0 : replyCount(comment)
  const shown = depth ? replies : openReplies ? replies : []

  return (
    <div>
      <div className={`flex ${compact ? 'gap-2' : 'gap-3'}`}>
      {comment.author_thumbnail ? (
        <img
          src={comment.author_thumbnail}
          alt=""
          loading="lazy"
          onClick={() => comment.author_id && onChannelClick?.(comment.author_id)}
          className={`${avatar} shrink-0 rounded-full ${onChannelClick && comment.author_id ? 'cursor-pointer' : ''}`}
        />
      ) : (
        <div className={`${avatar} shrink-0 rounded-full bg-shade-33`} />
      )}
      <div className="min-w-0 flex-1">
        {comment.is_pinned && (
          <div className="mb-0.5 flex items-center gap-1 text-xs text-shade-aa">
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 3v2l1 1v4l3 3v2h-6v6l-1 1-1-1v-6H6v-2l3-3V6l1-1V3z" />
            </svg>
            {t('Pinned by creator')}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <button
            onClick={() => comment.author_id && onChannelClick?.(comment.author_id)}
            disabled={!comment.author_id || !onChannelClick}
            className={`text-xs font-medium ${
              comment.author_is_uploader
                ? 'rounded-full bg-shade-33 px-2 py-0.5 text-white'
                : 'text-shade-f1 hover:text-shade-aa disabled:hover:text-shade-f1'
            }`}
          >
            {comment.author}
          </button>
          {comment.author_is_verified && (
            <svg className="h-3.5 w-3.5 text-shade-aa" viewBox="0 0 24 24" fill="currentColor" aria-label={t('Verified')}>
              <path d="M12 2l2.2 2.3 3.2-.4.5 3.2L20.8 9 19 12l1.8 3-2.9 1.9-.5 3.2-3.2-.4L12 22l-2.2-2.3-3.2.4-.5-3.2L3.2 15 5 12 3.2 9l2.9-1.9.5-3.2 3.2.4z" />
              <path d="M10.6 15.4l-2.9-2.9 1.1-1.1 1.8 1.8 4-4 1.1 1.1z" className="fill-shade-0f" />
            </svg>
          )}
          <span className="text-xs text-shade-aa">{comment.time_text}</span>
        </div>

        <div className="mt-1">
          <CommentBody text={comment.text} onSeek={onSeek} videoId={videoId} compact={compact} />
        </div>

        <div className="mt-1.5 flex items-center gap-3 text-xs text-shade-aa">
          {comment.like_count > 0 && (
            <span className="flex items-center gap-1">
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 10v10H4V10zm3 0l3.5-7a2 2 0 013.8 1.2L16.5 9H20a2 2 0 012 2.3l-1.2 7A2 2 0 0118.8 20H10z" />
              </svg>
              {formatCount(comment.like_count)}
            </span>
          )}
          {comment.hearted && (
            <span title={t('Hearted by creator')} className="text-tint-ff4e45">
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 21s-7-4.5-9-9a5 5 0 019-3 5 5 0 019 3c-2 4.5-9 9-9 9z" />
              </svg>
            </span>
          )}
          {total > 0 && (
            <button
              onClick={() => setOpenReplies((v) => !v)}
              className="font-medium text-tint-3ea6ff hover:text-tint-6cbcff"
            >
              {openReplies ? tn(total, 'Hide reply', 'Hide replies') : tn(total, '{n} reply', '{n} replies')}
            </button>
          )}
        </div>
      </div>
      </div>

      {/* The rule down the left is what makes a chain readable — it says which
          comment a reply answers, once the indent has stopped growing. */}
      {shown.length > 0 && (
        <div
          className={`${compact ? 'mt-2 space-y-2' : 'mt-3 space-y-3'} border-l border-shade-3f ${
            depth < MAX_INDENT ? (compact ? 'ml-2.5 pl-2.5' : 'ml-4 pl-4') : 'pl-2'
          }`}
        >
          {shown.map((r) => (
            <Thread key={r.id} comment={r} depth={depth + 1} onSeek={onSeek} onChannelClick={onChannelClick} videoId={videoId} compact={compact} />
          ))}
        </div>
      )}
    </div>
  )
}

export type CommentsFeed = {
  data: Payload | null
  loading: boolean
  failed: boolean
  /** The replies walk, running behind the comments already on screen. */
  deepening: boolean
  /** Ask again after a failure — the one fetch a press makes happen. */
  retry: () => void
}

/**
 * What was fetched for one video, shared by everything that shows it — the
 * Comments tab and the panel over the video. One owner, so opening the second
 * after the first reads what's already here rather than walking YouTube again.
 *
 * `wanted` is the ask: true while either of them is showing. See the top of the
 * file for why nothing is fetched at any other moment.
 */
export function useComments(videoId: string, sort: Sort, wanted: boolean): CommentsFeed {
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  // The replies walk, running behind the comments already on screen.
  const [deepening, setDeepening] = useState(false)
  // Which request is current. The two walks and a sort change can all be in
  // flight at once, and they finish out of order — the deep one takes six times
  // as long as the shallow one it followed.
  const turn = useRef(0)

  // A new video starts empty. The watch page puts it back on Info, too: keeping
  // this tab open across videos would mean fetching on load for every one of
  // them, which is the thing this component exists to avoid.
  useEffect(() => {
    turn.current += 1
    setData(null)
    setFailed(false)
    setDeepening(false)
  }, [videoId])

  /**
   * Fetch the comments, then quietly fetch them again with their replies.
   *
   * Two walks, one action. Opening the panel is the ask, and asking a second
   * time for the replies would be asking about how this is fetched rather than
   * about anything on screen. So the comments land in ~2s and are readable
   * immediately, and the replies fold themselves in when they arrive.
   *
   * The second walk is skipped when there's nothing to deepen — a switched-off
   * or empty section, or a set of comments that already came back with replies
   * (a sort change reusing the depth already paid for).
   */
  const load = useCallback(async (nextSort: Sort, replies: boolean) => {
    const mine = ++turn.current
    setLoading(true)
    setFailed(false)
    setDeepening(false)
    try {
      const res = await apiFetch(
        `/api/feed/comments/${videoId}?sort=${nextSort}${replies ? '&replies=1' : ''}`,
        { quiet: true },
      )
      if (!res.ok) throw new Error(String(res.status))
      const body: Payload = await res.json()
      if (turn.current !== mine) return
      setData(body)
      setLoading(false)
      if (replies || body.has_replies || !body.threads.length) return

      setDeepening(true)
      try {
        const deep = await apiFetch(
          `/api/feed/comments/${videoId}?sort=${nextSort}&replies=1`,
          { quiet: true },
        )
        if (!deep.ok) throw new Error(String(deep.status))
        const body2: Payload = await deep.json()
        // Replacing the list is safe mid-read: same sort, same order, and each
        // comment keeps its identity by id — so nothing jumps under the cursor,
        // the threads just gain their reply counts.
        if (turn.current === mine) setData(body2)
      } catch {
        // The comments are on screen and readable. A failed replies walk is
        // worth nothing said about it: there was no promise of replies to break.
      } finally {
        if (turn.current === mine) setDeepening(false)
      }
    } catch {
      if (turn.current !== mine) return
      setFailed(true)
      setLoading(false)
    }
  }, [videoId])

  // Fetch on the switch TO showing them, and only then. Keyed on the transition
  // rather than on "open with nothing loaded", so a failed fetch waits for Try
  // again instead of retrying itself, and a new video arriving while they're
  // still showing doesn't count as asking — the page closes them with it.
  const wasWanted = useRef(false)
  useEffect(() => {
    const opening = wanted && !wasWanted.current
    wasWanted.current = wanted
    if (opening && !data && !loading) load(sort, false)
  }, [wanted])  // eslint-disable-line react-hooks/exhaustive-deps

  // A new sort re-reads what's on screen — and only that: before anything has
  // been fetched it is just the order the first fetch will use. It keeps
  // whatever depth is already there: having waited once for replies, switching
  // to Newest shouldn't silently throw them away.
  const fetchedSort = useRef(sort)
  useEffect(() => {
    if (sort === fetchedSort.current) return
    fetchedSort.current = sort
    if (data || loading) load(sort, !!data?.has_replies)
  }, [sort])  // eslint-disable-line react-hooks/exhaustive-deps

  return { data, loading, failed, deepening, retry: () => load(sort, false) }
}

type ListProps = {
  videoId: string
  feed: CommentsFeed
  sort: Sort
  onSeek: (seconds: number) => void
  onChannelClick?: (channelId: string) => void
  /** Smaller type and avatars, for the panel over the video. */
  compact?: boolean
}

/** The comments themselves, with whatever the fetch has to say instead. Also
 * what the panel over the video shows on its Comments tab, `compact`. */
export function CommentList({ videoId, feed, sort, onSeek, onChannelClick, compact = false }: ListProps) {
  const { data, loading, failed, deepening } = feed
  const threads = data?.threads ?? []
  const note = compact ? 'py-3 text-xs' : 'py-4 text-sm'

  return (
    <div>
      {loading && (
        <div className={`px-3 ${compact ? 'py-3 text-xs' : 'py-6 text-sm'} text-shade-aa`}>{t('Reading the comments…')}</div>
      )}

      {!loading && failed && (
        <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 ${note} text-shade-aa`}>
          {t('Couldn\'t load the comments.')}
          <button onClick={feed.retry} className="font-medium text-tint-3ea6ff hover:text-tint-6cbcff">
            Try again
          </button>
        </div>
      )}

      {!loading && !failed && data?.disabled && (
        <div className={`px-3 ${note} text-shade-aa`}>{t('Comments are turned off for this video.')}</div>
      )}

      {!loading && !failed && data && !data.disabled && threads.length === 0 && (
        <div className={`px-3 ${note} text-shade-aa`}>{t('No comments yet.')}</div>
      )}

      {!loading && !failed && threads.length > 0 && (
        <>
          {/* Not a button. The replies are already on their way; this
              only explains why reply counts appear a few seconds after the
              comments they belong to. */}
          {deepening && <p className={`${compact ? 'mb-2' : 'mb-3'} px-3 text-xs text-shade-99`}>{t('loading replies…')}</p>}

          <div className={`${compact ? 'space-y-3' : 'space-y-5'} px-3`}>
            {threads.map((c) => (
              <Thread key={c.id} comment={c} depth={0} onSeek={onSeek} onChannelClick={onChannelClick} videoId={videoId} compact={compact} />
            ))}
          </div>

          {data?.capped && (
            <p className={`${compact ? 'mt-3' : 'mt-5'} px-3 text-xs text-shade-99`}>
              {sort === 'top' ? t('The top {n} — the app doesn\'t page through the rest.', { n: threads.length }) : t('The newest {n} — the app doesn\'t page through the rest.', { n: threads.length })}
            </p>
          )}
        </>
      )}
    </div>
  )
}

type Props = ListProps & {
  /** Whether the tab is showing. The fetch is `useComments`'s; this only draws. */
  open: boolean
}

/** The Comments tab. Closed, it renders nothing; what was fetched lives in the
 * feed, so it's still there when the tab comes back. */
export default function Comments({ open, ...list }: Props) {
  if (!open) return null
  return <CommentList {...list} />
}
