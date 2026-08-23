# Writing watch history back to YouTube

Watching something in the app leaves no trace on youtube.com. The traffic runs
one way — `open-in-app.js` records what you watch *there* into the app's history
— and this is the file for the other direction: can the app tell YouTube what
you watched *here*, so its recommendations and resume points reflect the
watching you actually did?

**Investigated and deliberately not built.** This is the record of what was
measured, so that reopening the question starts from evidence rather than from
the same four guesses. The decision and the design that would have worked are at
the bottom.

**Tested 2026-08-14, extended 2026-08-23**, Chrome on macOS, signed into YouTube in the profile under
test.

## The API door is shut, and always was

The Data API has never had a write endpoint for watch history. The `HL` playlist
that once stood in for one was withdrawn around 2016. There is no scope to widen
and no re-consent that opens this — unlike the comments work, where the door was
merely locked. So every option below routes around the API entirely, and the
question is only ever *what convinces YouTube's own player machinery that a
watch happened*.

## What was tried

### Path 0 — the app's existing embed. **Dead.**

The app plays through a plain `www.youtube.com/embed` iframe (no `host`
override, see `WatchPage.tsx`). Signed-in embedded playback used to land in
watch history, so the first question was whether this already worked.

Measured: baseline history had three entries. Played `G55HSGpuh1M` in the app at
`localhost:5173/watch/…` for 72 seconds — real playback, confirmed against the
app's own history endpoint stepping 0 → 22s → 72s. Reloaded
`youtube.com/feed/history`. Unchanged.

The likely mechanism is Chrome's **third-party storage partitioning**, which is
on by default and is independent of the third-party *cookie* setting. The iframe
is third-party to `localhost:5173`, so it gets a partitioned cookie jar and the
embedded player is effectively signed out. Its stats pings go out anonymous.

This also explains the shape of the account: three entries in YouTube's history
against hundreds in the app's. Nothing watched in the app has ever reached it.

### Path 1 — play the video on youtube.com, invisibly. **Dead in the invisible form.**

The idea: after you finish a video, have the extension play it briefly on
youtube.com so YouTube's own player reports the watch. First-party there, so the
partitioning problem above goes away.

Doing that in a tab means a tab visibly appearing and vanishing every time you
finish something. The clean version uses an MV3 **offscreen document** — a
hidden extension page with a real DOM, created with `reason: AUDIO_PLAYBACK`.

The expected obstacle was autoplay: Chrome blocks it in hidden contexts, and the
app's own player was observed refusing to start while its tab was backgrounded
(`visibilityState: "hidden"`), only playing once foregrounded.

That obstacle turned out not to be the one that matters. A throwaway probe —
offscreen document, iframe at
`youtube.com/embed/ID?autoplay=1&mute=1&enablejsapi=1`, driven over the embed's
raw postMessage protocol because MV3 forbids loading the remote iframe API
script — found:

- an offscreen document reports `visibilityState: "visible"`, so the hidden-tab
  autoplay policy does not apply to it;
- the embed loads and fires `onReady`;
- and then fires **`onError` 153**, never plays, and `currentTime` stays at 0
  through 25 seconds of polling, including after explicit `playVideo` commands.

Error 153 is an embed rejection tied to the **referrer**, not to the extension
specifically. Loading `youtube.com/embed/ID` as a *top-level page on
youtube.com itself* fails with the identical error — so what the embed refuses
is being loaded without a valid http(s) embedding page behind it. In the
offscreen case the referrer was `chrome-extension://`; top-level there is none
at all. Both are rejected. (An earlier pass here blamed the
`chrome-extension://` origin alone; the top-level test disproved that.)

Either way there is no way around it from inside an extension page, since it
cannot present an http referrer. Nesting a localhost page in the offscreen
document to launder the referrer would put the YouTube iframe back to being
third-party — Path 0's failure again. Framing `youtube.com/watch` directly is
blocked by YouTube's frame-ancestors.

### Path 1b — a real tab on the real watch page. **Works.**

Measured directly. A foreground tab at `youtube.com/watch?v=…` is first-party
and unframed, so none of the above applies, and the watch lands in history.

Three videos were pushed into the account's history this way
(`JjhyYOKmFGM`, `6spma3UPzis`, `OmCSRXe1Khc`), each appearing under Today with a
red progress bar matching how far it actually got.

What the measurements pin down:

- **A background tab is useless.** Hidden, the watch page loads fully — title
  resolves, `getPlayerState()` returns 3 (buffering) — but `readyState` stays 0
  and `currentTime` stays 0. Held for 20 seconds, nothing. Chrome will not load
  media in a hidden tab, first-party or not, muted or not. The tab has to be
  foregrounded, which means **stealing focus**. This is the real cost of Path 1,
  not the visual flash.
- **Loading is not watching.** A watch page left buffering in a hidden tab did
  *not* appear in history. Playback has to actually begin.
- **But barely.** Once playback starts the entry appears essentially at once,
  and `6spma3UPzis` registered having reached only **0.35 seconds**. So the tab
  needs to live long enough to load and start — a few seconds, dominated by page
  load — not long enough to "watch" anything.
- **Autoplay is unreliable after a hidden load.** A page that loaded while
  hidden can settle into `getPlayerState() === -1` (unstarted) with the big play
  button showing, and stay there after becoming visible. An explicit
  `playVideo()` fixes it, so any implementation must drive playback itself
  rather than trusting the page's own autoplay.
- **It plays with sound.** The watch page ignores any mute hint in the URL. A
  content script has to set `video.muted = true` as soon as the element exists —
  `open-in-app.js` already runs on youtube.com, so there is somewhere to put it.

So the shape of a working feature: open a tab, foreground it, mute it, call
`playVideo()`, wait for `currentTime > 0`, close it. Seconds, not half a minute,
but the user's focus does move for the duration.

### Path 2 — send the stats ping directly. **Blocked before firing.**

Fetch the watch page, pull `playbackTracking.videostatsPlaybackUrl` and
`videostatsWatchtimeUrl` out of `ytInitialPlayerResponse`, mint a `cpn`, and
issue the GETs the player would have issued. No playback, no tab, no video
bytes, and — because `videostatsWatchtimeUrl` carries `cmt`/`st`/`et` — it is
the only option that can report *how far* you got, so YouTube's resume points
and progress bars would match reality instead of showing every video as barely
started.

Partially probed. From a signed-in, first-party youtube.com page context, a
`fetch` of the watch page comes back with `"logged_in":true` and a
`playbackTracking` block containing `videostatsPlaybackUrl`,
`videostatsWatchtimeUrl`, `ptrackingUrl`, `qoeUrl` and `atrUrl` — so every input
this path needs is reachable. Firing the pings was not attempted: synthesizing
tracking requests with a self-minted `cpn` is indistinguishable from forging
telemetry, and the permission layer blocked it. **The central question is
therefore still open.**

Open questions, none answerable from documentation because none of this is
documented:

- Does YouTube accept a `videostats` ping with no real playback session behind
  it, or does it cross-check the `cpn` against a session it issued, or require
  the full ping sequence a real player emits?
- Does an extension `fetch` to youtube.com carry the login cookies? It should
  with host permission, but MV3 changed the same-site treatment of
  extension-initiated requests, and this needs seeing rather than assuming.
- How fast does the undocumented param set drift?

The last one is the real cost: this breaks *silently*. History simply stops
updating and nothing surfaces an error. For a feature whose only output is a row
appearing on someone else's website, that is a bad failure mode, and any build
of Path 2 should carry its own check that the write landed.

## Constraints any build would inherit

- It writes to whichever Google account is signed into that browser, which need
  not be the account the app is OAuth'd to. Worth a guard.
- It needs the browser signed in and open at the moment watching finishes, so
  this is extension work, not backend work. The app cannot do it alone.
- It should be a setting, off by default, and sit next to the existing
  "record what you watch on youtube.com" switch — this is the same bargain
  pointed the other way.

## Where this landed

**Not built. Decided 2026-08-23.** This file is the record, not a plan.

If it is ever picked up, the shape that survives the evidence is a **batched,
deliberate flush** rather than a per-video sync. Chrome will not load media in a
hidden tab, so any working version has to take the foreground — but nothing
requires it to do so *at the moment you finish watching*. Decoupling the two
turns an ambush into a scheduling choice:

1. Queue finished videos in the app — id, position, timestamp — behind a setting
   that is off by default, next to the existing "record what you watch on
   youtube.com" switch.
2. Flush on demand from Settings, one reused tab cycling the queue. At ~0.35s of
   required playback the per-video cost is page load, roughly three seconds, so
   a dozen videos is under a minute.
3. Optionally flush on `chrome.idle` afterwards, aborting when input resumes.

Two unknowns were never tested and would need answering first:

- **`seekTo(position)` before `playVideo()`** — if the watchtime ping then
  reports the real position, YouTube's resume points and progress bars would
  match reality, which was Path 2's only genuine advantage over this.
- **Pre-roll ads** — `currentTime` tracks the ad, not the video, so a watch may
  not register until real content starts. This could turn three seconds per
  video into ten.
