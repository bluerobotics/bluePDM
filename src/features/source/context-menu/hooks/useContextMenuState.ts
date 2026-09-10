// src/features/source/context-menu/hooks/useContextMenuState.ts
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { DialogState, DialogName, ForceCheckinFilesState, OrgUser } from '../types'
import type { LocalFile } from '@/stores/pdmStore'
import type { ServerDeletionTarget } from '@/lib/commands'
import type { ECO } from '@/stores/types'
import { isWatchingFile, getActiveECOs as fetchActiveECOs, isMachineOnline } from '@/lib/supabase'
import { getMachineId } from '@/lib/backup'
import { usePDMStore } from '@/stores/pdmStore'

interface UseContextMenuStateOptions {
  userId: string | undefined
  organizationId: string | undefined
  contextFiles: LocalFile[]
}

interface UseContextMenuStateResult {
  // Dialog state
  dialogs: DialogState
  openDialog: (name: DialogName) => void
  closeDialog: (name: DialogName) => void

  // Delete confirm state
  deleteConfirmFiles: ServerDeletionTarget[]
  setDeleteConfirmFiles: (targets: ServerDeletionTarget[]) => void
  deleteServerKeepLocal: boolean
  setDeleteServerKeepLocal: (value: boolean) => void

  // Delete local confirm state
  deleteLocalCheckedOutFiles: LocalFile[]
  setDeleteLocalCheckedOutFiles: (files: LocalFile[]) => void

  // Force checkin state
  forceCheckinFiles: ForceCheckinFilesState | null
  setForceCheckinFiles: (value: ForceCheckinFilesState | null) => void
  currentMachineId: string | null
  checkForDifferentMachineCheckout: (filesToCheckin: LocalFile[]) => Promise<boolean>

  // Properties state
  folderSize: { size: number; fileCount: number; folderCount: number } | null
  setFolderSize: (value: { size: number; fileCount: number; folderCount: number } | null) => void
  isCalculatingSize: boolean
  setIsCalculatingSize: (value: boolean) => void

  // Watch state
  isWatching: boolean
  isTogglingWatch: boolean
  setIsTogglingWatch: (value: boolean) => void
  setIsWatching: (value: boolean) => void

  // Share link state
  generatedShareLink: string | null
  setGeneratedShareLink: (value: string | null) => void
  isCreatingShareLink: boolean
  setIsCreatingShareLink: (value: boolean) => void
  copiedLink: boolean
  setCopiedLink: (value: boolean) => void

  // Org users for review/mention modals (from store's members)
  orgUsers: OrgUser[]
  loadingUsers: boolean

  // ECO state
  activeECOs: ECO[]
  loadingECOs: boolean
  loadActiveECOs: () => Promise<void>

  // Ignore submenu
  showIgnoreSubmenu: boolean
  setShowIgnoreSubmenu: (value: boolean) => void
  handleIgnoreSubmenuEnter: () => void
  handleIgnoreSubmenuLeave: () => void

  // Match ghost file state
  matchGhostFile: LocalFile | null
  setMatchGhostFile: (file: LocalFile | null) => void
  matchGhostCandidates: LocalFile[]
  setMatchGhostCandidates: (files: LocalFile[]) => void

  // Platform
  platform: string
}

const initialDialogState: DialogState = {
  deleteConfirm: false,
  deleteLocalConfirm: false,
  forceCheckin: false,
  properties: false,
  reviewRequest: false,
  checkoutRequest: false,
  mention: false,
  shareLink: false,
  addToECO: false,
  matchGhostFile: false,
}

export function useContextMenuState({
  userId,
  organizationId,
  contextFiles,
}: UseContextMenuStateOptions): UseContextMenuStateResult {
  // Get ECO and members state from store
  const {
    ecosLoaded,
    ecosLoading,
    getActiveECOs: getActiveECOsFromStore,
    setECOs,
    setECOsLoading,
    // Members for org users
    members,
    membersLoading,
  } = usePDMStore()

  // Dialog state
  const [dialogs, setDialogs] = useState<DialogState>(initialDialogState)

  // Delete confirm state
  const [deleteConfirmFiles, setDeleteConfirmFiles] = useState<ServerDeletionTarget[]>([])
  const [deleteServerKeepLocal, setDeleteServerKeepLocal] = useState(false)
  const [deleteLocalCheckedOutFiles, setDeleteLocalCheckedOutFiles] = useState<LocalFile[]>([])

  // Force checkin state
  const [forceCheckinFiles, setForceCheckinFiles] = useState<ForceCheckinFilesState | null>(null)
  const [currentMachineId, setCurrentMachineId] = useState<string | null>(null)

  // Properties state
  const [folderSize, setFolderSize] = useState<{
    size: number
    fileCount: number
    folderCount: number
  } | null>(null)
  const [isCalculatingSize, setIsCalculatingSize] = useState(false)

  // Watch state
  const [isWatching, setIsWatching] = useState(false)
  const [isTogglingWatch, setIsTogglingWatch] = useState(false)

  // Match ghost file state
  const [matchGhostFile, setMatchGhostFile] = useState<LocalFile | null>(null)
  const [matchGhostCandidates, setMatchGhostCandidates] = useState<LocalFile[]>([])

  // Share link state
  const [generatedShareLink, setGeneratedShareLink] = useState<string | null>(null)
  const [isCreatingShareLink, setIsCreatingShareLink] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)

  // Org users derived from store members (excluding current user)
  const orgUsers = useMemo(() => {
    return members
      .filter((m) => m.id !== userId)
      .map((m) => ({
        id: m.id,
        email: m.email,
        full_name: m.full_name,
        avatar_url: m.avatar_url || m.custom_avatar_url || null,
      })) as OrgUser[]
  }, [members, userId])
  const loadingUsers = membersLoading

  // Ignore submenu
  const [showIgnoreSubmenu, setShowIgnoreSubmenu] = useState(false)
  const ignoreSubmenuTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Platform
  const [platform, setPlatform] = useState<string>('win32')

  // Get active ECOs from store
  const activeECOs = getActiveECOsFromStore()
  const loadingECOs = ecosLoading

  // Load machine ID
  useEffect(() => {
    const loadMachineId = async () => {
      try {
        const machineId = await getMachineId()
        setCurrentMachineId(machineId)
      } catch {
        setCurrentMachineId(null)
      }
    }
    loadMachineId()
  }, [])

  // Load platform
  useEffect(() => {
    window.electronAPI?.getPlatform().then(setPlatform)
  }, [])

  // Check if user is watching the file
  useEffect(() => {
    if (
      userId &&
      contextFiles.length === 1 &&
      !contextFiles[0].isDirectory &&
      contextFiles[0].pdmData?.id
    ) {
      isWatchingFile(contextFiles[0].pdmData.id, userId).then(({ watching }) => {
        setIsWatching(watching)
      })
    }
  }, [userId, contextFiles])

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (ignoreSubmenuTimeoutRef.current) {
        clearTimeout(ignoreSubmenuTimeoutRef.current)
      }
    }
  }, [])

  // Dialog handlers
  const openDialog = useCallback((name: DialogName) => {
    setDialogs((prev) => ({ ...prev, [name]: true }))
  }, [])

  const closeDialog = useCallback((name: DialogName) => {
    setDialogs((prev) => ({ ...prev, [name]: false }))
  }, [])

  // Check for different machine checkout
  const checkForDifferentMachineCheckout = useCallback(
    async (filesToCheckin: LocalFile[]): Promise<boolean> => {
      const filesOnDifferentMachine = filesToCheckin.filter((f) => {
        const checkoutMachineId = f.pdmData?.checked_out_by_machine_id
        return checkoutMachineId && currentMachineId && checkoutMachineId !== currentMachineId
      })

      if (filesOnDifferentMachine.length > 0 && userId) {
        const machineIds = [
          ...new Set(
            filesOnDifferentMachine
              .map((f) => f.pdmData?.checked_out_by_machine_id)
              .filter(Boolean),
          ),
        ] as string[]
        const machineNames = [
          ...new Set(
            filesOnDifferentMachine.map(
              (f) => f.pdmData?.checked_out_by_machine_name || 'another computer',
            ),
          ),
        ]

        const onlineStatuses = await Promise.all(
          machineIds.map((mid) => isMachineOnline(userId, mid)),
        )
        const anyMachineOnline = onlineStatuses.some((isOnline) => isOnline)

        setForceCheckinFiles({ filesOnDifferentMachine, machineNames, anyMachineOnline })
        openDialog('forceCheckin')
        return true
      }
      return false
    },
    [currentMachineId, userId, openDialog],
  )

  // Ignore submenu handlers
  const handleIgnoreSubmenuEnter = useCallback(() => {
    if (ignoreSubmenuTimeoutRef.current) {
      clearTimeout(ignoreSubmenuTimeoutRef.current)
      ignoreSubmenuTimeoutRef.current = null
    }
    setShowIgnoreSubmenu(true)
  }, [])

  const handleIgnoreSubmenuLeave = useCallback(() => {
    ignoreSubmenuTimeoutRef.current = setTimeout(() => {
      setShowIgnoreSubmenu(false)
    }, 150)
  }, [])

  // Load active ECOs
  const loadActiveECOs = useCallback(async () => {
    if (!organizationId) return

    // Skip if already loaded
    if (ecosLoaded) return

    setECOsLoading(true)
    const { ecos } = await fetchActiveECOs(organizationId)
    // Map to full ECO type for store
    setECOs(
      ecos.map((eco) => ({
        ...eco,
        description: eco.description ?? null,
        status: eco.status ?? null,
        created_at: eco.created_at ?? null,
      })),
    )
    setECOsLoading(false)
  }, [organizationId, ecosLoaded, setECOs, setECOsLoading])

  return {
    dialogs,
    openDialog,
    closeDialog,
    deleteConfirmFiles,
    setDeleteConfirmFiles,
    deleteServerKeepLocal,
    setDeleteServerKeepLocal,
    deleteLocalCheckedOutFiles,
    setDeleteLocalCheckedOutFiles,
    forceCheckinFiles,
    setForceCheckinFiles,
    currentMachineId,
    checkForDifferentMachineCheckout,
    folderSize,
    setFolderSize,
    isCalculatingSize,
    setIsCalculatingSize,
    isWatching,
    isTogglingWatch,
    setIsTogglingWatch,
    setIsWatching,
    generatedShareLink,
    setGeneratedShareLink,
    isCreatingShareLink,
    setIsCreatingShareLink,
    copiedLink,
    setCopiedLink,
    orgUsers,
    loadingUsers,
    activeECOs,
    loadingECOs,
    loadActiveECOs,
    showIgnoreSubmenu,
    setShowIgnoreSubmenu,
    handleIgnoreSubmenuEnter,
    handleIgnoreSubmenuLeave,
    matchGhostFile,
    setMatchGhostFile,
    matchGhostCandidates,
    setMatchGhostCandidates,
    platform,
  }
}
