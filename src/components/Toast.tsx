import { useEffect, useState } from 'react'
import { X, AlertCircle, CheckCircle, Info, AlertTriangle, Copy, Check } from 'lucide-react'
import { usePDMStore, ToastMessage } from '../stores/pdmStore'

export function Toast() {
  const { toasts, removeToast } = usePDMStore()

  return (
    <div className="fixed bottom-8 left-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map(toast => (
        <ToastItem key={toast.id} toast={toast} onClose={() => removeToast(toast.id)} />
      ))}
    </div>
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

  const icons = {
    error: <AlertCircle size={16} />,
    success: <CheckCircle size={16} />,
    info: <Info size={16} />,
    warning: <AlertTriangle size={16} />
  }

  const colors = {
    error: 'bg-red-900/90 border-red-700 text-red-100',
    success: 'bg-green-900/90 border-green-700 text-green-100',
    info: 'bg-blue-900/90 border-blue-700 text-blue-100',
    warning: 'bg-yellow-900/90 border-yellow-700 text-yellow-100'
  }

  const iconColors = {
    error: 'text-red-400',
    success: 'text-green-400',
    info: 'text-blue-400',
    warning: 'text-yellow-400'
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

