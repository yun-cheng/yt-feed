export type PlaylistSummary = {
  id: number
  name: string
  item_count: number
  thumbnail_url: string
}

type Props = {
  playlists: PlaylistSummary[]
  onOpen: (id: number) => void
  onDelete: (id: number) => void
}

export default function PlaylistsPage({ playlists, onOpen, onDelete }: Props) {
  if (playlists.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-[#aaa]">
        <svg className="w-12 h-12 text-[#444]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h10M4 18h7M15 15l5 3-5 3v-6z" />
        </svg>
        <p className="text-sm">No playlists yet.</p>
        <p className="text-xs text-[#555]">Open a video's ⋮ menu → 儲存至播放清單 to create one.</p>
      </div>
    )
  }

  return (
    <div className="p-6">
      <p className="text-sm text-[#777] mb-4">{playlists.length} playlists</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {playlists.map((p) => (
          <div key={p.id} className="group cursor-pointer" onClick={() => onOpen(p.id)}>
            <div className="relative aspect-video rounded-xl overflow-hidden bg-[#272727]">
              {p.thumbnail_url ? (
                <img src={p.thumbnail_url} alt="" className="w-full h-full object-cover" loading="lazy" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-[#555]">
                  <svg className="w-10 h-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h10M4 18h7M15 15l5 3-5 3v-6z" />
                  </svg>
                </div>
              )}
              <div className="absolute bottom-1.5 right-1.5 bg-black/80 text-white text-xs px-1.5 py-0.5 rounded flex items-center gap-1">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M4 6h16M4 12h10M4 18h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                {p.item_count}
              </div>
            </div>
            <div className="mt-2 flex items-start justify-between gap-2">
              <h3 className="text-sm font-medium text-white line-clamp-2 leading-5">{p.name}</h3>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(p.id) }}
                title="Delete playlist"
                aria-label="Delete playlist"
                className="flex-shrink-0 p-1 rounded-full text-[#888] hover:text-white hover:bg-white/10 opacity-0 group-hover:opacity-100 transition"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 7h12M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-7 0v12a1 1 0 001 1h6a1 1 0 001-1V7" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
