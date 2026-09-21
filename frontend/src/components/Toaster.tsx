import { useToasts, dismissToast, runUndo } from '../hooks/toastStore'
import { t } from '../lib/i18n'

/**
 * The single toast surface, mounted once in App. Stacks messages bottom-right;
 * each auto-dismisses (toastStore) and can be clicked away.
 *
 * Two kinds, styled apart because they mean different things: an error is red
 * and is news, an undo is neutral and is an offer. The offer keeps its own
 * button — clicking the message itself dismisses, and a misclick that threw the
 * undo away would be a poor thing to do with a toast that exists to catch
 * misclicks.
 */
export default function Toaster() {
  const toasts = useToasts()
  if (toasts.length === 0) return null
  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-[min(92vw,380px)]">
      {toasts.map((toast) => (
        toast.kind === 'undo' ? (
          <div
            key={toast.id}
            className="flex items-center gap-3 rounded-lg border border-[#3f3f3f] bg-[#212121] px-3 py-2 text-xs text-[#eee] shadow-xl"
          >
            <span className="flex-1 [overflow-wrap:anywhere]">{toast.message}</span>
            <button
              onClick={() => runUndo(toast.id)}
              className="flex-shrink-0 cursor-pointer rounded-full px-3 py-1 font-medium text-[#3ea6ff] hover:bg-white/10 transition-colors"
            >
              {t('Undo')}
            </button>
            <button
              onClick={() => dismissToast(toast.id)}
              title={t('Dismiss')}
              aria-label={t('Dismiss')}
              className="flex-shrink-0 cursor-pointer rounded-full px-1.5 py-1 text-[#aaa] hover:bg-white/10 hover:text-white transition-colors"
            >
              ✕
            </button>
          </div>
        ) : (
          <button
            key={toast.id}
            onClick={() => dismissToast(toast.id)}
            title={t('Dismiss')}
            className="text-left w-full rounded-lg border border-[#5c2b2b] bg-[#2a1414] px-3 py-2 text-xs text-[#f2d0d0] shadow-xl hover:bg-[#331818] transition-colors"
          >
            <span className="mr-2">⚠️</span>
            <span className="[overflow-wrap:anywhere]">{toast.message}</span>
          </button>
        )
      ))}
    </div>
  )
}
