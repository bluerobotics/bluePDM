import { useEffect, useState } from 'react'
import { X, AlertCircle, CheckCircle, Info, AlertTriangle, Copy, Check, Loader2 } from 'lucide-react'
import { usePDMStore, ToastMessage, ToastType } from '../stores/pdmStore'

export function Toast() {
  const { toasts, removeToast, requestCancelProgressToast } = usePDMStore()
  
  // Separate progress toasts from regular toasts
  const progressToasts = toasts.filter(t => t.type === 'progress')
  const regularToasts = toasts.filter(t => t.type !== 'progress')

  return (
    <div className="fixed bottom-8 left-4 z-50 flex flex-col gap-2 max-w-md">
      {/* Progress toasts at the top */}
      {progressToasts.map(toast => (
        <ProgressToastItem 
          key={toast.id} 
          toast={toast} 
          onCancel={() => requestCancelProgressToast(toast.id)}
        />
      ))}
      {/* Regular toasts below */}
      {regularToasts.map(toast => (
        <ToastItem key={toast.id} toast={toast} onClose={() => removeToast(toast.id)} />
      ))}
    </div>
  )
}

function ProgressToastItem({ toast, onCancel }: { toast: ToastMessage; onCancel: () => void }) {
  const [showCancelDialog, setShowCancelDialog] = useState(false)
  const progress = toast.progress
  
  const handleCancelClick = () => {
    setShowCancelDialog(true)
  }
  
  const handleConfirmCancel = () => {
    onCancel()
    setShowCancelDialog(false)
  }
  
  return (
    <>
      <div className="flex flex-col gap-2 px-4 py-3 rounded-lg border shadow-lg backdrop-blur-sm bg-pdm-panel/95 border-pdm-border min-w-[300px]">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {progress?.cancelRequested ? (
              <span className="text-xs text-pdm-warning">Stopping...</span>
            ) : (
              <>
                <Loader2 size={14} className="text-pdm-accent animate-spin" />
                <span className="text-sm text-pdm-fg">{toast.message}</span>
              </>
            )}
          </div>
          {!progress?.cancelRequested && (
            <button
              onClick={handleCancelClick}
              className="opacity-60 hover:opacity-100 transition-opacity text-pdm-fg-muted hover:text-pdm-error"
              title="Stop"
            >
              <X size={14} />
            </button>
          )}
        </div>
        {progress && (
          <div className="flex items-center gap-2">
            <div className="flex-1 h-2 bg-pdm-bg-dark rounded-full overflow-hidden">
              <div 
                className={`h-full transition-all duration-200 ease-out ${progress.cancelRequested ? 'bg-pdm-warning' : 'bg-pdm-accent'}`}
                style={{ width: `${progress.percent}%` }}
              />
            </div>
            <span className="text-xs text-pdm-fg-muted tabular-nums whitespace-nowrap">
              {progress.current}/{progress.total}
            </span>
            {progress.speed && !progress.cancelRequested && (
              <span className="text-xs text-pdm-fg-muted whitespace-nowrap">
                {progress.speed}
              </span>
            )}
          </div>
        )}
      </div>
      
      {/* Cancel Confirmation Dialog */}
      {showCancelDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]">
          <div className="bg-pdm-panel border border-pdm-border rounded-lg shadow-xl max-w-sm w-full mx-4">
            <div className="p-4 border-b border-pdm-border flex items-center gap-3">
              <AlertTriangle size={20} className="text-pdm-warning" />
              <h3 className="font-semibold">Stop Download?</h3>
            </div>
            <div className="p-4">
              <p className="text-sm text-pdm-fg-dim mb-4">
                {progress?.current || 0} of {progress?.total || 0} files have been downloaded.
                Already downloaded files will be kept.
              </p>
              <div className="flex flex-col gap-2">
                <button
                  onClick={handleConfirmCancel}
                  className="btn btn-secondary w-full justify-start gap-2"
                >
                  <X size={16} className="text-pdm-warning" />
                  Stop Download
                </button>
              </div>
            </div>
            <div className="p-4 border-t border-pdm-border flex justify-end">
              <button
                onClick={() => setShowCancelDialog(false)}
                className="btn btn-ghost"
              >
                Continue Downloading
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function ToastItem({ toast, onClose }: { toast: ToastMessage; onClose: () => void }) {
  const [isExiting, setIsExiting] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (toast.duration !== 0) {
      const timer = setTimeout(() => {
        setIsExiting(true)
        setTimeout(onClose, 200) // Wait for exit animation
      }, toast.duration || 5000)
      return () => clearTimeout(timer)
    }
  }, [toast.duration, onClose])

  const handleClose = () => {
    setIsExiting(true)
    setTimeout(onClose, 200)
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(toast.message)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  const icons: Record<ToastType, React.ReactNode> = {
    error: <AlertCircle size={16} />,
    success: <CheckCircle size={16} />,
    info: <Info size={16} />,
    warning: <AlertTriangle size={16} />,
    progress: <Loader2 size={16} className="animate-spin" />
  }

  const colors: Record<ToastType, string> = {
    error: 'bg-red-900/90 border-red-700 text-red-100',
    success: 'bg-green-900/90 border-green-700 text-green-100',
    info: 'bg-blue-900/90 border-blue-700 text-blue-100',
    warning: 'bg-yellow-900/90 border-yellow-700 text-yellow-100',
    progress: 'bg-pdm-panel border-pdm-border text-pdm-fg'
  }

  const iconColors: Record<ToastType, string> = {
    error: 'text-red-400',
    success: 'text-green-400',
    info: 'text-blue-400',
    warning: 'text-yellow-400',
    progress: 'text-pdm-accent'
  }

  return (
    <div
      className={`
        flex items-start gap-3 px-4 py-3 rounded-lg border shadow-lg backdrop-blur-sm
        ${colors[toast.type]}
        ${isExiting ? 'animate-slide-out' : 'animate-slide-in'}
      `}
    >
      <span className={`flex-shrink-0 mt-0.5 ${iconColors[toast.type]}`}>
        {icons[toast.type]}
      </span>
      <p className="flex-1 text-sm leading-relaxed">{toast.message}</p>
      <div className="flex items-center gap-1 flex-shrink-0">
        {/* Copy button - show for errors and warnings */}
        {(toast.type === 'error' || toast.type === 'warning') && (
          <button
            onClick={handleCopy}
            className="opacity-60 hover:opacity-100 transition-opacity p-0.5"
            title={copied ? 'Copied!' : 'Copy error'}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        )}
        <button
          onClick={handleClose}
          className="opacity-60 hover:opacity-100 transition-opacity"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}

