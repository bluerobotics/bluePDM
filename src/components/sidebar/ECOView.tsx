// @ts-nocheck - Supabase type inference issues with Database generics
import { useEffect, useState, useMemo } from 'react'
import { 
  ClipboardList, 
  Plus, 
  Search, 
  X, 
  File, 
  ChevronRight, 
  ChevronDown,
  Tag,
  Calendar,
  Check,
  Clock,
  XCircle,
  Loader2
} from 'lucide-react'
import { usePDMStore } from '../../stores/pdmStore'
import { getSupabaseClient } from '../../lib/supabase'
import { formatDistanceToNow } from 'date-fns'

// ECO status types
type ECOStatus = 'open' | 'in_progress' | 'completed' | 'cancelled'

interface ECO {
  id: string
  eco_number: string
  title: string | null
  description: string | null
  status: ECOStatus
  created_at: string
  created_by: string
  file_count?: number
  created_by_name?: string
  created_by_email?: string
}

interface FileECO {
  id: string
  file_id: string
  eco_id: string
  created_at: string
  notes: string | null
  file?: {
    id: string
    file_name: string
    file_path: string
    part_number: string | null
    revision: string
  }
}

const STATUS_CONFIG: Record<ECOStatus, { icon: React.ReactNode; label: string; color: string; bgColor: string }> = {
  open: { 
    icon: <Clock size={12} />, 
    label: 'Open', 
    color: 'text-pdm-accent',
    bgColor: 'bg-pdm-accent/10'
  },
  in_progress: { 
    icon: <Loader2 size={12} className="animate-spin" />, 
    label: 'In Progress', 
    color: 'text-pdm-warning',
    bgColor: 'bg-pdm-warning/10'
  },
  completed: { 
    icon: <Check size={12} />, 
    label: 'Completed', 
    color: 'text-pdm-success',
    bgColor: 'bg-pdm-success/10'
  },
  cancelled: { 
    icon: <XCircle size={12} />, 
    label: 'Cancelled', 
    color: 'text-pdm-fg-muted',
    bgColor: 'bg-pdm-fg-muted/10'
  },
}

export function ECOView() {
  const { 
    organization, 
    user,
    isVaultConnected, 
    files,
    selectedFiles,
    toggleFileSelection,
    addToast
  } = usePDMStore()
  
  const [ecos, setEcos] = useState<ECO[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<ECOStatus | 'all'>('all')
  const [expandedECO, setExpandedECO] = useState<string | null>(null)
  const [ecoFiles, setEcoFiles] = useState<Record<string, FileECO[]>>({})
  const [loadingFiles, setLoadingFiles] = useState<string | null>(null)
  
  // Create ECO modal state
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newEcoNumber, setNewEcoNumber] = useState('')
  const [newEcoTitle, setNewEcoTitle] = useState('')
  const [newEcoDescription, setNewEcoDescription] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  
  // Tag files modal state
  const [showTagModal, setShowTagModal] = useState(false)
  const [tagEcoId, setTagEcoId] = useState<string | null>(null)
  const [isTagging, setIsTagging] = useState(false)

  // Load ECOs
  useEffect(() => {
    const loadECOs = async () => {
      if (!isVaultConnected || !organization) {
        setEcos([])
        return
      }
      
      setIsLoading(true)
      
      try {
        const client = getSupabaseClient()
        
        // Fetch ECOs with file count
        const { data, error } = await client
          .from('ecos')
          .select(`
            id,
            eco_number,
            title,
            description,
            status,
            created_at,
            created_by,
            created_by_user:users!created_by(full_name, email)
          `)
          .eq('org_id', organization.id)
          .order('created_at', { ascending: false })
        
        if (error) {
          console.error('Failed to load ECOs:', error)
          // Don't show error if table doesn't exist yet
          if (!error.message?.includes('ecos')) {
            addToast('error', 'Failed to load ECOs')
          }
          return
        }
        
        // Get file counts for each ECO
        const ecoIds = data?.map(e => e.id) || []
        let fileCounts: Record<string, number> = {}
        
        if (ecoIds.length > 0) {
          const { data: countData } = await client
            .from('file_ecos')
            .select('eco_id')
            .in('eco_id', ecoIds)
          
          if (countData) {
            fileCounts = countData.reduce((acc, item) => {
              acc[item.eco_id] = (acc[item.eco_id] || 0) + 1
              return acc
            }, {} as Record<string, number>)
          }
        }
        
        const ecosWithCounts = (data || []).map(eco => ({
          ...eco,
          file_count: fileCounts[eco.id] || 0,
          created_by_name: (eco.created_by_user as any)?.full_name,
          created_by_email: (eco.created_by_user as any)?.email,
        }))
        
        setEcos(ecosWithCounts)
      } catch (err) {
        console.error('Failed to load ECOs:', err)
      } finally {
        setIsLoading(false)
      }
    }

    loadECOs()
    
    // Refresh every 60 seconds
    const interval = setInterval(loadECOs, 60000)
    return () => clearInterval(interval)
  }, [isVaultConnected, organization])
  
  // Load files for an ECO when expanded
  const loadECOFiles = async (ecoId: string) => {
    if (ecoFiles[ecoId]) return // Already loaded
    
    setLoadingFiles(ecoId)
    
    try {
      const client = getSupabaseClient()
      const { data, error } = await client
        .from('file_ecos')
        .select(`
          id,
          file_id,
          eco_id,
          created_at,
          notes,
          file:files!file_id(
            id,
            file_name,
            file_path,
            part_number,
            revision
          )
        `)
        .eq('eco_id', ecoId)
        .order('created_at', { ascending: false })
      
      if (error) {
        console.error('Failed to load ECO files:', error)
        return
      }
      
      setEcoFiles(prev => ({
        ...prev,
        [ecoId]: data || []
      }))
    } catch (err) {
      console.error('Failed to load ECO files:', err)
    } finally {
      setLoadingFiles(null)
    }
  }
  
  // Filter ECOs based on search and status
  const filteredECOs = useMemo(() => {
    return ecos.filter(eco => {
      // Status filter
      if (statusFilter !== 'all' && eco.status !== statusFilter) {
        return false
      }
      
      // Search filter
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase()
        return (
          eco.eco_number.toLowerCase().includes(query) ||
          eco.title?.toLowerCase().includes(query) ||
          eco.description?.toLowerCase().includes(query)
        )
      }
      
      return true
    })
  }, [ecos, searchQuery, statusFilter])
  
  // Toggle ECO expansion
  const toggleECO = (ecoId: string) => {
    if (expandedECO === ecoId) {
      setExpandedECO(null)
    } else {
      setExpandedECO(ecoId)
      loadECOFiles(ecoId)
    }
  }
  
  // Create new ECO
  const handleCreateECO = async () => {
    if (!newEcoNumber.trim() || !organization || !user) return
    
    setIsCreating(true)
    
    try {
      const client = getSupabaseClient()
      const { data, error } = await client
        .from('ecos')
        .insert({
          org_id: organization.id,
          eco_number: newEcoNumber.trim().toUpperCase(),
          title: newEcoTitle.trim() || null,
          description: newEcoDescription.trim() || null,
          status: 'open',
          created_by: user.id
        })
        .select()
        .single()
      
      if (error) {
        if (error.message?.includes('unique') || error.message?.includes('duplicate')) {
          addToast('error', 'ECO number already exists')
        } else {
          addToast('error', 'Failed to create ECO')
        }
        console.error('Failed to create ECO:', error)
        return
      }
      
      // Add to list
      setEcos(prev => [{
        ...data,
        file_count: 0,
        created_by_name: user.full_name,
        created_by_email: user.email
      }, ...prev])
      
      // Reset form
      setNewEcoNumber('')
      setNewEcoTitle('')
      setNewEcoDescription('')
      setShowCreateModal(false)
      
      addToast('success', `ECO ${data.eco_number} created`)
    } catch (err) {
      console.error('Failed to create ECO:', err)
      addToast('error', 'Failed to create ECO')
    } finally {
      setIsCreating(false)
    }
  }
  
  // Tag selected files with an ECO
  const handleTagFiles = async () => {
    if (!tagEcoId || selectedFiles.length === 0 || !user) return
    
    setIsTagging(true)
    
    try {
      const client = getSupabaseClient()
      
      // Get file IDs for selected paths
      const fileIds: string[] = []
      for (const path of selectedFiles) {
        const file = files.find(f => f.path === path)
        if (file?.pdmData?.id) {
          fileIds.push(file.pdmData.id)
        }
      }
      
      if (fileIds.length === 0) {
        addToast('warning', 'No synced files selected. Only synced files can be tagged.')
        setShowTagModal(false)
        return
      }
      
      // Insert file-ECO associations
      const insertData = fileIds.map(fileId => ({
        file_id: fileId,
        eco_id: tagEcoId,
        created_by: user.id
      }))
      
      const { error } = await client
        .from('file_ecos')
        .upsert(insertData, { onConflict: 'file_id,eco_id' })
      
      if (error) {
        console.error('Failed to tag files:', error)
        addToast('error', 'Failed to tag files with ECO')
        return
      }
      
      // Update file count in local state
      const eco = ecos.find(e => e.id === tagEcoId)
      if (eco) {
        setEcos(prev => prev.map(e => 
          e.id === tagEcoId 
            ? { ...e, file_count: (e.file_count || 0) + fileIds.length }
            : e
        ))
      }
      
      // Clear cached files for this ECO
      setEcoFiles(prev => {
        const { [tagEcoId]: _, ...rest } = prev
        return rest
      })
      
      setShowTagModal(false)
      setTagEcoId(null)
      
      addToast('success', `Tagged ${fileIds.length} file(s) with ECO`)
    } catch (err) {
      console.error('Failed to tag files:', err)
      addToast('error', 'Failed to tag files with ECO')
    } finally {
      setIsTagging(false)
    }
  }
  
  // Remove file from ECO
  const handleRemoveFileFromECO = async (fileEcoId: string, ecoId: string) => {
    try {
      const client = getSupabaseClient()
      const { error } = await client
        .from('file_ecos')
        .delete()
        .eq('id', fileEcoId)
      
      if (error) {
        console.error('Failed to remove file from ECO:', error)
        addToast('error', 'Failed to remove file from ECO')
        return
      }
      
      // Update local state
      setEcoFiles(prev => ({
        ...prev,
        [ecoId]: prev[ecoId]?.filter(fe => fe.id !== fileEcoId) || []
      }))
      
      setEcos(prev => prev.map(e => 
        e.id === ecoId 
          ? { ...e, file_count: Math.max(0, (e.file_count || 0) - 1) }
          : e
      ))
      
      addToast('success', 'File removed from ECO')
    } catch (err) {
      console.error('Failed to remove file from ECO:', err)
    }
  }
  
  // Update ECO status
  const handleUpdateStatus = async (ecoId: string, newStatus: ECOStatus) => {
    if (!user) return
    
    try {
      const client = getSupabaseClient()
      const { error } = await client
        .from('ecos')
        .update({
          status: newStatus,
          updated_at: new Date().toISOString(),
          updated_by: user.id,
          ...(newStatus === 'completed' ? { completed_at: new Date().toISOString() } : {})
        })
        .eq('id', ecoId)
      
      if (error) {
        console.error('Failed to update ECO status:', error)
        addToast('error', 'Failed to update ECO status')
        return
      }
      
      setEcos(prev => prev.map(e => 
        e.id === ecoId ? { ...e, status: newStatus } : e
      ))
      
      addToast('success', `ECO status updated to ${STATUS_CONFIG[newStatus].label}`)
    } catch (err) {
      console.error('Failed to update ECO status:', err)
    }
  }

  if (!isVaultConnected) {
    return (
      <div className="p-4 text-sm text-pdm-fg-muted text-center">
        Open a vault to manage ECOs
      </div>
    )
  }

  if (!organization) {
    return (
      <div className="p-4 text-sm text-pdm-fg-muted text-center">
        Sign in to manage ECOs
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header with search and create button */}
      <div className="p-3 border-b border-pdm-border space-y-3">
        {/* Search bar */}
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-pdm-fg-muted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search ECOs..."
            className="w-full pl-8 pr-8 py-1.5 text-sm"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-pdm-fg-muted hover:text-pdm-fg"
            >
              <X size={14} />
            </button>
          )}
        </div>
        
        {/* Status filter and create button */}
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as ECOStatus | 'all')}
            className="flex-1 text-sm py-1"
          >
            <option value="all">All Status</option>
            <option value="open">Open</option>
            <option value="in_progress">In Progress</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
          
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1 px-2 py-1 text-sm bg-pdm-accent text-white rounded hover:bg-pdm-accent-hover transition-colors"
          >
            <Plus size={14} />
            New ECO
          </button>
        </div>
        
        {/* Tag files button (shown when files are selected) */}
        {selectedFiles.length > 0 && (
          <button
            onClick={() => setShowTagModal(true)}
            className="w-full flex items-center justify-center gap-2 px-3 py-1.5 text-sm bg-pdm-bg-light border border-pdm-border rounded hover:bg-pdm-highlight transition-colors"
          >
            <Tag size={14} />
            Tag {selectedFiles.length} file{selectedFiles.length > 1 ? 's' : ''} with ECO
          </button>
        )}
      </div>
      
      {/* ECO List */}
      <div className="flex-1 overflow-auto">
        {isLoading && ecos.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <div className="spinner" />
          </div>
        ) : filteredECOs.length === 0 ? (
          <div className="p-4 text-sm text-pdm-fg-muted text-center">
            {searchQuery || statusFilter !== 'all' 
              ? 'No ECOs match your filters'
              : 'No ECOs yet. Create one to get started.'}
          </div>
        ) : (
          <div className="p-2 space-y-1">
            {filteredECOs.map((eco) => {
              const statusConfig = STATUS_CONFIG[eco.status]
              const isExpanded = expandedECO === eco.id
              const filesForEco = ecoFiles[eco.id] || []
              const isLoadingEcoFiles = loadingFiles === eco.id
              
              return (
                <div
                  key={eco.id}
                  className="bg-pdm-bg-light rounded border border-pdm-border"
                >
                  {/* ECO Header */}
                  <div
                    onClick={() => toggleECO(eco.id)}
                    className="flex items-start gap-2 p-2 cursor-pointer hover:bg-pdm-highlight transition-colors rounded"
                  >
                    <span className="mt-1 text-pdm-fg-muted">
                      {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </span>
                    
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm text-pdm-fg">
                          {eco.eco_number}
                        </span>
                        <span className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-xs ${statusConfig.color} ${statusConfig.bgColor}`}>
                          {statusConfig.icon}
                          {statusConfig.label}
                        </span>
                      </div>
                      
                      {eco.title && (
                        <div className="text-sm text-pdm-fg-dim truncate mt-0.5">
                          {eco.title}
                        </div>
                      )}
                      
                      <div className="flex items-center gap-3 text-xs text-pdm-fg-muted mt-1">
                        <span className="flex items-center gap-1">
                          <File size={10} />
                          {eco.file_count || 0} files
                        </span>
                        <span className="flex items-center gap-1">
                          <Calendar size={10} />
                          {formatDistanceToNow(new Date(eco.created_at), { addSuffix: true })}
                        </span>
                      </div>
                    </div>
                  </div>
                  
                  {/* Expanded content */}
                  {isExpanded && (
                    <div className="border-t border-pdm-border">
                      {/* Description */}
                      {eco.description && (
                        <div className="p-2 text-xs text-pdm-fg-dim border-b border-pdm-border">
                          {eco.description}
                        </div>
                      )}
                      
                      {/* Status change buttons */}
                      <div className="p-2 border-b border-pdm-border">
                        <div className="text-xs text-pdm-fg-muted mb-1.5">Change Status:</div>
                        <div className="flex flex-wrap gap-1">
                          {(['open', 'in_progress', 'completed', 'cancelled'] as ECOStatus[]).map(status => {
                            const config = STATUS_CONFIG[status]
                            const isActive = eco.status === status
                            return (
                              <button
                                key={status}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  if (!isActive) handleUpdateStatus(eco.id, status)
                                }}
                                disabled={isActive}
                                className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors ${
                                  isActive 
                                    ? `${config.color} ${config.bgColor} cursor-default`
                                    : 'text-pdm-fg-muted hover:text-pdm-fg hover:bg-pdm-highlight'
                                }`}
                              >
                                {config.icon}
                                {config.label}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                      
                      {/* Files list */}
                      <div className="p-2">
                        <div className="text-xs text-pdm-fg-muted mb-1.5">Tagged Files:</div>
                        
                        {isLoadingEcoFiles ? (
                          <div className="flex items-center justify-center py-2">
                            <Loader2 size={14} className="animate-spin text-pdm-fg-muted" />
                          </div>
                        ) : filesForEco.length === 0 ? (
                          <div className="text-xs text-pdm-fg-muted py-2 text-center">
                            No files tagged with this ECO
                          </div>
                        ) : (
                          <div className="space-y-1 max-h-48 overflow-auto">
                            {filesForEco.map(fileEco => (
                              <div
                                key={fileEco.id}
                                className="flex items-center gap-2 p-1.5 rounded bg-pdm-bg hover:bg-pdm-highlight group"
                              >
                                <File size={12} className="text-pdm-fg-muted flex-shrink-0" />
                                <div className="flex-1 min-w-0">
                                  <div className="text-xs truncate">
                                    {(fileEco.file as any)?.file_name || 'Unknown file'}
                                  </div>
                                  {(fileEco.file as any)?.part_number && (
                                    <div className="text-xs text-pdm-fg-muted truncate">
                                      {(fileEco.file as any).part_number}
                                    </div>
                                  )}
                                </div>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleRemoveFileFromECO(fileEco.id, eco.id)
                                  }}
                                  className="p-1 opacity-0 group-hover:opacity-100 text-pdm-fg-muted hover:text-pdm-error transition-opacity"
                                  title="Remove from ECO"
                                >
                                  <X size={12} />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      
      {/* Create ECO Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-pdm-bg border border-pdm-border rounded-lg shadow-xl w-96 max-w-[90vw]">
            <div className="flex items-center justify-between p-3 border-b border-pdm-border">
              <h3 className="font-medium">Create New ECO</h3>
              <button
                onClick={() => setShowCreateModal(false)}
                className="p-1 hover:bg-pdm-highlight rounded"
              >
                <X size={16} />
              </button>
            </div>
            
            <div className="p-4 space-y-3">
              <div>
                <label className="block text-xs text-pdm-fg-muted mb-1">
                  ECO Number *
                </label>
                <input
                  type="text"
                  value={newEcoNumber}
                  onChange={(e) => setNewEcoNumber(e.target.value)}
                  placeholder="e.g., ECO-001"
                  className="w-full"
                  autoFocus
                />
              </div>
              
              <div>
                <label className="block text-xs text-pdm-fg-muted mb-1">
                  Title
                </label>
                <input
                  type="text"
                  value={newEcoTitle}
                  onChange={(e) => setNewEcoTitle(e.target.value)}
                  placeholder="Brief description"
                  className="w-full"
                />
              </div>
              
              <div>
                <label className="block text-xs text-pdm-fg-muted mb-1">
                  Description
                </label>
                <textarea
                  value={newEcoDescription}
                  onChange={(e) => setNewEcoDescription(e.target.value)}
                  placeholder="Detailed description..."
                  className="w-full h-20 resize-none"
                />
              </div>
            </div>
            
            <div className="flex justify-end gap-2 p-3 border-t border-pdm-border">
              <button
                onClick={() => setShowCreateModal(false)}
                className="px-3 py-1.5 text-sm hover:bg-pdm-highlight rounded"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateECO}
                disabled={!newEcoNumber.trim() || isCreating}
                className="px-3 py-1.5 text-sm bg-pdm-accent text-white rounded hover:bg-pdm-accent-hover disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isCreating && <Loader2 size={14} className="animate-spin" />}
                Create ECO
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Tag Files Modal */}
      {showTagModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-pdm-bg border border-pdm-border rounded-lg shadow-xl w-96 max-w-[90vw]">
            <div className="flex items-center justify-between p-3 border-b border-pdm-border">
              <h3 className="font-medium">Tag Files with ECO</h3>
              <button
                onClick={() => {
                  setShowTagModal(false)
                  setTagEcoId(null)
                }}
                className="p-1 hover:bg-pdm-highlight rounded"
              >
                <X size={16} />
              </button>
            </div>
            
            <div className="p-4">
              <div className="text-sm text-pdm-fg-dim mb-3">
                Select an ECO to tag {selectedFiles.length} file{selectedFiles.length > 1 ? 's' : ''}:
              </div>
              
              <div className="space-y-1 max-h-64 overflow-auto">
                {ecos.filter(e => e.status !== 'completed' && e.status !== 'cancelled').map(eco => (
                  <div
                    key={eco.id}
                    onClick={() => setTagEcoId(eco.id)}
                    className={`flex items-center gap-2 p-2 rounded cursor-pointer transition-colors ${
                      tagEcoId === eco.id 
                        ? 'bg-pdm-accent/20 border border-pdm-accent'
                        : 'bg-pdm-bg-light hover:bg-pdm-highlight border border-transparent'
                    }`}
                  >
                    <ClipboardList size={14} className="text-pdm-accent flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">{eco.eco_number}</div>
                      {eco.title && (
                        <div className="text-xs text-pdm-fg-muted truncate">{eco.title}</div>
                      )}
                    </div>
                    {tagEcoId === eco.id && (
                      <Check size={14} className="text-pdm-accent flex-shrink-0" />
                    )}
                  </div>
                ))}
                
                {ecos.filter(e => e.status !== 'completed' && e.status !== 'cancelled').length === 0 && (
                  <div className="text-sm text-pdm-fg-muted text-center py-4">
                    No active ECOs. Create one first.
                  </div>
                )}
              </div>
            </div>
            
            <div className="flex justify-end gap-2 p-3 border-t border-pdm-border">
              <button
                onClick={() => {
                  setShowTagModal(false)
                  setTagEcoId(null)
                }}
                className="px-3 py-1.5 text-sm hover:bg-pdm-highlight rounded"
              >
                Cancel
              </button>
              <button
                onClick={handleTagFiles}
                disabled={!tagEcoId || isTagging}
                className="px-3 py-1.5 text-sm bg-pdm-accent text-white rounded hover:bg-pdm-accent-hover disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isTagging && <Loader2 size={14} className="animate-spin" />}
                Tag Files
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

