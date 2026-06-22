const WINDOWS = [
  { value: '1w', label: '1w' },
  { value: '2w', label: '2w' },
  { value: '1m', label: '1m' },
  { value: '3m', label: '3m' },
  { value: '6m', label: '6m' },
  { value: '1y', label: '1y' },
] as const

type Props = {
  window: string
  onWindowChange: (w: string) => void
  onRefresh: () => void
}

export default function TopBar({ window, onWindowChange, onRefresh }: Props) {
  return (
    <header className="sticky top-0 z-10 bg-[#0f0f0f] px-6 py-3 border-b border-[#272727]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm text-[#aaaaaa]">Time:</span>
          <div className="flex gap-1">
            {WINDOWS.map((w) => (
              <button
                key={w.value}
                onClick={() => onWindowChange(w.value)}
                className={`px-3 py-1.5 text-sm rounded-full transition-colors ${
                  window === w.value
                    ? 'bg-white text-black font-medium'
                    : 'bg-[#272727] text-white hover:bg-[#3a3a3a]'
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={onRefresh}
          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-[#272727] text-white rounded-full hover:bg-[#3a3a3a] transition-colors"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M1 4v6h6M23 20v-6h-6" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Refresh
        </button>
      </div>
    </header>
  )
}