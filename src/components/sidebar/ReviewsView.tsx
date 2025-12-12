import { useState, useEffect, useCallback } from 'react'
import { 
  Bell, 
  CheckCircle2, 
  XCircle, 
  Clock, 
  Send, 
  User,
  FileText,
  ChevronRight,
  Loader2,
  MessageSquare,
  Check,
  X,
  Trash2,
  MailOpen,
  RefreshCw
} from 'lucide-react'
import { usePDMStore } from '../../stores/pdmStore'
import { 
  getNotifications, 
  getMyReviews,
  getPendingReviewsForUser,
  respondToReview,
  markNotificationsRead,
  markAllNotificationsRead,
  deleteNotification,
  cancelReview
} from '../../lib/supabase'
import type { Review, Notification, ReviewStatus } from '../../types/database'

type ViewTab = 'notifications' | 'pending' | 'my-reviews'

export function ReviewsView() {
  const { 
    user, 
    organization, 
    addToast, 
    unreadNotificationCount, 
    setUnreadNotificationCount,
    pendingReviewCount,
    setPendingReviewCount
  } = usePDMStore()
  
  const [activeTab, setActiveTab] = useState<ViewTab>('notifications')
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [pendingReviews, setPendingReviews] = useState<Review[]>([])
  const [myReviews, setMyReviews] = useState<Review[]>([])
  const [loading, setLoading] = useState(true)
  const [respondingTo, setRespondingTo] = useState<string | null>(null)
  const [responseComment, setResponseComment] = useState('')
  const [expandedReview, setExpandedReview] = useState<string | null>(null)
  
  // Load data based on active tab
  const loadData = useCallback(async () => {
    if (!user?.id || !organization?.id) return
    
    setLoading(true)
    
    try {
      if (activeTab === 'notifications') {
        const { notifications: data } = await getNotifications(user.id, { limit: 50 })
        setNotifications(data)
        
        // Update unread count
        const unreadCount = data.filter(n => !n.read).length
        setUnreadNotificationCount(unreadCount)
      } else if (activeTab === 'pending') {
        const { reviews } = await getPendingReviewsForUser(user.id, organization.id)
        setPendingReviews(reviews)
        setPendingReviewCount(reviews.length)
      } else if (activeTab === 'my-reviews') {
        const { reviews } = await getMyReviews(user.id, organization.id, { asRequester: true, asReviewer: false })
        setMyReviews(reviews)
      }
    } catch (err) {
      console.error('Error loading reviews data:', err)
    } finally {
      setLoading(false)
    }
  }, [user?.id, organization?.id, activeTab, setUnreadNotificationCount, setPendingReviewCount])
  
  useEffect(() => {
    loadData()
  }, [loadData])
  
  // Handle responding to a review
  const handleRespond = async (reviewId: string, status: 'approved' | 'rejected') => {
    if (!user?.id) return
    
    setRespondingTo(reviewId)
    
    const { success, error } = await respondToReview(
      reviewId,
      user.id,
      status,
      responseComment || undefined
    )
    
    if (success) {
      addToast('success', `Review ${status}`)
      setResponseComment('')
      setExpandedReview(null)
      loadData()
    } else {
      addToast('error', error || 'Failed to respond to review')
    }
    
    setRespondingTo(null)
  }
  
  // Handle marking notification as read
  const handleMarkRead = async (notificationId: string) => {
    const { success } = await markNotificationsRead([notificationId])
    if (success) {
      setNotifications(prev => 
        prev.map(n => n.id === notificationId ? { ...n, read: true, read_at: new Date().toISOString() } : n)
      )
      setUnreadNotificationCount(Math.max(0, unreadNotificationCount - 1))
    }
  }
  
  // Handle marking all as read
  const handleMarkAllRead = async () => {
    if (!user?.id) return
    
    const { success, updated } = await markAllNotificationsRead(user.id)
    if (success) {
      setNotifications(prev => prev.map(n => ({ ...n, read: true, read_at: new Date().toISOString() })))
      setUnreadNotificationCount(0)
      if (updated > 0) {
        addToast('success', `Marked ${updated} notifications as read`)
      }
    }
  }
  
  // Handle deleting a notification
  const handleDeleteNotification = async (notificationId: string) => {
    const notification = notifications.find(n => n.id === notificationId)
    const { success } = await deleteNotification(notificationId)
    if (success) {
      setNotifications(prev => prev.filter(n => n.id !== notificationId))
      if (notification && !notification.read) {
        setUnreadNotificationCount(Math.max(0, unreadNotificationCount - 1))
      }
    }
  }
  
  // Handle cancelling a review
  const handleCancelReview = async (reviewId: string) => {
    if (!user?.id) return
    
    const { success, error } = await cancelReview(reviewId, user.id)
    if (success) {
      addToast('success', 'Review cancelled')
      loadData()
    } else {
      addToast('error', error || 'Failed to cancel review')
    }
  }
  
  // Format relative time
  const formatRelativeTime = (dateStr: string) => {
    const date = new Date(dateStr)
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    
    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)
    const days = Math.floor(diff / 86400000)
    
    if (minutes < 1) return 'Just now'
    if (minutes < 60) return `${minutes}m ago`
    if (hours < 24) return `${hours}h ago`
    if (days < 7) return `${days}d ago`
    return date.toLocaleDateString()
  }
  
  // Get status color
  const getStatusColor = (status: ReviewStatus) => {
    switch (status) {
      case 'approved': return 'text-pdm-success'
      case 'rejected': return 'text-pdm-error'
      case 'cancelled': return 'text-pdm-fg-muted'
      default: return 'text-pdm-warning'
    }
  }
  
  // Get status icon
  const getStatusIcon = (status: ReviewStatus) => {
    switch (status) {
      case 'approved': return <CheckCircle2 size={14} className="text-pdm-success" />
      case 'rejected': return <XCircle size={14} className="text-pdm-error" />
      case 'cancelled': return <X size={14} className="text-pdm-fg-muted" />
      default: return <Clock size={14} className="text-pdm-warning" />
    }
  }
  
  // Get notification icon
  const getNotificationIcon = (type: string) => {
    switch (type) {
      case 'review_request': return <Send size={14} className="text-pdm-accent" />
      case 'review_approved': return <CheckCircle2 size={14} className="text-pdm-success" />
      case 'review_rejected': return <XCircle size={14} className="text-pdm-error" />
      case 'review_comment': return <MessageSquare size={14} className="text-pdm-accent" />
      case 'checkout_request': return <Clock size={14} className="text-pdm-warning" />
      case 'mention': return <User size={14} className="text-pdm-accent" />
      case 'file_updated': return <FileText size={14} className="text-pdm-fg-dim" />
      default: return <Bell size={14} className="text-pdm-fg-dim" />
    }
  }
  
  if (!user) {
    return (
      <div className="p-4 text-center text-pdm-fg-muted">
        <Bell size={32} className="mx-auto mb-2 opacity-50" />
        <p className="text-sm">Sign in to view reviews and notifications</p>
      </div>
    )
  }
  
  return (
    <div className="flex flex-col h-full">
      {/* Tabs */}
      <div className="flex border-b border-pdm-border">
        <button
          onClick={() => setActiveTab('notifications')}
          className={`flex-1 px-3 py-2 text-xs font-medium transition-colors relative ${
            activeTab === 'notifications'
              ? 'text-pdm-accent border-b-2 border-pdm-accent -mb-px'
              : 'text-pdm-fg-muted hover:text-pdm-fg'
          }`}
        >
          <Bell size={12} className="inline mr-1" />
          Notifications
          {unreadNotificationCount > 0 && (
            <span className="absolute top-1 right-2 w-4 h-4 bg-pdm-accent text-white text-[10px] rounded-full flex items-center justify-center">
              {unreadNotificationCount > 9 ? '9+' : unreadNotificationCount}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('pending')}
          className={`flex-1 px-3 py-2 text-xs font-medium transition-colors relative ${
            activeTab === 'pending'
              ? 'text-pdm-accent border-b-2 border-pdm-accent -mb-px'
              : 'text-pdm-fg-muted hover:text-pdm-fg'
          }`}
        >
          <Clock size={12} className="inline mr-1" />
          Pending
          {pendingReviewCount > 0 && (
            <span className="absolute top-1 right-2 w-4 h-4 bg-pdm-warning text-white text-[10px] rounded-full flex items-center justify-center">
              {pendingReviewCount > 9 ? '9+' : pendingReviewCount}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('my-reviews')}
          className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
            activeTab === 'my-reviews'
              ? 'text-pdm-accent border-b-2 border-pdm-accent -mb-px'
              : 'text-pdm-fg-muted hover:text-pdm-fg'
          }`}
        >
          <Send size={12} className="inline mr-1" />
          My Requests
        </button>
      </div>
      
      {/* Actions bar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-pdm-border bg-pdm-bg-light/50">
        <button
          onClick={loadData}
          disabled={loading}
          className="text-xs text-pdm-fg-muted hover:text-pdm-fg flex items-center gap-1"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
        
        {activeTab === 'notifications' && unreadNotificationCount > 0 && (
          <button
            onClick={handleMarkAllRead}
            className="text-xs text-pdm-accent hover:text-pdm-accent/80 flex items-center gap-1"
          >
            <MailOpen size={12} />
            Mark all read
          </button>
        )}
      </div>
      
      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center p-8">
            <Loader2 size={24} className="animate-spin text-pdm-accent" />
          </div>
        ) : activeTab === 'notifications' ? (
          // Notifications list
          notifications.length === 0 ? (
            <div className="p-4 text-center text-pdm-fg-muted">
              <Bell size={32} className="mx-auto mb-2 opacity-50" />
              <p className="text-sm">No notifications yet</p>
            </div>
          ) : (
            <div className="divide-y divide-pdm-border">
              {notifications.map(notification => (
                <div
                  key={notification.id}
                  className={`p-3 hover:bg-pdm-highlight transition-colors group ${
                    !notification.read ? 'bg-pdm-accent/5' : ''
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <div className="mt-0.5">
                      {getNotificationIcon(notification.type)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-medium truncate ${!notification.read ? 'text-pdm-fg' : 'text-pdm-fg-dim'}`}>
                          {notification.title}
                        </span>
                        {!notification.read && (
                          <span className="w-2 h-2 bg-pdm-accent rounded-full flex-shrink-0" />
                        )}
                      </div>
                      {notification.message && (
                        <p className="text-xs text-pdm-fg-muted mt-0.5 line-clamp-2">
                          {notification.message}
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[10px] text-pdm-fg-muted">
                          {formatRelativeTime(notification.created_at)}
                        </span>
                        {notification.from_user && (
                          <span className="text-[10px] text-pdm-fg-muted flex items-center gap-1">
                            <User size={10} />
                            {notification.from_user.full_name || notification.from_user.email}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      {!notification.read && (
                        <button
                          onClick={() => handleMarkRead(notification.id)}
                          className="p-1 text-pdm-fg-muted hover:text-pdm-fg rounded"
                          title="Mark as read"
                        >
                          <Check size={12} />
                        </button>
                      )}
                      <button
                        onClick={() => handleDeleteNotification(notification.id)}
                        className="p-1 text-pdm-fg-muted hover:text-pdm-error rounded"
                        title="Delete"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : activeTab === 'pending' ? (
          // Pending reviews (need response)
          pendingReviews.length === 0 ? (
            <div className="p-4 text-center text-pdm-fg-muted">
              <CheckCircle2 size={32} className="mx-auto mb-2 opacity-50" />
              <p className="text-sm">No pending reviews</p>
              <p className="text-xs mt-1">You're all caught up!</p>
            </div>
          ) : (
            <div className="divide-y divide-pdm-border">
              {pendingReviews.map(review => (
                <div key={review.id} className="p-3">
                  {/* Review header */}
                  <div 
                    className="flex items-start gap-2 cursor-pointer"
                    onClick={() => setExpandedReview(expandedReview === review.id ? null : review.id)}
                  >
                    <FileText size={14} className="mt-0.5 text-pdm-fg-dim flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-pdm-fg truncate">
                          {review.file?.file_name || 'Unknown file'}
                        </span>
                        {getStatusIcon(review.status)}
                      </div>
                      {review.title && (
                        <p className="text-xs text-pdm-fg-dim mt-0.5">{review.title}</p>
                      )}
                      {/* Priority and Due Date badges */}
                      <div className="flex items-center gap-1 mt-1 flex-wrap">
                        {review.priority && review.priority !== 'normal' && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                            review.priority === 'urgent' ? 'bg-pdm-error/20 text-pdm-error' :
                            review.priority === 'high' ? 'bg-pdm-warning/20 text-pdm-warning' :
                            'bg-pdm-fg-muted/20 text-pdm-fg-muted'
                          }`}>
                            {review.priority.toUpperCase()}
                          </span>
                        )}
                        {review.due_date && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded flex items-center gap-0.5 ${
                            new Date(review.due_date) < new Date() ? 'bg-pdm-error/20 text-pdm-error' :
                            new Date(review.due_date) < new Date(Date.now() + 2 * 24 * 60 * 60 * 1000) ? 'bg-pdm-warning/20 text-pdm-warning' :
                            'bg-pdm-fg-muted/20 text-pdm-fg-muted'
                          }`}>
                            <Clock size={10} />
                            Due {new Date(review.due_date).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-[10px] text-pdm-fg-muted">
                        <span className="flex items-center gap-1">
                          <User size={10} />
                          {review.requester?.full_name || review.requester?.email}
                        </span>
                        <span>•</span>
                        <span>v{review.file_version}</span>
                        <span>•</span>
                        <span>{formatRelativeTime(review.created_at)}</span>
                      </div>
                    </div>
                    <ChevronRight 
                      size={14} 
                      className={`text-pdm-fg-muted transition-transform ${
                        expandedReview === review.id ? 'rotate-90' : ''
                      }`}
                    />
                  </div>
                  
                  {/* Expanded review details */}
                  {expandedReview === review.id && (
                    <div className="mt-3 ml-6 space-y-3">
                      {review.message && (
                        <div className="p-2 bg-pdm-bg-light rounded text-xs text-pdm-fg-dim">
                          {review.message}
                        </div>
                      )}
                      
                      {/* Response form */}
                      <div className="space-y-2">
                        <textarea
                          placeholder="Add a comment (optional)..."
                          value={responseComment}
                          onChange={(e) => setResponseComment(e.target.value)}
                          className="w-full px-2 py-1.5 text-xs bg-pdm-bg border border-pdm-border rounded resize-none focus:outline-none focus:border-pdm-accent"
                          rows={2}
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleRespond(review.id, 'approved')}
                            disabled={respondingTo === review.id}
                            className="flex-1 px-3 py-1.5 text-xs font-medium bg-pdm-success text-white rounded hover:bg-pdm-success/90 disabled:opacity-50 flex items-center justify-center gap-1"
                          >
                            {respondingTo === review.id ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <CheckCircle2 size={12} />
                            )}
                            Approve
                          </button>
                          <button
                            onClick={() => handleRespond(review.id, 'rejected')}
                            disabled={respondingTo === review.id}
                            className="flex-1 px-3 py-1.5 text-xs font-medium bg-pdm-error text-white rounded hover:bg-pdm-error/90 disabled:opacity-50 flex items-center justify-center gap-1"
                          >
                            {respondingTo === review.id ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <XCircle size={12} />
                            )}
                            Reject
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )
        ) : (
          // My reviews (reviews I requested)
          myReviews.length === 0 ? (
            <div className="p-4 text-center text-pdm-fg-muted">
              <Send size={32} className="mx-auto mb-2 opacity-50" />
              <p className="text-sm">No review requests</p>
              <p className="text-xs mt-1">Right-click a file to request a review</p>
            </div>
          ) : (
            <div className="divide-y divide-pdm-border">
              {myReviews.map(review => (
                <div key={review.id} className="p-3">
                  {/* Review header */}
                  <div 
                    className="flex items-start gap-2 cursor-pointer"
                    onClick={() => setExpandedReview(expandedReview === review.id ? null : review.id)}
                  >
                    <FileText size={14} className="mt-0.5 text-pdm-fg-dim flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-pdm-fg truncate">
                          {review.file?.file_name || 'Unknown file'}
                        </span>
                        {getStatusIcon(review.status)}
                      </div>
                      {review.title && (
                        <p className="text-xs text-pdm-fg-dim mt-0.5">{review.title}</p>
                      )}
                      <div className="flex items-center gap-2 mt-1 text-[10px] text-pdm-fg-muted">
                        <span className={`font-medium ${getStatusColor(review.status)}`}>
                          {review.status.charAt(0).toUpperCase() + review.status.slice(1)}
                        </span>
                        <span>•</span>
                        <span>v{review.file_version}</span>
                        <span>•</span>
                        <span>{formatRelativeTime(review.created_at)}</span>
                      </div>
                    </div>
                    <ChevronRight 
                      size={14} 
                      className={`text-pdm-fg-muted transition-transform ${
                        expandedReview === review.id ? 'rotate-90' : ''
                      }`}
                    />
                  </div>
                  
                  {/* Expanded review details */}
                  {expandedReview === review.id && (
                    <div className="mt-3 ml-6 space-y-3">
                      {review.message && (
                        <div className="p-2 bg-pdm-bg-light rounded text-xs text-pdm-fg-dim">
                          {review.message}
                        </div>
                      )}
                      
                      {/* Reviewers */}
                      <div className="space-y-1">
                        <p className="text-[10px] text-pdm-fg-muted uppercase tracking-wide">Reviewers</p>
                        {review.responses?.map(response => (
                          <div 
                            key={response.id}
                            className="flex items-center gap-2 text-xs"
                          >
                            {getStatusIcon(response.status)}
                            <span className="text-pdm-fg-dim">
                              {response.reviewer?.full_name || response.reviewer?.email}
                            </span>
                            {response.responded_at && (
                              <span className="text-[10px] text-pdm-fg-muted">
                                {formatRelativeTime(response.responded_at)}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                      
                      {/* Cancel button for pending reviews */}
                      {review.status === 'pending' && (
                        <button
                          onClick={() => handleCancelReview(review.id)}
                          className="text-xs text-pdm-error hover:text-pdm-error/80 flex items-center gap-1"
                        >
                          <X size={12} />
                          Cancel Review
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  )
}

