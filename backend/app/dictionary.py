"""Look a word up in macOS's own Dictionary — the one Look Up (force click) uses.

Dictionary Services is a small C API in CoreServices, reached through ctypes so
it costs no dependency. Like Look Up, a word is looked up in every dictionary
ticked in Dictionary.app, in their order there — English, a Chinese one, a
bilingual one: the person picks there, not here — and each that has it gives
a section.

Reading that list, and asking one dictionary by name, are private calls
(DCSCopyActiveDictionaries and friends) — stable since 10.5 and what every
third-party lookup tool uses. If a macOS release drops them, the lookup falls
back to the public call: one section, from Dictionary.app's first choice.

It's handed the whole caption line and the character under the pointer, not a
word, because it does the segmenting itself: "ice cream" comes back as one term
from either half, and Chinese, which has no spaces to split on, is cut into its
words by the same dictionaries that define them.

Positions are UTF-16 code units at both ends — what a JavaScript string indexes
in and what a CFString counts in — so the page's index goes straight through
and the range that comes back is the one to highlight.

Only on a Mac. Anywhere else (the Linux container) `available()` is False and
the route says so, once, and the page stops asking.
"""

import ctypes
import ctypes.util
import sys
import threading
from dataclasses import dataclass


class _CFRange(ctypes.Structure):
    _fields_ = [("location", ctypes.c_long), ("length", ctypes.c_long)]


_NOT_FOUND = -1  # kCFNotFound, as a range's location

_libs: tuple[ctypes.CDLL, ctypes.CDLL] | None = None
_loaded = False
_can_list = False  # whether the private calls are there
# The calls are a couple of milliseconds; one at a time costs nothing and
# spares us finding out whether Dictionary Services minds the thread pool.
_lock = threading.Lock()


def _load() -> tuple[ctypes.CDLL, ctypes.CDLL] | None:
    global _libs, _loaded, _can_list
    if _loaded:
        return _libs
    _loaded = True
    if sys.platform != "darwin":
        return None
    try:
        cf = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreFoundation"))
        cs = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreServices"))
    except OSError:
        return None
    cf.CFStringCreateWithCharacters.restype = ctypes.c_void_p
    cf.CFStringCreateWithCharacters.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long]
    cf.CFStringGetLength.restype = ctypes.c_long
    cf.CFStringGetLength.argtypes = [ctypes.c_void_p]
    cf.CFStringGetCharacters.argtypes = [ctypes.c_void_p, _CFRange, ctypes.c_void_p]
    cf.CFRelease.argtypes = [ctypes.c_void_p]
    cs.DCSGetTermRangeInString.restype = _CFRange
    cs.DCSGetTermRangeInString.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_long]
    cs.DCSCopyTextDefinition.restype = ctypes.c_void_p
    cs.DCSCopyTextDefinition.argtypes = [ctypes.c_void_p, ctypes.c_void_p, _CFRange]
    cf.CFArrayGetCount.restype = ctypes.c_long
    cf.CFArrayGetCount.argtypes = [ctypes.c_void_p]
    cf.CFArrayGetValueAtIndex.restype = ctypes.c_void_p
    cf.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, ctypes.c_long]
    try:
        cs.DCSCopyActiveDictionaries.restype = ctypes.c_void_p
        cs.DCSCopyActiveDictionaries.argtypes = []
        for name in ("DCSDictionaryGetName", "DCSDictionaryGetIdentifier"):
            getattr(cs, name).restype = ctypes.c_void_p
            getattr(cs, name).argtypes = [ctypes.c_void_p]
        _can_list = True
    except AttributeError:
        pass  # Gone in some macOS: the public default still answers.
    _libs = (cf, cs)
    return _libs


def _str(cf: ctypes.CDLL, ref: int | None) -> str:
    if not ref:
        return ""
    m = cf.CFStringGetLength(ref)
    buf = ctypes.create_string_buffer(m * 2)
    cf.CFStringGetCharacters(ref, _CFRange(0, m), buf)
    return buf.raw.decode("utf-16-le")


# Wikipedia answers over the network, slowly, and as a page's text — styles and
# all — rather than an entry.
_SKIP = {"com.apple.dictionary.Wikipedia"}


def _ticked(cf: ctypes.CDLL, cs: ctypes.CDLL, active: int | None) -> list[tuple[str, int, str]]:
    """(identifier, ref, name) for each dictionary in Dictionary.app's list.
    The refs belong to `active`, so they're good until it's released."""
    out = []
    for i in range(cf.CFArrayGetCount(active) if active else 0):
        d = cf.CFArrayGetValueAtIndex(active, i)
        ident = _str(cf, cs.DCSDictionaryGetIdentifier(d))
        if ident not in _SKIP:
            out.append((ident, d, _str(cf, cs.DCSDictionaryGetName(d))))
    return out


def ticked() -> list[str]:
    """The identifiers of the dictionaries ticked in Dictionary.app, in its order."""
    libs = _load()
    if libs is None or not _can_list:
        return []
    cf, cs = libs
    with _lock:
        active = cs.DCSCopyActiveDictionaries()
        try:
            return [ident for ident, _, _ in _ticked(cf, cs, active)]
        finally:
            if active:
                cf.CFRelease(active)


def available() -> bool:
    return _load() is not None


@dataclass
class Section:
    dictionary: str  # its identifier; "" for Dictionary.app's default
    name: str
    definition: str  # Dictionary Services' plain-text rendering of the entry


@dataclass
class Entry:
    term: str
    start: int  # UTF-16 units into the text
    length: int
    sections: list[Section]  # one per dictionary that has the term, in Dictionary.app's order


def lookup(text: str, at: int) -> Entry | None:
    """The term covering UTF-16 unit `at` of `text`, and its entry in each
    dictionary ticked in Dictionary.app that has it, in its order there —
    read on every lookup, so a change there shows on the next word."""
    libs = _load()
    if libs is None:
        return None
    cf, cs = libs
    units = text.encode("utf-16-le")
    n = len(units) // 2
    if not 0 <= at < n:
        return None
    with _lock:
        active = cs.DCSCopyActiveDictionaries() if _can_list else None
        # Or the public call alone: Dictionary.app's first choice, unnamed.
        refs = _ticked(cf, cs, active) or [("", None, "")]
        s = cf.CFStringCreateWithCharacters(None, units, n)
        try:
            r = None
            sections = []
            for ident, ref, name in refs:
                # The first dictionary to find a term at `at` decides what the
                # term is ("ice cream", or just "ice"); the rest are asked for
                # that same term, so every section is about what's highlighted.
                if r is None:
                    r = _term_at(cs, ref, s, at)
                    if r is None:
                        continue
                definition = _define(cf, cs, ref, s, r)
                if definition:
                    sections.append(Section(ident, name, definition))
                elif not sections:
                    r = None  # a term it then had no entry for; the next decides
        finally:
            cf.CFRelease(s)
            # Last: the refs above belong to this list.
            if active:
                cf.CFRelease(active)
    if not sections:
        return None
    term = units[r.location * 2:(r.location + r.length) * 2].decode("utf-16-le", "replace")
    return Entry(term=term, start=r.location, length=r.length, sections=sections)


def _term_at(cs: ctypes.CDLL, ref: int | None, s: int, at: int) -> _CFRange | None:
    """One dictionary's term covering `at`; `ref` None is the default."""
    # Its offset is a caret, and a caret between two words belongs to the one
    # before it — so the caret just after the character asked about is the one
    # that lands in that character's word.
    r = cs.DCSGetTermRangeInString(ref, s, at + 1)
    # A space or a stop: the nearest term is a neighbour, not this.
    if r.location == _NOT_FOUND or not r.location <= at < r.location + r.length:
        return None
    return r


def _define(cf: ctypes.CDLL, cs: ctypes.CDLL, ref: int | None, s: int, r: _CFRange) -> str:
    d = cs.DCSCopyTextDefinition(ref, s, r)
    if not d:
        return ""
    try:
        return _str(cf, d)
    finally:
        cf.CFRelease(d)
