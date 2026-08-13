/**
 * The comment section, under the description on the watch page.
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

type Sort = 'top' | 'new'

type Props = {
  videoId: string
  /** Jump the player to a timestamp written in a comment. */
  onSeek: (seconds: number) => void
  onChannelClick?: (channelId: string) => void
}

/* Long comments are usually long because someone pasted a chapter list, and a
 * wall of those between two short remarks makes the thread unreadable. Clamped
 * to this many lines with a "Read more" underneath. */
const CLAMP_LINES = 4

function CommentBody({ text, onSeek }: { text: string; onSeek: (s: number) => void }) {
  const [open, setOpen] = useState(false)
  // A cheap proxy for "will this clamp": measuring the real thing needs a
  // layout pass per comment, and being wrong here costs a "Read more" that
  // reveals nothing rather than anything broken.
  const long = text.length > 300 || text.split('\n').length > CLAMP_LINES

  return (
    <>
      <div
        className={`whitespace-pre-wrap text-sm leading-relaxed text-[#f1f1f1] [overflow-wrap:anywhere]${
          long && !open ? ' line-clamp-4' : ''
        }`}
      >
        {linkify(text, onSeek)}
      </div>
      {long && (
        <button
          onClick={() => setOpen((v) => !v)}
          className="mt-0.5 text-xs font-medium text-[#aaa] hover:text-white"
        >
          {open ? 'Show less' : 'Read more'}
        </button>
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
  comment, depth, onSeek, onChannelClick,
}: {
  comment: Comment
  depth: number
  onSeek: (s: number) => void
  onChannelClick?: (id: string) => void
}) {
  const [openReplies, setOpenReplies] = useState(false)
  const avatar = depth ? 'h-6 w-6' : 'h-9 w-9'
  /* One toggle governs a whole thread, and it counts every reply under it
   * rather than only the direct ones — which is what "12 replies" means to
   * someone deciding whether to open it. Below the top level there is no
   * toggle: the thread is already open, so its shape is simply shown. */
  const replies = comment.replies
  const total = depth ? 0 : replyCount(comment)
  const shown = depth ? replies : openReplies ? replies : []

  return (
    <div>
      <div className="flex gap-3">
      {comment.author_thumbnail ? (
        <img
          src={comment.author_thumbnail}
          alt=""
          loading="lazy"
          onClick={() => comment.author_id && onChannelClick?.(comment.author_id)}
          className={`${avatar} shrink-0 rounded-full ${onChannelClick && comment.author_id ? 'cursor-pointer' : ''}`}
        />
      ) : (
        <div className={`${avatar} shrink-0 rounded-full bg-[#333]`} />
      )}
      <div className="min-w-0 flex-1">
        {comment.is_pinned && (
          <div className="mb-0.5 flex items-center gap-1 text-xs text-[#aaa]">
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 3v2l1 1v4l3 3v2h-6v6l-1 1-1-1v-6H6v-2l3-3V6l1-1V3z" />
            </svg>
            Pinned by creator
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <button
            onClick={() => comment.author_id && onChannelClick?.(comment.author_id)}
            disabled={!comment.author_id || !onChannelClick}
            className={`text-xs font-medium ${
              comment.author_is_uploader
                ? 'rounded-full bg-[#333] px-2 py-0.5 text-white'
                : 'text-[#f1f1f1] hover:text-[#aaa] disabled:hover:text-[#f1f1f1]'
            }`}
          >
            {comment.author}
          </button>
          {comment.author_is_verified && (
            <svg className="h-3.5 w-3.5 text-[#aaa]" viewBox="0 0 24 24" fill="currentColor" aria-label="Verified">
              <path d="M12 2l2.2 2.3 3.2-.4.5 3.2L20.8 9 19 12l1.8 3-2.9 1.9-.5 3.2-3.2-.4L12 22l-2.2-2.3-3.2.4-.5-3.2L3.2 15 5 12 3.2 9l2.9-1.9.5-3.2 3.2.4z" />
              <path d="M10.6 15.4l-2.9-2.9 1.1-1.1 1.8 1.8 4-4 1.1 1.1z" fill="#0f0f0f" />
            </svg>
          )}
          <span className="text-xs text-[#aaa]">{comment.time_text}</span>
        </div>

        <div className="mt-1">
          <CommentBody text={comment.text} onSeek={onSeek} />
        </div>

        <div className="mt-1.5 flex items-center gap-3 text-xs text-[#aaa]">
          {comment.like_count > 0 && (
            <span className="flex items-center gap-1">
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 10v10H4V10zm3 0l3.5-7a2 2 0 013.8 1.2L16.5 9H20a2 2 0 012 2.3l-1.2 7A2 2 0 0118.8 20H10z" />
              </svg>
              {formatCount(comment.like_count)}
            </span>
          )}
          {comment.hearted && (
            <span title="Hearted by creator" className="text-[#ff4e45]">
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 21s-7-4.5-9-9a5 5 0 019-3 5 5 0 019 3c-2 4.5-9 9-9 9z" />
              </svg>
            </span>
          )}
          {total > 0 && (
            <button
              onClick={() => setOpenReplies((v) => !v)}
              className="font-medium text-[#3ea6ff] hover:text-[#6cbcff]"
            >
              {openReplies ? 'Hide' : `${total}`} {total === 1 ? 'reply' : 'replies'}
            </button>
          )}
        </div>
      </div>
      </div>

      {/* The rule down the left is what makes a chain readable — it says which
          comment a reply answers, once the indent has stopped growing. */}
      {shown.length > 0 && (
        <div
          className={`mt-3 space-y-3 border-l border-[#3f3f3f] ${
            depth < MAX_INDENT ? 'ml-4 pl-4' : 'pl-2'
          }`}
        >
          {shown.map((r) => (
            <Thread key={r.id} comment={r} depth={depth + 1} onSeek={onSeek} onChannelClick={onChannelClick} />
          ))}
        </div>
      )}
    </div>
  )
}

export default function Comments({ videoId, onSeek, onChannelClick }: Props) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [sort, setSort] = useState<Sort>('top')
  // The replies walk, running behind the comments already on screen.
  const [deepening, setDeepening] = useState(false)
  // Which request is current. The two walks and a sort change can all be in
  // flight at once, and they finish out of order — the deep one takes six times
  // as long as the shallow one it followed.
  const turn = useRef(0)

  // A new video starts closed and empty. Keeping the panel open across videos
  // would mean fetching on load for every one of them, which is the thing this
  // component exists to avoid.
  useEffect(() => {
    turn.current += 1
    setOpen(false)
    setData(null)
    setFailed(false)
    setDeepening(false)
    setSort('top')
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

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && !data && !loading) load(sort, false)
  }

  const pickSort = (s: Sort) => {
    if (s === sort) return
    setSort(s)
    // Keep whatever depth is already on screen: having waited once for replies,
    // switching to Newest shouldn't silently throw them away.
    load(s, !!data?.has_replies)
  }

  const threads = data?.threads ?? []

  return (
    <div className="mt-4">
      <button
        onClick={toggle}
        className="flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium text-[#f1f1f1] transition-colors hover:bg-white/10"
      >
        <svg
          className={`h-4 w-4 transition-transform ${open ? 'rotate-90' : ''}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        Comments
        {/* "40+" rather than "top 40": the same cap applies under Newest, where
            nothing about the list is top-anything. */}
        {data && !data.disabled && (
          <span className="text-[#aaa]">{threads.length}{data.capped ? '+' : ''}</span>
        )}
      </button>

      {open && (
        <div className="mt-3">
          {loading && (
            <div className="px-3 py-6 text-sm text-[#aaa]">Reading the comments…</div>
          )}

          {!loading && failed && (
            <div className="flex items-center gap-3 px-3 py-4 text-sm text-[#aaa]">
              Couldn't load the comments.
              <button onClick={() => load(sort, false)} className="font-medium text-[#3ea6ff] hover:text-[#6cbcff]">
                Try again
              </button>
            </div>
          )}

          {!loading && !failed && data?.disabled && (
            <div className="px-3 py-4 text-sm text-[#aaa]">Comments are turned off for this video.</div>
          )}

          {!loading && !failed && data && !data.disabled && threads.length === 0 && (
            <div className="px-3 py-4 text-sm text-[#aaa]">No comments yet.</div>
          )}

          {!loading && !failed && threads.length > 0 && (
            <>
              <div className="mb-4 flex items-center gap-2 px-3">
                {(['top', 'new'] as Sort[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => pickSort(s)}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      sort === s ? 'bg-white text-black' : 'bg-[#272727] text-[#f1f1f1] hover:bg-[#3f3f3f]'
                    }`}
                  >
                    {s === 'top' ? 'Top' : 'Newest'}
                  </button>
                ))}
                {/* Not a button. The replies are already on their way; this
                    only explains why reply counts appear a few seconds after
                    the comments they belong to. */}
                {deepening && <span className="text-xs text-[#717171]">loading replies…</span>}
              </div>

              <div className="space-y-5 px-3">
                {threads.map((c) => (
                  <Thread key={c.id} comment={c} depth={0} onSeek={onSeek} onChannelClick={onChannelClick} />
                ))}
              </div>

              {data?.capped && (
                <p className="mt-5 px-3 text-xs text-[#717171]">
                  {sort === 'top' ? `The top ${threads.length}` : `The newest ${threads.length}`} — the app doesn't page through the rest.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
