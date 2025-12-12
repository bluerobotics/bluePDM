import { useState, useEffect, useCallback } from 'react'
import { usePDMStore, LocalFile } from '../stores/pdmStore'
import {
  FileBox,
  Layers,
  FilePen,
  File,
  Loader2,
  ChevronRight,
  ChevronDown,
  Settings2,
  RefreshCw,
  AlertCircle,
  Download,
  FileOutput,
  Package,
  Search,
  ArrowUpRight
} from 'lucide-react'

// Types for SolidWorks data
interface BomItem {
  fileName: string
  filePath: string
  fileType: 'Part' | 'Assembly' | 'Other'
  quantity: number
  configuration: string
  partNumber: string
  description: string
  material: string
  revision: string
  properties: Record<string, string>
}

interface Configuration {
  name: string
  isActive: boolean
  description: string
  properties: Record<string, string>
}

interface FileReference {
  path: string
  fileName: string
  exists: boolean
  fileType: string
}

interface SWServiceStatus {
  running: boolean
  version?: string
}

// Hook to manage SolidWorks service connection
export function useSolidWorksService() {
  const [status, setStatus] = useState<SWServiceStatus & { directAccessEnabled?: boolean }>({ running: false })
  const [isStarting, setIsStarting] = useState(false)
  const { addToast, organization } = usePDMStore()
  
  // Get DM license key from organization settings
  const dmLicenseKey = organization?.settings?.solidworks_dm_license_key

  const checkStatus = useCallback(async () => {
    try {
      const result = await window.electronAPI?.solidworks?.getServiceStatus()
      if (result?.success && result.data) {
        setStatus(result.data)
      }
    } catch {
      setStatus({ running: false })
    }
  }, [])

  const startService = useCallback(async () => {
    setIsStarting(true)
    try {
      // Pass the DM license key from org settings to enable direct file access
      const result = await window.electronAPI?.solidworks?.startService(dmLicenseKey || undefined)
      if (result?.success) {
        const directAccessEnabled = (result.data as any)?.fastModeEnabled
        setStatus({ 
          running: true, 
          version: (result.data as any)?.version,
          directAccessEnabled
        })
        const modeMsg = directAccessEnabled 
          ? ' (direct file access)' 
          : ' (using SolidWorks API)'
        addToast('success', `SolidWorks service started${modeMsg}`)
      } else {
        addToast('error', result?.error || 'Failed to start SolidWorks service')
      }
    } catch (err) {
      addToast('error', `Failed to start service: ${err}`)
    } finally {
      setIsStarting(false)
    }
  }, [addToast, dmLicenseKey])

  useEffect(() => {
    checkStatus()
    // Poll status every 5 seconds to catch external service starts
    const interval = setInterval(checkStatus, 5000)
    return () => clearInterval(interval)
  }, [checkStatus])

  return { status, isStarting, startService, checkStatus, dmLicenseKey }
}

// File icon component
function SWFileIcon({ fileType, size = 16 }: { fileType: string; size?: number }) {
  switch (fileType) {
    case 'Part':
      return <FileBox size={size} className="text-pdm-accent" />
    case 'Assembly':
      return <Layers size={size} className="text-amber-400" />
    case 'Drawing':
      return <FilePen size={size} className="text-sky-300" />
    default:
      return <File size={size} className="text-pdm-fg-muted" />
  }
}

// BOM Tree Item component
function BomTreeItem({ 
  item, 
  level = 0,
  onNavigate 
}: { 
  item: BomItem
  level?: number
  onNavigate?: (path: string) => void
}) {
  const [expanded, setExpanded] = useState(level < 2)

  return (
    <div className="select-none">
      <div 
        className="flex items-center gap-2 py-1.5 px-2 hover:bg-pdm-bg-light rounded cursor-pointer group"
        style={{ paddingLeft: `${level * 16 + 8}px` }}
      >
        {item.fileType === 'Assembly' ? (
          <button 
            onClick={() => setExpanded(!expanded)}
            className="p-0.5 hover:bg-pdm-bg rounded"
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="w-5" />
        )}
        
        <SWFileIcon fileType={item.fileType} size={16} />
        
        <span className="flex-1 min-w-0 truncate text-sm">
          {item.fileName}
        </span>
        
        <span className="text-xs text-pdm-fg-muted bg-pdm-bg px-1.5 py-0.5 rounded">
          ×{item.quantity}
        </span>
        
        {item.partNumber && (
          <span className="text-xs text-pdm-accent">{item.partNumber}</span>
        )}
        
        {onNavigate && (
          <button
            onClick={() => onNavigate(item.filePath)}
            className="opacity-0 group-hover:opacity-100 p-1 hover:bg-pdm-accent/20 rounded"
            title="Navigate to file"
          >
            <ArrowUpRight size={12} />
          </button>
        )}
      </div>
      
      {item.configuration && (
        <div 
          className="text-xs text-pdm-fg-muted ml-10 mb-1"
          style={{ paddingLeft: `${level * 16 + 8}px` }}
        >
          Config: {item.configuration}
          {item.description && ` • ${item.description}`}
          {item.material && ` • ${item.material}`}
        </div>
      )}
    </div>
  )
}

// Contains/BOM Tab Component
export function ContainsTab({ file }: { file: LocalFile }) {
  const [isLoading, setIsLoading] = useState(false)
  const [bom, setBom] = useState<BomItem[]>([])
  const [configurations, setConfigurations] = useState<Configuration[]>([])
  const [selectedConfig, setSelectedConfig] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const { status, startService, isStarting } = useSolidWorksService()
  const { addToast, files, setSelectedFiles } = usePDMStore()

  const ext = file.extension?.toLowerCase() || ''
  const isAssembly = ext === '.sldasm'

  // Load configurations
  useEffect(() => {
    if (!status.running || !file.path) return
    
    const loadConfigs = async () => {
      try {
        const result = await window.electronAPI?.solidworks?.getConfigurations(file.path)
        if (result?.success && result.data) {
          setConfigurations(result.data.configurations)
          setSelectedConfig(result.data.activeConfiguration)
        }
      } catch (err) {
        console.error('Failed to load configurations:', err)
      }
    }
    
    loadConfigs()
  }, [status.running, file.path])

  // Load BOM
  const loadBom = useCallback(async () => {
    if (!status.running || !file.path || !isAssembly) return
    
    setIsLoading(true)
    setError(null)
    
    try {
      const result = await window.electronAPI?.solidworks?.getBom(file.path, {
        includeChildren: true,
        configuration: selectedConfig || undefined
      })
      
      if (result?.success && result.data) {
        // Cast fileType to the expected union type
        setBom(result.data.items.map((item: { fileName: string; filePath: string; fileType: string; quantity: number; configuration: string; partNumber: string; description: string; material: string; revision: string; properties: Record<string, string> }) => ({
          ...item,
          fileType: (item.fileType === 'Part' || item.fileType === 'Assembly' ? item.fileType : 'Other') as 'Part' | 'Assembly' | 'Other'
        })))
      } else {
        setError(result?.error || 'Failed to load BOM')
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setIsLoading(false)
    }
  }, [status.running, file.path, selectedConfig, isAssembly])

  useEffect(() => {
    if (selectedConfig) {
      loadBom()
    }
  }, [selectedConfig, loadBom])

  // Navigate to a file in the BOM
  const handleNavigate = (filePath: string) => {
    const targetFile = files.find(f => 
      f.path.toLowerCase() === filePath.toLowerCase() ||
      f.path.toLowerCase().endsWith(filePath.toLowerCase().split('\\').pop() || '')
    )
    if (targetFile) {
      setSelectedFiles([targetFile.relativePath])
    } else {
      addToast('info', 'File not found in vault')
    }
  }

  if (!isAssembly) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-pdm-fg-muted py-8">
        <FileBox size={48} className="mb-4 opacity-30" />
        <div className="text-sm">Select an assembly file to view BOM</div>
        <div className="text-xs mt-1 opacity-70">.sldasm files only</div>
      </div>
    )
  }

  if (!status.running) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-8">
        <Settings2 size={48} className="mb-4 text-pdm-fg-muted opacity-50" />
        <div className="text-sm text-pdm-fg-muted mb-4">SolidWorks service not running</div>
        <button 
          onClick={startService}
          disabled={isStarting}
          className="btn btn-primary gap-2"
        >
          {isStarting ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          Start Service
        </button>
        <div className="text-xs text-pdm-fg-muted mt-4 text-center max-w-xs">
          The service will start SolidWorks in the background to read assembly data.
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Configuration selector */}
      <div className="flex items-center gap-2 mb-3 flex-shrink-0">
        <label className="text-xs text-pdm-fg-muted">Configuration:</label>
        <select
          value={selectedConfig}
          onChange={(e) => setSelectedConfig(e.target.value)}
          className="flex-1 bg-pdm-bg border border-pdm-border rounded px-2 py-1 text-sm"
          disabled={configurations.length === 0}
        >
          {configurations.map(config => (
            <option key={config.name} value={config.name}>
              {config.name} {config.isActive ? '(Active)' : ''}
            </option>
          ))}
        </select>
        <button
          onClick={loadBom}
          disabled={isLoading}
          className="btn btn-sm btn-ghost p-1.5"
          title="Refresh BOM"
        >
          <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* BOM content */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="animate-spin text-pdm-accent" size={24} />
            <span className="ml-2 text-sm text-pdm-fg-muted">Loading BOM...</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center py-8 text-pdm-error">
            <AlertCircle size={32} className="mb-2" />
            <div className="text-sm">{error}</div>
            <button onClick={loadBom} className="btn btn-sm btn-ghost mt-2">
              Retry
            </button>
          </div>
        ) : bom.length === 0 ? (
          <div className="text-sm text-pdm-fg-muted text-center py-8">
            No components found
          </div>
        ) : (
          <div className="space-y-0.5">
            {/* Summary */}
            <div className="text-xs text-pdm-fg-muted mb-2 px-2">
              {bom.length} unique parts • {bom.reduce((sum, b) => sum + b.quantity, 0)} total
            </div>
            
            {/* BOM tree */}
            {bom.map((item, idx) => (
              <BomTreeItem 
                key={`${item.filePath}-${idx}`} 
                item={item} 
                onNavigate={handleNavigate}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// Where Used Tab Component
export function WhereUsedTab({ file }: { file: LocalFile }) {
  const [isLoading, setIsLoading] = useState(false)
  const [usedIn, setUsedIn] = useState<{ fileName: string; filePath: string; fileType: string }[]>([])
  const [error, setError] = useState<string | null>(null)
  const { status, startService, isStarting } = useSolidWorksService()
  const { files, setSelectedFiles, addToast } = usePDMStore()

  const ext = file.extension?.toLowerCase() || ''
  const isSolidWorks = ['.sldprt', '.sldasm'].includes(ext)

  // Scan assemblies to find where this file is used
  const findWhereUsed = useCallback(async () => {
    if (!status.running || !file.path) return
    
    setIsLoading(true)
    setError(null)
    const results: { fileName: string; filePath: string; fileType: string }[] = []
    
    try {
      // Get all assembly files in the vault
      const assemblies = files.filter(f => 
        f.extension?.toLowerCase() === '.sldasm' && !f.isDirectory
      )
      
      // Check each assembly for references to this file
      for (const asm of assemblies) {
        try {
          const result = await window.electronAPI?.solidworks?.getReferences(asm.path)
          if (result?.success && result.data) {
            const refersToFile = result.data.references.some(
              (ref: FileReference) => 
                ref.fileName.toLowerCase() === file.name.toLowerCase() ||
                ref.path.toLowerCase() === file.path.toLowerCase()
            )
            if (refersToFile) {
              results.push({
                fileName: asm.name,
                filePath: asm.path,
                fileType: 'Assembly'
              })
            }
          }
        } catch {
          // Skip assemblies that fail to load
        }
      }
      
      setUsedIn(results)
    } catch (err) {
      setError(String(err))
    } finally {
      setIsLoading(false)
    }
  }, [status.running, file.path, file.name, files])

  useEffect(() => {
    if (status.running && isSolidWorks) {
      findWhereUsed()
    }
  }, [status.running, isSolidWorks, findWhereUsed])

  const handleNavigate = (filePath: string) => {
    const targetFile = files.find(f => f.path.toLowerCase() === filePath.toLowerCase())
    if (targetFile) {
      setSelectedFiles([targetFile.relativePath])
    } else {
      addToast('info', 'File not found in vault')
    }
  }

  if (!isSolidWorks) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-pdm-fg-muted py-8">
        <Search size={48} className="mb-4 opacity-30" />
        <div className="text-sm">Select a SolidWorks file</div>
        <div className="text-xs mt-1 opacity-70">.sldprt or .sldasm files only</div>
      </div>
    )
  }

  if (!status.running) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-8">
        <Settings2 size={48} className="mb-4 text-pdm-fg-muted opacity-50" />
        <div className="text-sm text-pdm-fg-muted mb-4">SolidWorks service not running</div>
        <button 
          onClick={startService}
          disabled={isStarting}
          className="btn btn-primary gap-2"
        >
          {isStarting ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          Start Service
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-3 flex-shrink-0">
        <span className="text-xs text-pdm-fg-muted">
          Assemblies using: <span className="text-pdm-fg">{file.name}</span>
        </span>
        <button
          onClick={findWhereUsed}
          disabled={isLoading}
          className="btn btn-sm btn-ghost p-1.5"
          title="Refresh"
        >
          <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="animate-spin text-pdm-accent" size={24} />
            <span className="ml-2 text-sm text-pdm-fg-muted">Scanning assemblies...</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center py-8 text-pdm-error">
            <AlertCircle size={32} className="mb-2" />
            <div className="text-sm">{error}</div>
          </div>
        ) : usedIn.length === 0 ? (
          <div className="text-sm text-pdm-fg-muted text-center py-8">
            Not used in any assemblies
          </div>
        ) : (
          <div className="space-y-1">
            {usedIn.map((asm, idx) => (
              <div 
                key={`${asm.filePath}-${idx}`}
                className="flex items-center gap-2 py-1.5 px-2 hover:bg-pdm-bg-light rounded cursor-pointer group"
                onClick={() => handleNavigate(asm.filePath)}
              >
                <SWFileIcon fileType={asm.fileType} size={16} />
                <span className="flex-1 text-sm truncate">{asm.fileName}</span>
                <ArrowUpRight size={12} className="opacity-0 group-hover:opacity-100 text-pdm-fg-muted" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// Standard SolidWorks custom property definitions
// These are the most commonly used properties in engineering workflows
const STANDARD_SW_PROPERTIES = {
  // Document summary info
  file: [
    { key: 'Title', label: 'Title', category: 'summary' },
    { key: 'Subject', label: 'Subject', category: 'summary' },
    { key: 'Author', label: 'Author', category: 'summary' },
    { key: 'Keywords', label: 'Keywords', category: 'summary' },
    { key: 'Comments', label: 'Comments', category: 'summary' },
  ],
  // Standard engineering custom properties
  custom: [
    { key: 'PartNumber', label: 'Part Number', category: 'identification', aliases: ['PartNo', 'Part Number', 'P/N', 'Item Number'] },
    { key: 'Description', label: 'Description', category: 'identification', aliases: ['Desc', 'DESCRIPTION'] },
    { key: 'Revision', label: 'Revision', category: 'identification', aliases: ['Rev', 'REV', 'REVISION'] },
    { key: 'Material', label: 'Material', category: 'physical', aliases: ['MATERIAL', 'Mat', 'MaterialSpec'] },
    { key: 'Weight', label: 'Weight', category: 'physical', aliases: ['Mass', 'WEIGHT', 'SW-Mass'] },
    { key: 'Finish', label: 'Finish', category: 'physical', aliases: ['Surface Finish', 'SurfaceFinish', 'FINISH'] },
    { key: 'Vendor', label: 'Vendor', category: 'procurement', aliases: ['VENDOR', 'Supplier', 'Manufacturer'] },
    { key: 'Cost', label: 'Cost', category: 'procurement', aliases: ['COST', 'Price', 'UnitCost'] },
    { key: 'DrawnBy', label: 'Drawn By', category: 'approval', aliases: ['Drawn By', 'DRAWNBY', 'Designer'] },
    { key: 'CheckedBy', label: 'Checked By', category: 'approval', aliases: ['Checked By', 'CHECKEDBY', 'Checker'] },
    { key: 'ApprovedBy', label: 'Approved By', category: 'approval', aliases: ['Approved By', 'APPROVEDBY', 'Approver'] },
    { key: 'DrawingNumber', label: 'Drawing Number', category: 'documentation', aliases: ['Drawing No', 'DwgNo', 'DRAWINGNO'] },
    { key: 'Project', label: 'Project', category: 'documentation', aliases: ['PROJECT', 'ProjectName', 'Job'] },
    { key: 'Status', label: 'Status', category: 'workflow', aliases: ['STATUS', 'State', 'DocStatus'] },
    { key: 'DateCreated', label: 'Date Created', category: 'dates', aliases: ['Created', 'CreationDate'] },
    { key: 'DateModified', label: 'Date Modified', category: 'dates', aliases: ['Modified', 'LastModified'] },
  ]
}

// Property category colors
const CATEGORY_COLORS: Record<string, string> = {
  summary: 'text-sky-400',
  identification: 'text-pdm-accent',
  physical: 'text-amber-400',
  procurement: 'text-emerald-400',
  approval: 'text-violet-400',
  documentation: 'text-blue-400',
  workflow: 'text-rose-400',
  dates: 'text-pdm-fg-muted',
}

// Mock Datacard Component - shows placeholder UI when service isn't running
function SWDatacardMock({ file, onStartService, isStarting }: { 
  file: LocalFile
  onStartService?: () => void
  isStarting?: boolean 
}) {
  const [selectedConfigIndex, setSelectedConfigIndex] = useState(0)
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(['identification', 'physical']))
  const { organization } = usePDMStore()
  
  const ext = file.extension?.toLowerCase() || ''
  const fileType = ext === '.sldprt' ? 'Part' : ext === '.sldasm' ? 'Assembly' : 'Drawing'
  
  // Mock configurations for demonstration
  const mockConfigurations = ext === '.sldprt' || ext === '.sldasm' 
    ? ['Default', 'Machined', 'As-Cast'] 
    : ['Sheet1']
  
  const hasApiKey = !!organization?.settings?.solidworks_dm_license_key
  
  const toggleCategory = (category: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev)
      if (next.has(category)) {
        next.delete(category)
      } else {
        next.add(category)
      }
      return next
    })
  }
  
  // Group properties by category
  const groupedProperties = STANDARD_SW_PROPERTIES.custom.reduce((acc, prop) => {
    if (!acc[prop.category]) {
      acc[prop.category] = []
    }
    acc[prop.category].push(prop)
    return acc
  }, {} as Record<string, typeof STANDARD_SW_PROPERTIES.custom>)
  
  const categoryLabels: Record<string, string> = {
    identification: 'Identification',
    physical: 'Physical Properties',
    procurement: 'Procurement',
    approval: 'Approval',
    documentation: 'Documentation',
    workflow: 'Workflow',
    dates: 'Dates',
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header with file type indicator */}
      <div className="flex items-center justify-between mb-3 flex-shrink-0">
        <div className="flex items-center gap-2">
          <SWFileIcon fileType={fileType} size={18} />
          <span className="text-sm font-medium text-pdm-fg">{fileType} Properties</span>
        </div>
        {!hasApiKey && (
          <span className="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-400">
            Preview Mode
          </span>
        )}
      </div>
      
      {/* API Key Notice */}
      {!hasApiKey && (
        <div className="mb-3 p-2 rounded bg-pdm-bg border border-pdm-border/50 flex-shrink-0">
          <div className="flex items-start gap-2 text-xs">
            <AlertCircle size={14} className="text-amber-400 mt-0.5 flex-shrink-0" />
            <div className="text-pdm-fg-muted">
              <span className="text-pdm-fg">No DM License Key configured.</span>{' '}
              Properties will be populated when a key is added in Settings → SolidWorks.
            </div>
          </div>
        </div>
      )}
      
      {/* Configuration selector (for parts/assemblies) */}
      {(ext === '.sldprt' || ext === '.sldasm') && (
        <div className="flex items-center gap-2 mb-3 flex-shrink-0">
          <label className="text-xs text-pdm-fg-muted">Configuration:</label>
          <select
            value={selectedConfigIndex}
            onChange={(e) => setSelectedConfigIndex(Number(e.target.value))}
            className="flex-1 bg-pdm-bg border border-pdm-border rounded px-2 py-1.5 text-sm text-pdm-fg"
          >
            {mockConfigurations.map((config, idx) => (
              <option key={config} value={idx}>
                {config} {idx === 0 ? '(Active)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}
      
      {/* Properties Grid - Scrollable */}
      <div className="flex-1 overflow-auto space-y-2">
        {/* File Summary Properties */}
        <div className="border border-pdm-border rounded overflow-hidden">
          <button
            onClick={() => toggleCategory('summary')}
            className="w-full flex items-center gap-2 px-3 py-2 bg-pdm-bg-light hover:bg-pdm-bg-lighter transition-colors"
          >
            {expandedCategories.has('summary') ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className={`text-xs font-medium ${CATEGORY_COLORS.summary}`}>Document Summary</span>
            <span className="text-xs text-pdm-fg-muted ml-auto">{STANDARD_SW_PROPERTIES.file.length}</span>
          </button>
          {expandedCategories.has('summary') && (
            <div className="p-2 space-y-1.5 bg-pdm-bg/50">
              {STANDARD_SW_PROPERTIES.file.map(prop => (
                <div key={prop.key} className="flex items-center gap-2 text-xs group">
                  <span className="text-pdm-fg-muted w-24 truncate" title={prop.key}>{prop.label}:</span>
                  <span className="flex-1 text-pdm-fg-dim italic">—</span>
                </div>
              ))}
            </div>
          )}
        </div>
        
        {/* Custom Properties by Category */}
        {Object.entries(groupedProperties).map(([category, props]) => (
          <div key={category} className="border border-pdm-border rounded overflow-hidden">
            <button
              onClick={() => toggleCategory(category)}
              className="w-full flex items-center gap-2 px-3 py-2 bg-pdm-bg-light hover:bg-pdm-bg-lighter transition-colors"
            >
              {expandedCategories.has(category) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span className={`text-xs font-medium ${CATEGORY_COLORS[category] || 'text-pdm-fg'}`}>
                {categoryLabels[category] || category}
              </span>
              <span className="text-xs text-pdm-fg-muted ml-auto">{props.length}</span>
            </button>
            {expandedCategories.has(category) && (
              <div className="p-2 space-y-1.5 bg-pdm-bg/50">
                {props.map(prop => (
                  <div key={prop.key} className="flex items-center gap-2 text-xs group">
                    <span className="text-pdm-fg-muted w-28 truncate" title={prop.aliases?.join(', ') || prop.key}>
                      {prop.label}:
                    </span>
                    <span className="flex-1 text-pdm-fg-dim italic">—</span>
                    {prop.aliases && prop.aliases.length > 0 && (
                      <span className="opacity-0 group-hover:opacity-100 text-pdm-fg-muted transition-opacity" title={`Aliases: ${prop.aliases.join(', ')}`}>
                        <Info size={10} />
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        
        {/* Mass Properties (computed) */}
        {(ext === '.sldprt' || ext === '.sldasm') && (
          <div className="border border-pdm-border rounded overflow-hidden">
            <button
              onClick={() => toggleCategory('mass')}
              className="w-full flex items-center gap-2 px-3 py-2 bg-pdm-bg-light hover:bg-pdm-bg-lighter transition-colors"
            >
              {expandedCategories.has('mass') ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span className="text-xs font-medium text-orange-400">Mass Properties (Computed)</span>
              <span className="text-xs text-pdm-fg-muted ml-auto">6</span>
            </button>
            {expandedCategories.has('mass') && (
              <div className="p-2 space-y-1.5 bg-pdm-bg/50">
                {['Mass', 'Volume', 'Surface Area', 'Center of Mass X', 'Center of Mass Y', 'Center of Mass Z'].map(prop => (
                  <div key={prop} className="flex items-center gap-2 text-xs">
                    <span className="text-pdm-fg-muted w-28 truncate">{prop}:</span>
                    <span className="flex-1 text-pdm-fg-dim italic">—</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      
      {/* Start Service Button */}
      {onStartService && (
        <div className="mt-3 pt-3 border-t border-pdm-border flex-shrink-0">
          <button
            onClick={onStartService}
            disabled={isStarting}
            className="btn btn-primary gap-2 w-full"
          >
            {isStarting ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {hasApiKey ? 'Load Properties' : 'Start SolidWorks Service'}
          </button>
          <div className="text-xs text-pdm-fg-muted text-center mt-2">
            {hasApiKey 
              ? 'Uses Document Manager API for fast reading'
              : 'Will launch SolidWorks in background'
            }
          </div>
        </div>
      )}
    </div>
  )
}

// Info icon for property tooltips
function Info({ size = 16 }: { size?: number }) {
  return (
    <svg 
      width={size} 
      height={size} 
      viewBox="0 0 24 24" 
      fill="none" 
      stroke="currentColor" 
      strokeWidth="2" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  )
}

// Configuration-aware Properties Component
export function SWPropertiesPanel({ file }: { file: LocalFile }) {
  const [configurations, setConfigurations] = useState<Configuration[]>([])
  const [selectedConfig, setSelectedConfig] = useState<string>('')
  const [fileProperties, setFileProperties] = useState<Record<string, string>>({})
  const [configProperties, setConfigProperties] = useState<Record<string, string>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [showMockDatacard, setShowMockDatacard] = useState(false)
  const { status, startService, isStarting } = useSolidWorksService()

  const ext = file.extension?.toLowerCase() || ''
  const isSolidWorks = ['.sldprt', '.sldasm', '.slddrw'].includes(ext)

  // Load properties
  useEffect(() => {
    if (!status.running || !file.path || !isSolidWorks) return
    
    const loadProperties = async () => {
      setIsLoading(true)
      setShowMockDatacard(false)
      try {
        const result = await window.electronAPI?.solidworks?.getProperties(file.path)
        if (result?.success && result.data) {
          setFileProperties(result.data.fileProperties)
          
          // Get configuration data
          const configResult = await window.electronAPI?.solidworks?.getConfigurations(file.path)
          if (configResult?.success && configResult.data) {
            const configData = configResult.data
            setConfigurations(configData.configurations)
            setSelectedConfig(configData.activeConfiguration)
            
            // Set config-specific properties for active config
            const activeConfig = configData.configurations.find(
              (c: Configuration) => c.name === configData.activeConfiguration
            )
            if (activeConfig) {
              setConfigProperties(activeConfig.properties)
            }
          }
        }
      } catch (err) {
        console.error('Failed to load properties:', err)
      } finally {
        setIsLoading(false)
      }
    }
    
    loadProperties()
  }, [status.running, file.path, isSolidWorks])

  // Update config properties when selection changes
  useEffect(() => {
    const config = configurations.find(c => c.name === selectedConfig)
    if (config) {
      setConfigProperties(config.properties)
    }
  }, [selectedConfig, configurations])

  if (!isSolidWorks) {
    return null // Don't show SW properties for non-SW files
  }

  // Show mock datacard when service isn't running
  if (!status.running || showMockDatacard) {
    return (
      <div className="mt-4 p-3 bg-pdm-bg rounded border border-pdm-border">
        <SWDatacardMock 
          file={file} 
          onStartService={startService}
          isStarting={isStarting}
        />
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="mt-4 p-3 bg-pdm-bg rounded border border-pdm-border">
        <div className="flex items-center gap-2 text-sm text-pdm-fg-muted">
          <Loader2 size={14} className="animate-spin" />
          Loading SolidWorks properties...
        </div>
      </div>
    )
  }

  const allProperties = { ...fileProperties, ...configProperties }
  const propertyEntries = Object.entries(allProperties).filter(([key]) => key && key.trim())

  if (propertyEntries.length === 0) {
    return null
  }

  return (
    <div className="mt-4 p-3 bg-pdm-bg rounded border border-pdm-border">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-pdm-fg-muted">SolidWorks Properties</div>
        {configurations.length > 1 && (
          <select
            value={selectedConfig}
            onChange={(e) => setSelectedConfig(e.target.value)}
            className="text-xs bg-pdm-panel border border-pdm-border rounded px-1 py-0.5"
          >
            {configurations.map(config => (
              <option key={config.name} value={config.name}>
                {config.name}
              </option>
            ))}
          </select>
        )}
      </div>
      
      <div className="space-y-1.5">
        {propertyEntries.slice(0, 10).map(([key, value]) => (
          <div key={key} className="flex gap-2 text-xs">
            <span className="text-pdm-fg-muted truncate" style={{ minWidth: '80px' }}>{key}:</span>
            <span className="text-pdm-fg truncate flex-1">{value || '-'}</span>
          </div>
        ))}
        {propertyEntries.length > 10 && (
          <div className="text-xs text-pdm-fg-muted">
            +{propertyEntries.length - 10} more properties
          </div>
        )}
      </div>
    </div>
  )
}

// Export mode options
type ExportConfigMode = 'current' | 'all' | 'selected'

// Compact Property Row for the grid layout
function CompactProp({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-baseline gap-1.5 min-w-0">
      <span className="text-[10px] text-pdm-fg-muted uppercase tracking-wide flex-shrink-0">{label}</span>
      <span className="text-xs text-pdm-fg truncate">{value || '—'}</span>
    </div>
  )
}

// Full SolidWorks Properties Tab Component for Details Panel
// This replaces the standard Properties tab when a SW file is selected
export function SWPropertiesTab({ file }: { file: LocalFile }) {
  const [configurations, setConfigurations] = useState<Configuration[]>([])
  const [selectedConfig, setSelectedConfig] = useState<string>('')
  const [selectedConfigsForExport, setSelectedConfigsForExport] = useState<Set<string>>(new Set())
  const [fileProperties, setFileProperties] = useState<Record<string, string>>({})
  const [configProperties, setConfigProperties] = useState<Record<string, string>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [showAllProps, setShowAllProps] = useState(false)
  const [exportConfigMode, setExportConfigMode] = useState<ExportConfigMode>('current')
  const [isExporting, setIsExporting] = useState<string | null>(null)
  const [showExportOptions, setShowExportOptions] = useState(false)
  const { status, startService, isStarting } = useSolidWorksService()
  const { addToast } = usePDMStore()

  const ext = file.extension?.toLowerCase() || ''
  const isSolidWorks = ['.sldprt', '.sldasm', '.slddrw'].includes(ext)
  const fileType = ext === '.sldprt' ? 'Part' : ext === '.sldasm' ? 'Assembly' : 'Drawing'
  const isPartOrAsm = ['.sldprt', '.sldasm'].includes(ext)
  const isDrawing = ext === '.slddrw'

  // Load properties when service is running
  useEffect(() => {
    console.log('[SWPropertiesTab] Effect triggered:', { running: status.running, path: file.path, isSolidWorks })
    if (!status.running || !file.path || !isSolidWorks) return
    
    const loadProperties = async () => {
      setIsLoading(true)
      console.log('[SWPropertiesTab] Loading properties for:', file.path)
      try {
        const result = await window.electronAPI?.solidworks?.getProperties(file.path)
        console.log('[SWPropertiesTab] getProperties result:', result)
        console.log('[SWPropertiesTab] result.data keys:', result?.data ? Object.keys(result.data) : 'no data')
        console.log('[SWPropertiesTab] result.data full:', JSON.stringify(result?.data, null, 2))
        
        if (result?.success && result.data) {
          // Handle different possible response formats
          const data = result.data as Record<string, unknown>
          const props = data.fileProperties || data.customProperties || data.properties || result.data
          console.log('[SWPropertiesTab] Extracted properties:', props)
          if (typeof props === 'object' && props !== null) {
            setFileProperties(props as Record<string, string>)
          }
          
          const configResult = await window.electronAPI?.solidworks?.getConfigurations(file.path)
          console.log('[SWPropertiesTab] getConfigurations result:', configResult)
          console.log('[SWPropertiesTab] configResult.data keys:', configResult?.data ? Object.keys(configResult.data) : 'no data')
          console.log('[SWPropertiesTab] configResult.data full:', JSON.stringify(configResult?.data, null, 2))
          
          if (configResult?.success && configResult.data) {
            const configs = configResult.data.configurations || configResult.data
            if (Array.isArray(configs)) {
              setConfigurations(configs)
              const activeConfigName = configResult.data.activeConfiguration || configs[0]?.name
              setSelectedConfig(activeConfigName)
              
              const activeConfig = configs.find(
                (c: Configuration) => c.name === activeConfigName
              )
              if (activeConfig?.properties) {
                setConfigProperties(activeConfig.properties)
              }
            }
          }
        } else if (result?.error) {
          console.error('[SWPropertiesTab] API error:', result.error)
        }
      } catch (err) {
        console.error('[SWPropertiesTab] Failed to load properties:', err)
      } finally {
        setIsLoading(false)
      }
    }
    
    loadProperties()
  }, [status.running, file.path, isSolidWorks])

  // Update config properties when selection changes
  useEffect(() => {
    const config = configurations.find(c => c.name === selectedConfig)
    if (config) {
      setConfigProperties(config.properties)
    }
  }, [selectedConfig, configurations])

  const toggleConfigForExport = (configName: string) => {
    setSelectedConfigsForExport(prev => {
      const next = new Set(prev)
      if (next.has(configName)) {
        next.delete(configName)
      } else {
        next.add(configName)
      }
      return next
    })
  }

  // Handle export
  const handleExport = async (format: 'step' | 'iges' | 'stl' | 'pdf' | 'dxf') => {
    if (!status.running) {
      addToast('error', 'Start SolidWorks service to export')
      return
    }

    setIsExporting(format)
    try {
      let result
      const exportAllConfigs = exportConfigMode === 'all'
      const configsToExport = exportConfigMode === 'selected' 
        ? Array.from(selectedConfigsForExport) 
        : exportConfigMode === 'current' 
          ? [selectedConfig] 
          : undefined

      switch (format) {
        case 'pdf':
          result = await window.electronAPI?.solidworks?.exportPdf(file.path)
          break
        case 'step':
          result = await window.electronAPI?.solidworks?.exportStep(file.path, { 
            exportAllConfigs,
            configurations: configsToExport
          })
          break
        case 'iges':
          result = await window.electronAPI?.solidworks?.exportIges(file.path, {
            exportAllConfigs,
            configurations: configsToExport
          })
          break
        case 'stl':
          result = await window.electronAPI?.solidworks?.exportStl?.(file.path, {
            exportAllConfigs,
            configurations: configsToExport
          })
          break
        case 'dxf':
          result = await window.electronAPI?.solidworks?.exportDxf(file.path)
          break
      }

      if (result?.success) {
        const configLabel = exportConfigMode === 'all' 
          ? ' (all configs)' 
          : exportConfigMode === 'selected' 
            ? ` (${selectedConfigsForExport.size} configs)`
            : ''
        addToast('success', `Exported to ${format.toUpperCase()}${configLabel}`)
      } else {
        addToast('error', result?.error || `Failed to export ${format.toUpperCase()}`)
      }
    } catch (err) {
      addToast('error', `Export failed: ${err}`)
    } finally {
      setIsExporting(null)
    }
  }

  if (!isSolidWorks) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-pdm-fg-muted py-8">
        <FileBox size={32} className="mb-3 opacity-30" />
        <div className="text-xs">Select a SolidWorks file</div>
      </div>
    )
  }

  // Match properties to loaded data
  const getPropertyValue = (key: string, aliases?: string[]): string | null => {
    const allProps = { ...fileProperties, ...configProperties }
    if (allProps[key]) return allProps[key]
    if (aliases) {
      for (const alias of aliases) {
        if (allProps[alias]) return allProps[alias]
        const found = Object.entries(allProps).find(([k]) => k.toLowerCase() === alias.toLowerCase())
        if (found) return found[1]
      }
    }
    return null
  }

  const hasData = status.running && Object.keys({ ...fileProperties, ...configProperties }).length > 0
  const mockConfigs = ['Default', 'Machined', 'As-Cast']
  const displayConfigs = hasData && configurations.length > 0 ? configurations : mockConfigs.map(name => ({ name, isActive: name === 'Default', description: '', properties: {} }))

  // Key properties to always show at top
  const keyProps = [
    { key: 'PartNumber', label: 'P/N', aliases: ['PartNo', 'Part Number', 'Item Number'] },
    { key: 'Description', label: 'Desc', aliases: ['DESCRIPTION'] },
    { key: 'Revision', label: 'Rev', aliases: ['REV'] },
    { key: 'Material', label: 'Mat', aliases: ['MATERIAL'] },
  ]

  // All properties for expanded view
  const allProps = { ...fileProperties, ...configProperties }
  const allPropEntries = Object.entries(allProps).filter(([k]) => k && k.trim())

  return (
    <div className="flex h-full gap-3">
      {/* Left Column - Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Compact Header */}
        <div className="flex items-center gap-2 mb-2 flex-shrink-0">
          <SWFileIcon fileType={fileType} size={20} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-pdm-fg truncate">{file.name}</div>
          </div>
          {hasData ? (
            <span className="w-2 h-2 rounded-full bg-pdm-success flex-shrink-0" title="Connected" />
          ) : (
            <span className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" title="Preview mode" />
          )}
        </div>

        {/* Key Properties Grid - Always visible */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 p-2 rounded bg-pdm-bg/50 border border-pdm-border/50 mb-2 flex-shrink-0">
          {keyProps.map(prop => (
            <CompactProp 
              key={prop.key}
              label={prop.label}
              value={hasData ? getPropertyValue(prop.key, prop.aliases) : null}
            />
          ))}
        </div>

        {/* Configuration selector - compact */}
        {isPartOrAsm && (
          <div className="flex items-center gap-2 mb-2 flex-shrink-0">
            <span className="text-[10px] text-pdm-fg-muted uppercase tracking-wide">Config</span>
            <select
              value={selectedConfig || displayConfigs[0]?.name || ''}
              onChange={(e) => setSelectedConfig(e.target.value)}
              className="flex-1 bg-pdm-bg border border-pdm-border rounded px-1.5 py-1 text-xs text-pdm-fg"
            >
              {displayConfigs.map(config => (
                <option key={typeof config === 'string' ? config : config.name} value={typeof config === 'string' ? config : config.name}>
                  {typeof config === 'string' ? config : config.name}
                </option>
              ))}
            </select>
            {status.running && (
              <button
                onClick={() => {}}
                disabled={isLoading}
                className="p-1 rounded hover:bg-pdm-bg-light"
                title="Refresh"
              >
                <RefreshCw size={12} className={isLoading ? 'animate-spin text-pdm-accent' : 'text-pdm-fg-muted'} />
              </button>
            )}
          </div>
        )}

        {/* Service status - minimal */}
        {!status.running && (
          <button
            onClick={startService}
            disabled={isStarting}
            className="flex items-center justify-center gap-1.5 p-2 mb-2 rounded bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs hover:bg-amber-500/20 transition-colors flex-shrink-0"
          >
            {isStarting ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Start SW Service
          </button>
        )}

        {isLoading && (
          <div className="flex items-center gap-2 p-2 mb-2 rounded bg-pdm-bg border border-pdm-border flex-shrink-0">
            <Loader2 size={12} className="animate-spin text-pdm-accent" />
            <span className="text-xs text-pdm-fg-muted">Loading...</span>
          </div>
        )}

        {/* All Properties - Scrollable list */}
        <div className="flex-1 overflow-auto min-h-0">
          <button
            onClick={() => setShowAllProps(!showAllProps)}
            className="flex items-center gap-1 text-[10px] text-pdm-fg-muted uppercase tracking-wide mb-1 hover:text-pdm-fg-dim"
          >
            {showAllProps ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            All Properties ({allPropEntries.length || '—'})
          </button>
          
          {showAllProps && (
            <div className="space-y-0.5 pl-2 border-l border-pdm-border/30">
              {allPropEntries.length > 0 ? (
                allPropEntries.map(([key, value]) => (
                  <div key={key} className="flex items-baseline gap-1.5 text-xs py-0.5">
                    <span className="text-pdm-fg-muted truncate w-24 flex-shrink-0">{key}</span>
                    <span className="text-pdm-fg truncate">{value || '—'}</span>
                  </div>
                ))
              ) : (
                <div className="text-xs text-pdm-fg-dim italic py-1">No properties loaded</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Right Column - Export */}
      <div className="w-24 flex flex-col flex-shrink-0 border-l border-pdm-border/30 pl-3">
        <span className="text-[10px] text-pdm-fg-muted uppercase tracking-wide mb-2">Export</span>
        
        {/* Export buttons - vertical stack */}
        <div className="flex flex-col gap-1.5">
          {isPartOrAsm && (
            <>
              <button
                onClick={() => handleExport('step')}
                disabled={!!isExporting || !status.running}
                className="flex items-center justify-center gap-1 px-2 py-1.5 rounded text-xs bg-pdm-bg border border-pdm-border hover:bg-pdm-bg-light hover:border-pdm-border-light disabled:opacity-40 transition-colors"
              >
                {isExporting === 'step' ? <Loader2 size={10} className="animate-spin" /> : <Package size={10} />}
                STEP
              </button>
              <button
                onClick={() => handleExport('iges')}
                disabled={!!isExporting || !status.running}
                className="flex items-center justify-center gap-1 px-2 py-1.5 rounded text-xs bg-pdm-bg border border-pdm-border hover:bg-pdm-bg-light hover:border-pdm-border-light disabled:opacity-40 transition-colors"
              >
                {isExporting === 'iges' ? <Loader2 size={10} className="animate-spin" /> : <Package size={10} />}
                IGES
              </button>
              <button
                onClick={() => handleExport('stl')}
                disabled={!!isExporting || !status.running}
                className="flex items-center justify-center gap-1 px-2 py-1.5 rounded text-xs bg-pdm-bg border border-pdm-border hover:bg-pdm-bg-light hover:border-pdm-border-light disabled:opacity-40 transition-colors"
              >
                {isExporting === 'stl' ? <Loader2 size={10} className="animate-spin" /> : <Package size={10} />}
                STL
              </button>
            </>
          )}
          {isDrawing && (
            <>
              <button
                onClick={() => handleExport('pdf')}
                disabled={!!isExporting || !status.running}
                className="flex items-center justify-center gap-1 px-2 py-1.5 rounded text-xs bg-pdm-bg border border-pdm-border hover:bg-pdm-bg-light hover:border-pdm-border-light disabled:opacity-40 transition-colors"
              >
                {isExporting === 'pdf' ? <Loader2 size={10} className="animate-spin" /> : <FileOutput size={10} />}
                PDF
              </button>
              <button
                onClick={() => handleExport('dxf')}
                disabled={!!isExporting || !status.running}
                className="flex items-center justify-center gap-1 px-2 py-1.5 rounded text-xs bg-pdm-bg border border-pdm-border hover:bg-pdm-bg-light hover:border-pdm-border-light disabled:opacity-40 transition-colors"
              >
                {isExporting === 'dxf' ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}
                DXF
              </button>
            </>
          )}
        </div>

        {/* Config mode selector - compact */}
        {isPartOrAsm && displayConfigs.length > 1 && (
          <div className="mt-3 pt-2 border-t border-pdm-border/30">
            <button
              onClick={() => setShowExportOptions(!showExportOptions)}
              className="text-[10px] text-pdm-fg-muted flex items-center gap-0.5 hover:text-pdm-fg-dim"
            >
              {showExportOptions ? <ChevronDown size={8} /> : <ChevronRight size={8} />}
              Configs
            </button>
            
            {showExportOptions && (
              <div className="mt-1 space-y-1">
                {['current', 'all', 'selected'].map(mode => (
                  <button
                    key={mode}
                    onClick={() => setExportConfigMode(mode as ExportConfigMode)}
                    className={`w-full text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                      exportConfigMode === mode 
                        ? 'bg-pdm-accent/20 text-pdm-accent' 
                        : 'text-pdm-fg-muted hover:bg-pdm-bg-light'
                    }`}
                  >
                    {mode === 'current' ? 'Current' : mode === 'all' ? `All (${displayConfigs.length})` : `Pick...`}
                  </button>
                ))}
                
                {exportConfigMode === 'selected' && (
                  <div className="space-y-0.5 mt-1 max-h-20 overflow-auto">
                    {displayConfigs.map(config => {
                      const name = typeof config === 'string' ? config : config.name
                      return (
                        <label key={name} className="flex items-center gap-1 text-[10px] cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedConfigsForExport.has(name)}
                            onChange={() => toggleConfigForExport(name)}
                            className="w-3 h-3"
                          />
                          <span className="truncate">{name}</span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// Keep old name for backwards compatibility
export const SWDatacardTab = SWPropertiesTab

// Export Actions Component
export function SWExportActions({ file }: { file: LocalFile }) {
  const [isExporting, setIsExporting] = useState<string | null>(null)
  const { status } = useSolidWorksService()
  const { addToast } = usePDMStore()

  const ext = file.extension?.toLowerCase() || ''
  const isDrawing = ext === '.slddrw'
  const isPartOrAsm = ['.sldprt', '.sldasm'].includes(ext)

  if (!status.running || (!isDrawing && !isPartOrAsm)) {
    return null
  }

  const handleExport = async (format: 'pdf' | 'step' | 'dxf' | 'iges') => {
    setIsExporting(format)
    try {
      let result
      switch (format) {
        case 'pdf':
          result = await window.electronAPI?.solidworks?.exportPdf(file.path)
          break
        case 'step':
          result = await window.electronAPI?.solidworks?.exportStep(file.path, { exportAllConfigs: false })
          break
        case 'dxf':
          result = await window.electronAPI?.solidworks?.exportDxf(file.path)
          break
        case 'iges':
          result = await window.electronAPI?.solidworks?.exportIges(file.path)
          break
      }

      if (result?.success) {
        addToast('success', `Exported to ${format.toUpperCase()}`)
      } else {
        addToast('error', result?.error || `Failed to export ${format.toUpperCase()}`)
      }
    } catch (err) {
      addToast('error', `Export failed: ${err}`)
    } finally {
      setIsExporting(null)
    }
  }

  return (
    <div className="flex gap-2 mt-3">
      {isDrawing && (
        <>
          <button
            onClick={() => handleExport('pdf')}
            disabled={!!isExporting}
            className="btn btn-sm btn-secondary gap-1 flex-1"
          >
            {isExporting === 'pdf' ? <Loader2 size={12} className="animate-spin" /> : <FileOutput size={12} />}
            PDF
          </button>
          <button
            onClick={() => handleExport('dxf')}
            disabled={!!isExporting}
            className="btn btn-sm btn-secondary gap-1 flex-1"
          >
            {isExporting === 'dxf' ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            DXF
          </button>
        </>
      )}
      {isPartOrAsm && (
        <>
          <button
            onClick={() => handleExport('step')}
            disabled={!!isExporting}
            className="btn btn-sm btn-secondary gap-1 flex-1"
          >
            {isExporting === 'step' ? <Loader2 size={12} className="animate-spin" /> : <Package size={12} />}
            STEP
          </button>
          <button
            onClick={() => handleExport('iges')}
            disabled={!!isExporting}
            className="btn btn-sm btn-secondary gap-1 flex-1"
          >
            {isExporting === 'iges' ? <Loader2 size={12} className="animate-spin" /> : <Package size={12} />}
            IGES
          </button>
        </>
      )}
    </div>
  )
}

