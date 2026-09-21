"""A removal hands back what it removed.

The convention behind the UI's Undo toast (frontend `lib/undo.ts`). Four
deletions take part — a history row, a playlist item, an imported video, a
download — and each answers with `removed`: the row as the page was already
rendering it, or `None` when there was nothing there to remove.

Undo posts that receipt back, so what returns is the row itself rather than a
fresh one built by replaying the action. The difference is the whole point: a
history row keeps its resume point and its `watched` flag, and a playlist item
keeps its place in a list ordered by when things joined it. Re-reporting a
position or re-adding a video would each produce something subtly different, and
an undo that lands you somewhere near where you were is worse than none.

Nothing here is a general soft-delete: the rows really are gone, and a receipt
is worth only what the client still holds it for.
"""

from datetime import datetime


def stamp_or_now(iso: str | None) -> datetime:
    """The moment carried on a receipt, or now when it can't be read.

    A restore that can't honour the original timestamp still lands — at the top
    of the list rather than in its old place, which is a smaller wrong than
    refusing to put the row back at all.
    """
    if not iso:
        return datetime.utcnow()
    try:
        return datetime.fromisoformat(iso)
    except (TypeError, ValueError):
        return datetime.utcnow()
