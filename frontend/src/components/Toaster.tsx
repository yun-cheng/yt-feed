import { useToasts, dismissToast } from '../hooks/toastStore'

/**
 * The single toast surface, mounted once in App. Stacks messages bottom-right;
 * each auto-dismisses (toastStore) and can be clicked away. Errors only, today.
 */
export default function Toaster() {
  const toasts = useToasts()
  if (toasts.length === 0) return null
  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-[min(92vw,380px)]">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismissToast(t.id)}
          title="Dismiss"
          className="text-left w-full rounded-lg border border-[#5c2b2b] bg-[#2a1414] px-3 py-2 text-xs text-[#f2d0d0] shadow-xl hover:bg-[#331818] transition-colors"
        >
          <span className="mr-2">⚠️</span>
          <span className="[overflow-wrap:anywhere]">{t.message}</span>
        </button>
      ))}
    </div>
  )
}
