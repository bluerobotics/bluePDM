import { 
  FolderTree, 
  ArrowDownUp, 
  History, 
  Search,
  Trash2,
  Terminal,
  ClipboardList,
  GitBranch,
  Bell,
  HardDrive
} from 'lucide-react'
import { useEffect } from 'react'
import { usePDMStore, SidebarView } from '../stores/pdmStore'
import { getUnreadNotificationCount, getPendingReviewsForUser } from '../lib/supabase'

interface ActivityItemProps {
  icon: React.ReactNode
  view: SidebarView
  title: string
  badge?: number
}

function ActivityItem({ icon, view, title, badge }: ActivityItemProps) {
  const { activeView, setActiveView } = usePDMStore()
  const isActive = activeView === view

  return (
    <button
      onClick={() => setActiveView(view)}
      className={`relative w-12 h-12 flex items-center justify-center border-l-2 transition-colors ${
        isActive
          ? 'text-pdm-accent border-pdm-accent bg-pdm-highlight'
          : 'text-pdm-fg-muted border-transparent hover:text-pdm-fg-dim'
      }`}
      title={title}
    >
      {icon}
      {badge && badge > 0 && (
        <span className="absolute top-1.5 right-1.5 min-w-[16px] h-4 px-1 bg-pdm-accent text-white text-[10px] font-medium rounded-full flex items-center justify-center">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  )
}

export function ActivityBar() {
  const { 
    user, 
    organization,
    unreadNotificationCount, 
    pendingReviewCount,
    setUnreadNotificationCount,
    setPendingReviewCount
  } = usePDMStore()
  
  // Load notification counts on mount and periodically
  useEffect(() => {
    if (!user?.id || !organization?.id) return
    
    const loadCounts = async () => {
      try {
        const { count } = await getUnreadNotificationCount(user.id)
        setUnreadNotificationCount(count)
        
        const { reviews } = await getPendingReviewsForUser(user.id, organization.id)
        setPendingReviewCount(reviews.length)
      } catch (err) {
        console.error('Error loading notification counts:', err)
      }
    }
    
    loadCounts()
    
    // Refresh every 60 seconds
    const interval = setInterval(loadCounts, 60000)
    return () => clearInterval(interval)
  }, [user?.id, organization?.id, setUnreadNotificationCount, setPendingReviewCount])
  
  const totalBadge = unreadNotificationCount + pendingReviewCount
  
  return (
    <div className="w-12 bg-pdm-activitybar flex flex-col border-r border-pdm-border flex-shrink-0">
      <div className="flex flex-col">
        <ActivityItem
          icon={<FolderTree size={24} />}
          view="explorer"
          title="Explorer"
        />
        <ActivityItem
          icon={<ArrowDownUp size={24} />}
          view="pending"
          title="Pending"
        />
        <ActivityItem
          icon={<Bell size={24} />}
          view="reviews"
          title="Reviews & Notifications"
          badge={totalBadge}
        />
        <ActivityItem
          icon={<History size={24} />}
          view="history"
          title="History"
        />
        <ActivityItem
          icon={<ClipboardList size={24} />}
          view="eco"
          title="ECO Manager"
        />
        <ActivityItem
          icon={<GitBranch size={24} />}
          view="workflows"
          title="Workflows"
        />
        <ActivityItem
          icon={<Search size={24} />}
          view="search"
          title="Search"
        />
        <ActivityItem
          icon={<Trash2 size={24} />}
          view="trash"
          title="Trash"
        />
        <ActivityItem
          icon={<Terminal size={24} />}
          view="terminal"
          title="Terminal (Ctrl+`)"
        />
        <ActivityItem
          icon={<HardDrive size={24} />}
          view="google-drive"
          title="Google Drive"
        />
      </div>
    </div>
  )
}
