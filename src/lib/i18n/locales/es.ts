import type { TranslationDict } from '../types'

// Spanish translations
export const es: TranslationDict = {
  checkoutDisplay: {
    you: 'Tú',
    loadingOwner: 'Cargando propietario del checkout',
    ownerUnavailable: 'Propietario del checkout no disponible',
    checkedOutBy: 'Bloqueado por {{name}}',
    checkedOutByOnComputer: 'Bloqueado por {{name}} en {{computer}}',
    anotherComputer: 'otro ordenador',
    differentComputer: 'ordenador diferente',
    otherComputer: 'otro PC',
  },
  common: {
    save: 'Guardar',
    cancel: 'Cancelar',
    delete: 'Eliminar',
    edit: 'Editar',
    add: 'Añadir',
    remove: 'Quitar',
    close: 'Cerrar',
    search: 'Buscar',
    loading: 'Cargando...',
    error: 'Error',
    success: 'Éxito',
    warning: 'Advertencia',
    info: 'Info',
    yes: 'Sí',
    no: 'No',
    ok: 'OK',
    confirm: 'Confirmar',
    back: 'Atrás',
    next: 'Siguiente',
    refresh: 'Actualizar',
    reset: 'Restablecer',
    apply: 'Aplicar',
    clear: 'Borrar',
    select: 'Seleccionar',
    selectAll: 'Seleccionar todo',
    none: 'Ninguno',
    all: 'Todos',
    name: 'Nombre',
    description: 'Descripción',
    type: 'Tipo',
    size: 'Tamaño',
    date: 'Fecha',
    status: 'Estado',
    actions: 'Acciones',
    settings: 'Configuración',
    preferences: 'Preferencias',
    help: 'Ayuda',
    about: 'Acerca de',
    version: 'Versión',
    file: 'Archivo',
    folder: 'Carpeta',
    files: 'Archivos',
    folders: 'Carpetas',
    open: 'Abrir',
    connect: 'Conectar',
    connecting: 'Conectando...',
    default: 'Predeterminado',
    or: 'o',
    optional: 'opcional',
  },

  welcome: {
    title: 'BluePLM',
    tagline: 'Gestión de ciclo de vida de producto de código abierto',
    selectAccountType: 'Selecciona tu tipo de cuenta',
    teamMember: 'Miembro del equipo',
    teamMemberDesc: 'Ingenieros, administradores y observadores',
    supplier: 'Proveedor',
    supplierDesc: 'Acceso al portal de proveedores',
    workOffline: 'Trabajar sin conexión',
    offlineMode: 'Modo sin conexión',

    teamSignIn: 'Inicio de sesión de miembro del equipo',
    signInWithOrg: 'Inicia sesión con tu cuenta de organización',
    signInWithGoogle: 'Iniciar sesión con Google',
    tryAgain: 'Intentar de nuevo',
    connecting: 'Conectando...',
    roleSetByOrg: 'Tu rol (Admin, Ingeniero, Observador) es definido por tu organización',

    supplierPortal: 'Portal de proveedores',
    createAccount: 'Crea tu cuenta de proveedor',
    signInToAccount: 'Inicia sesión en tu cuenta',
    email: 'Correo electrónico',
    password: 'Contraseña',
    confirmPassword: 'Confirmar contraseña',
    passwordMismatch: 'Las contraseñas no coinciden',
    phone: 'Teléfono',
    phoneNumber: 'Número de teléfono',
    fullName: 'Nombre completo',
    createAccountBtn: 'Crear cuenta',
    signIn: 'Iniciar sesión',
    alreadyHaveAccount: '¿Ya tienes una cuenta? Inicia sesión',
    noAccount: '¿No tienes cuenta? Crea una',
    useEmailPassword: 'Usar correo y contraseña',
    useGoogleInstead: 'O iniciar sesión con Google',
    sendVerificationCode: 'Enviar código de verificación',
    verificationCode: 'Código de verificación',
    verifyAndSignIn: 'Verificar e iniciar sesión',
    useDifferentNumber: 'Usar otro número',
    verificationSent: 'Se envió un código de verificación a',
    includeCountryCode: 'Incluir código de país (ej: +34 para España, +1 para USA)',
    supplierInviteNote:
      'Los proveedores son invitados por las organizaciones. Contacta a tu comprador si necesitas acceso.',

    connectingToOrg: 'Conectando a tu organización...',
    organizationVaults: 'Bóvedas de la organización',
    noVaultsCreated: 'No hay bóvedas creadas',
    noVaultsAdminMsg: 'Crea una bóveda en Configuración → Organización para comenzar.',
    noVaultsUserMsg: 'Pide a un administrador que cree una bóveda.',
    advancedOptions: 'O usa las opciones avanzadas para conectarte manualmente.',
    localVault: 'Bóveda local',

    madeWith: 'Hecho con 💙 por Blue Robotics',
  },

  setup: {
    welcome: 'Bienvenido a BluePLM',
    connectToBackend: 'Conecta al backend de Supabase de tu organización para comenzar',
    imAdmin: 'Soy administrador de la organización',
    imAdminDesc:
      'Configura BluePLM con las credenciales de Supabase de tu organización. Obtendrás un código para compartir con tu equipo.',
    haveCode: 'Tengo un código de organización',
    haveCodeDesc: 'Ingresa el código proporcionado por el administrador de tu organización.',
    needHelp: '¿Necesitas ayuda para configurar Supabase?',

    adminSetup: 'Configuración de administrador',
    enterCredentials:
      'Ingresa tus credenciales de Supabase desde la configuración de API de tu proyecto',
    projectId: 'ID del Proyecto',
    projectIdHelp:
      'Se encuentra en la parte superior de tu Panel de Supabase (ej. vvyhpdzqdizvorrhjhvq)',
    anonKey: 'Clave anónima (pública)',
    orgSlug: 'Slug de la organización',
    orgSlugHelp: 'Esto ayuda a identificar tu organización en el código generado',
    connectToSupabase: 'Conectar a Supabase',
    findInDashboard:
      'Encuentra estos valores en tu Panel de Supabase → Configuración del proyecto → API',

    connectedSuccess: '¡Conectado exitosamente!',
    shareCode: 'Comparte este código con los miembros de tu equipo para que puedan conectarse',
    organizationCode: 'Código de organización',
    keepCodeSecure:
      'Los miembros del equipo pueden pegar este código cuando abran BluePLM por primera vez. Mantén este código seguro - contiene tus credenciales de Supabase.',
    continueToBluePLM: 'Continuar a BluePLM',

    joinOrg: 'Únete a tu organización',
    enterCode: 'Ingresa el código proporcionado por el administrador de tu organización',

    enterBothFields: 'Por favor ingresa tanto el ID del Proyecto como la clave anónima',
    invalidProjectId: 'Por favor ingresa un ID de Proyecto válido (solo letras y números)',
    failedToConnect: 'Error al conectar a Supabase',
    enterOrgCode: 'Por favor ingresa el código de organización',
    invalidCode: 'Código de organización inválido. Por favor verifica e intenta de nuevo.',
    failedWithCode: 'Error al conectar a Supabase con el código proporcionado',
  },

  source: {
    configTree: {
      drawings: 'Dibujos',
      ebom: 'eBOM',
      noDrawings: 'Ningún dibujo hace referencia a esta configuración',
      noComponents: 'No hay componentes en esta configuración',
      expand: 'Expandir',
      collapse: 'Contraer',
    },
    configEdit: {
      checkOutToEdit: 'Extraer el archivo para editar',
    },
    configCommit: {
      write: 'Escribir en el archivo',
      writeAndSync: 'Escribir y actualizar dibujos',
      writeAndSyncCount: 'Escribir y actualizar dibujos para {{count}} configuraciones',
      pending: 'Aún no se ha escrito en el documento',
      swOffline: 'Inicia el servicio de SolidWorks para escribir los metadatos de configuración',
      summary:
        'Configuraciones escritas: {{configurations}}; dibujos actualizados: {{updated}}, omitidos: {{skipped}}, fallidos: {{failed}}',
    },
    configDrawings: {
      dialogTitle: 'Los dibujos hacen referencia a esta configuración',
      dialogBody:
        'Algunos dibujos referenciados no están bloqueados por ti. Debes bloquearlos para que reciban la actualización.',
      checkOutAndUpdate: 'Bloquear y actualizar',
      forceModelOnly: 'Escribir solo el modelo',
      heldBy: 'Bloqueado por {{name}}',
      blocked: 'Bloqueado por otras personas',
      notInVault: 'No está en esta bóveda',
      ready: 'Listo para actualizar',
      available: 'Disponible para bloquear',
      modelOnlyWarning:
        'Escribir solo el modelo deja sin cambios los dibujos que no estén bloqueados por ti.',
    },
  },

  settings: {
    title: 'Configuración',
    preferences: 'Preferencias',
    account: 'Cuenta',
    vault: 'Bóveda',
    organization: 'Organización',
    integrations: 'Integraciones',
    solidworks: 'SolidWorks',
    backup: 'Copia de seguridad',
    api: 'API',
    logs: 'Registros',
    about: 'Acerca de',
  },

  preferences: {
    title: 'Preferencias',
    applicationUpdates: 'Actualizaciones de la aplicación',
    checkForUpdates: 'Buscar actualizaciones',
    checking: 'Comprobando...',
    upToDate: 'Actualizado',
    available: 'Disponible',
    youHaveLatest: 'Tienes la última versión',
    updateAvailable: '¡Actualización disponible! Revisa la notificación.',
    couldNotCheck: 'No se pudo buscar actualizaciones',
    checkForNewVersions: 'Buscar nuevas versiones',

    appearance: 'Apariencia',
    themeDark: 'Oscuro',
    themeDarkDesc: 'Estilo VS Code Dark+',
    themeDeepBlue: 'Azul profundo',
    themeDeepBlueDesc: 'Tema azul océano',
    themeLight: 'Claro',
    themeLightDesc: 'Estilo VS Code Light+',
    themeChristmas: '🎄 Navidad',
    themeChristmasDesc: '¡Festivo con nieve, trineos y campanas!',
    themeHalloween: '🎃 Halloween',
    themeHalloweenDesc: '¡Espeluznante con chispas de fogata, fantasmas y calabazas!',
    themeKenneth: '👑 Kenneth',
    themeKennethDesc: 'Elegancia púrpura real',
    themeWeather: '🌤️ Clima Local',
    themeWeatherDesc: '¡Tema dinámico que se adapta al clima local!',
    themeSystem: 'Sistema',
    themeSystemDesc: 'Seguir preferencia del sistema',
    autoSeasonalThemes: 'Aplicar temas estacionales automáticamente',
    autoSeasonalThemesDesc: 'Cambiar automáticamente a Halloween (1 oct.) y Navidad (1 dic.)',

    language: 'Idioma',
    displayLanguage: 'Idioma de visualización',
    chooseLanguage: 'Elige el idioma de la interfaz',
    translationsNote:
      'Nota: Algunas traducciones pueden estar incompletas. Puede requerir reinicio.',

    fileExtensions: 'Extensiones de archivo',
    lowercaseExtensions: 'Minúsculas en extensiones al subir',
    lowercaseExtensionsDesc: 'Convertir .SLDPRT a .sldprt al registrar archivos',

    ignorePatterns: 'Patrones a ignorar (mantener solo local)',
    ignorePatternsDesc:
      'Los archivos que coincidan con estos patrones permanecerán locales y no se sincronizarán.',
    ignorePlaceholder: 'ej: *.tmp, .git/*, thumbs.db',
    connectVaultForPatterns: 'Conéctate a una bóveda para gestionar patrones a ignorar.',
    noIgnorePatterns: 'Sin patrones de exclusión configurados',

    syncSettings: 'Configuración de sincronización',
    autoDownloadCloudFiles: 'Descargar archivos de la nube automáticamente',
    autoDownloadCloudFilesDesc:
      'Descargar automáticamente archivos que existen en el servidor pero no localmente',
    autoDownloadUpdates: 'Descargar actualizaciones automáticamente',
    autoDownloadUpdatesDesc:
      'Descargar automáticamente cuando el servidor tiene versiones más nuevas',
    excludedFiles: 'Archivos excluidos',
    excludedFilesDesc:
      '{{count}} archivo(s) excluido(s) de descarga automática (eliminados manualmente)',
    clearExcludedFiles: 'Limpiar lista',
    autoDiscardOrphanedFiles: 'Descartar archivos huérfanos automáticamente',
    autoDiscardOrphanedFilesDesc:
      'Eliminar automáticamente archivos locales que ya no existen en el servidor',
    discardOrphaned: 'Descartar huérfanos',
    discardOrphanedCount: 'Descartar huérfanos ({{count}} archivo{{plural}})',
    orphanedFilesDescription:
      'Estos archivos fueron sincronizados previamente pero han sido eliminados del servidor por otro usuario',
  },

  sidebar: {
    // Source Files
    explorer: 'Explorador',
    pending: 'Pendiente',
    history: 'Historial',
    workflows: 'Flujos de trabajo de archivos',
    trash: 'Papelera',
    // Products
    products: 'Explorador de productos',
    items: 'Navegador de artículos',
    // Change Control
    ecr: 'ECRs / Problemas',
    eco: 'ECOs',
    notifications: 'Notificaciones',
    deviations: 'Desviaciones',
    releaseSchedule: 'Calendario de lanzamientos',
    process: 'Editor de procesos',
    // Supply Chain - Suppliers
    supplierDatabase: 'Base de datos de proveedores',
    supplierPortal: 'Portal de proveedores',
    // Customers
    customers: 'Clientes',
    // Integrations
    googleDrive: 'Google Drive',
    // System
    terminal: 'Terminal',
    settings: 'Configuración',
    // Section Headers
    sourceFiles: 'Archivos fuente',
    itemsSection: 'Artículos',
    changeControl: 'Control de cambios',
    supplyChain: 'Cadena de suministro',
    suppliers: 'Proveedores',
    purchasing: 'Compras',
    logistics: 'Logística',
    production: 'Producción',
    quality: 'Calidad',
    integrations: 'Integraciones',
    // Sidebar control
    sidebarControl: 'Control de barra lateral',
    expanded: 'Expandida',
    collapsed: 'Colapsada',
    expandOnHover: 'Expandir al pasar el cursor',
  },

  fileBrowser: {
    name: 'Nombre',
    fileStatus: 'Estado del archivo',
    checkedOutBy: 'Extraído por',
    version: 'Ver',
    itemNumber: 'Número de artículo',
    description: 'Descripción',
    revision: 'Rev',
    state: 'Estado',
    ecoTags: 'ECOs',
    extension: 'Tipo',
    size: 'Tamaño',
    modified: 'Modificado',
    noFilesFound: 'No se encontraron archivos',
    dropFilesHere: 'Suelta archivos aquí para subir',
  },

  autoDiscard: {
    removed: {
      generic_one: 'Se eliminó {{count}} archivo borrado de la bóveda',
      generic_other: 'Se eliminaron {{count}} archivos borrados de la bóveda',
      fromFolder_one: 'Se eliminó {{count}} archivo de {{folder}} (borrado de la bóveda)',
      fromFolder_other: 'Se eliminaron {{count}} archivos de {{folder}} (borrados de la bóveda)',
    },
    failed: {
      generic_one: 'No fue posible descartar automáticamente {{count}} archivo huérfano',
      generic_other: 'No fue posible descartar automáticamente {{count}} archivos huérfanos',
    },
    directoriesRemoved: {
      generic_one: 'También se eliminó {{count}} carpeta vacía que quedó',
      generic_other: 'También se eliminaron {{count}} carpetas vacías que quedaron',
    },
  },

  fileOps: {
    serverPathUpdateFailed:
      'Algunos cambios de nombre no llegaron al servidor, que sigue registrando las rutas anteriores. Los archivos afectados aparecen como movidos; ejecute reconcile-moved-paths para actualizarlos.',
    cloudRenameFailed: 'No se pudo cambiar el nombre en el servidor',
    movedAwayBlocked: 'El archivo se ha movido - resuelva primero el movimiento pendiente',
    checkIn: 'Registrar',
    checkOut: 'Extraer',
    download: 'Descargar',
    getLatest: 'Obtener la última versión',
    upload: 'Subir',
    delete: 'Eliminar',
    rename: 'Renombrar',
    move: 'Mover',
    copy: 'Copiar',
    paste: 'Pegar',
    openFile: 'Abrir archivo',
    openFolder: 'Abrir carpeta',
    openInExplorer: 'Abrir en explorador',
    viewHistory: 'Ver historial',
    compare: 'Comparar',
    rollback: 'Revertir',
    discard: 'Descartar cambios',
    forceRelease: 'Forzar liberación',
  },

  syncError: {
    toast: 'Error de sincronización: {{reason}}',
    toastWithMore: 'Error de sincronización: {{reason}} (+{{count}} más)',
    failed: 'Error de sincronización',
    unknown: 'Error desconocido',
    pathCaseConflict:
      'Otro archivo ya ocupa esta ruta en el servidor y solo se diferencia en mayúsculas y minúsculas. Actualiza la lista de archivos para verlo.',
  },

  status: {
    ready: 'Listo',
    syncing: 'Sincronizando...',
    uploading: 'Subiendo...',
    downloading: 'Descargando...',
    processing: 'Procesando...',
    connected: 'Conectado',
    disconnected: 'Desconectado',
    offline: 'Sin conexión',
    online: 'En línea',
  },

  fileState: {
    released: 'Publicado',
    inWork: 'En trabajo',
    pending: 'Pendiente',
    obsolete: 'Obsoleto',
    checkedOut: 'Extraído',
    checkedIn: 'Registrado',
  },

  diffStatus: {
    added: 'Añadido',
    modified: 'Modificado',
    deleted: 'Eliminado',
    outdated: 'Desactualizado',
    cloud: 'Nube',
    cloudNew: 'Nuevo (Nube)',
    moved: 'Movido',
    movedAway: 'Movido (anterior)',
    ignored: 'Ignorado',
  },

  fileStatus: {
    deletedFromServer: 'Eliminado del servidor',
    movedTooltip: 'Este archivo ahora está aquí, pero el almacén todavía registra su ruta anterior',
    movedAwayTooltip: 'El almacén todavía indica este archivo aquí, pero se ha movido',
    movedAwayTooltipTo: 'Movido a {{path}}',
  },

  explorer: {
    pendingMovesBadgeTitle_one: '{{count}} movimiento de archivo pendiente — haga clic para revisar',
    pendingMovesBadgeTitle_other:
      '{{count}} movimientos de archivos pendientes — haga clic para revisar',
    disconnectWarningMoved_one:
      '{{count}} archivo se movió y el almacén todavía registra su ruta anterior',
    disconnectWarningMoved_other:
      '{{count}} archivos se movieron y el almacén todavía registra sus rutas anteriores',
    disconnectWarningMovedHint: 'Actualice el almacén para que coincida, o devuelva los archivos',
  },

  vaultSetup: {
    title: 'Configurar tu bóveda',
    subtitle: 'Configura cómo se sincronizan los archivos a tu computadora',
    fileCount: '{{count}} archivos',
    fileCountSingular: '1 archivo',
    totalSize: '{{size}} en total',
    autoDownloadCloudTitle: 'Descargar archivos de la nube automáticamente',
    autoDownloadCloudDesc:
      'Descargar automáticamente archivos que existen en el servidor pero no en tu computadora',
    autoDownloadUpdatesTitle: 'Descargar actualizaciones de archivos automáticamente',
    autoDownloadUpdatesDesc:
      'Descargar automáticamente versiones más nuevas cuando los archivos se actualicen en el servidor',
    summary: 'Después de conectar, BluePLM descargará {{count}} archivos ({{size}})',
    summaryNoDownload: 'Los archivos solo se descargarán cuando los solicites',
    connect: 'Conectar bóveda',
    skip: 'Omitir configuración',
  },

  solidworksVersion: {
    title: 'Elige tu versión de SOLIDWORKS',
    subtitle: 'Hay varias versiones instaladas en este equipo',
    explanation:
      'BluePLM solo puede conectarse a una versión de SOLIDWORKS a la vez. Elige la que realmente usas; de lo contrario, BluePLM puede indicar que SOLIDWORKS no está disponible aunque esté abierto.',
    windowsDefault: 'Predeterminada de Windows',
    confirm: 'Usar esta versión',
    decideLater: 'Decidir más tarde',
    settingTitle: 'Versión de SOLIDWORKS',
    settingLabel: 'Versión a la que conectarse',
    settingDescription: 'Con qué versión de SOLIDWORKS se comunica BluePLM',
    settingHint:
      'Este cambio reinicia el servicio de SOLIDWORKS. Elige la versión en la que abres tus archivos.',
    automatic: 'Automática',
    automaticDescription: 'Usar la versión que Windows registró como predeterminada',
  },

  reconcileMovedPaths: {
    offline: 'No se pueden reconciliar las rutas movidas sin conexión',
    notSignedIn: 'Inicie sesión primero',
    noOrganization: 'Ninguna organización conectada',
    noVault: 'Ningún almacén conectado',
    nothingToReconcile: 'Ningún archivo está esperando que se actualice su ruta en el servidor',

    reportHeading:
      '{{count}} archivos se movieron o se renombraron en este equipo mientras el servidor seguía registrando sus rutas antiguas.',
    reportEligible: 'En {{count}} se puede escribir la ruta del servidor ahora.',
    reportBlocked: '{{count}} están desprotegidos por otras personas y no se escribirán:',
    reportHolder: '{{count}} en manos de {{user}}',
    unknownHolder: 'otro usuario',
    reportConflict: '{{count}} omitidos — otro registro de archivo ya ocupa la nueva ruta:',
    reportUnverified:
      '{{count}} omitidos — el contenido del archivo ya no coincide con lo que el servidor registró para él, por lo que el movimiento no se puede verificar:',
    reportItem: '{{from}} → {{to}}',
    reportAndMore: '… y {{count}} más',

    dryRunSummary:
      'Solo comprobación previa: se pueden escribir {{eligible}} de {{total}} rutas del servidor. No se escribió nada.',
    dryRunNote: 'Solo informe. No se escribe nada sin --apply.',

    refused:
      'No se escribió nada: {{count}} de estos archivos están desprotegidos por otras personas ({{holders}}). Pídales que los protejan y vuelva a ejecutarlo, o ejecútelo con --skip-checked-out para reconciliar el resto y dejar los suyos intactos.',
    nothingEligible:
      'No se puede escribir nada: {{blocked}} están desprotegidos por otras personas y {{skipped}} se omitieron.',
    confirmUnavailable:
      'No se escribió nada: este comando necesita un diálogo de confirmación y no había ninguno disponible.',

    confirmTitle: '¿Actualizar {{count}} rutas del servidor?',
    confirmMessage:
      'Se actualizará la ruta del servidor de {{count}} archivos a la ubicación que ahora ocupan en el disco. Esto escribe un registro y anota un movimiento por cada uno, y todos los demás equipos de la organización recibirán las nuevas rutas en su próxima sincronización.',
    confirmRemainder: '{{count}} más quedan sin cambios ({{detail}}).',
    confirmText: 'Actualizar {{count}} rutas',
    declined: 'Cancelado. No se escribió nada.',

    progress: 'Actualizando {{count}} rutas del servidor…',
    failureItem: '{{path}}: {{error}}',
    unknownError: 'Error desconocido',

    summaryComplete: '{{count}} rutas del servidor reconciliadas.',
    summaryPartial:
      '{{succeeded}} de {{total}} rutas del servidor reconciliadas — {{leftovers}}. Vuelva a ejecutarlo para terminar.',
    summaryFailed: '{{count}} con error',
    summaryNotAttempted: '{{count}} sin intentar',
    summaryBlocked: '{{count}} desprotegidos por otros',
    summarySkipped: '{{count}} omitidos',
  },

  adoptServerPaths: {
    notSignedIn: 'Inicie sesión primero',
    noVault: 'Ningún almacén conectado',
    nothingToAdopt: 'Ningún archivo está esperando volver a la ruta que registra el servidor',

    reportHeading:
      '{{count}} archivos están en una ruta local que ya no coincide con lo que el servidor registra para ellos.',
    reportEligible: '{{count}} pueden renombrarse ahora a su ruta del servidor.',
    reportBlocked:
      '{{count}} están desprotegidos por otras personas y se dejarán intactos salvo que se fuerce:',
    reportHolder: '{{count}} en manos de {{user}}',
    unknownHolder: 'otro usuario',
    reportConflict: '{{count}} omitidos — ya hay otro archivo en el destino en el disco:',
    reportUnverified:
      '{{count}} omitidos — el contenido del archivo ya no coincide con lo que el servidor registró para él, por lo que el movimiento no se puede verificar:',
    reportItem: '{{from}} → {{to}}',
    reportAndMore: '… y {{count}} más',

    dryRunSummary:
      'Solo comprobación previa: {{eligible}} de {{total}} archivos pueden renombrarse a su ruta del servidor. No se escribió nada.',
    dryRunNote: 'Solo informe. No se escribe nada sin --apply.',

    refused:
      'No se renombró nada: {{count}} de estos archivos están desprotegidos por otras personas ({{holders}}). El cambio solo afecta a su propio disco y es seguro de todos modos — pregúnteles primero, o vuelva a ejecutarlo con --force para renombrarlos también.',
    nothingEligible: 'No se puede renombrar nada: {{skipped}} se omitieron.',
    confirmUnavailable:
      'No se renombró nada: este comando necesita un diálogo de confirmación y no había ninguno disponible.',

    confirmTitle: '¿Renombrar {{count}} archivos a su ruta del servidor?',
    confirmMessage:
      '{{count}} archivos de este equipo se renombrarán a la ruta que el servidor ya registra para ellos. Esto solo cambia su disco local — no se escribe nada en el servidor.',
    confirmRemainder: '{{count}} más quedan sin cambios ({{detail}}).',
    confirmText: 'Renombrar {{count}} archivos',
    declined: 'Cancelado. No se renombró nada.',

    progress: 'Renombrando {{count}} archivos a su ruta del servidor…',
    failureItem: '{{path}}: {{error}}',
    unknownError: 'Error desconocido',
    destinationAppeared: 'Otro archivo apareció en "{{path}}" después de la comprobación previa',
    createFolderFailed: 'No se pudo crear la carpeta de destino — {{error}}',

    summaryComplete: 'Se renombraron {{count}} archivos a su ruta del servidor.',
    summaryPartial:
      'Se renombraron {{succeeded}} de {{total}} archivos — {{leftovers}}. Vuelva a ejecutarlo para terminar.',
    summaryFailed: '{{count}} con error',
    summaryNotAttempted: '{{count}} sin intentar',
    summaryBlocked: '{{count}} desprotegidos por otros',
    summarySkipped: '{{count}} omitidos',
  },

  resolveMoves: {
    title: 'Resolver movimientos pendientes',
    subtitle:
      'Algunos archivos están en una ruta distinta a la que registra el almacén. Elija qué lado debe prevalecer.',
    noPendingMoves: 'No hay nada que resolver — no se encontraron movimientos pendientes.',

    scopeLabel: 'Mostrar',
    scopeFile: 'Este archivo',
    scopeFolder: 'Esta carpeta',
    scopeVault: 'Todo el almacén',
    vaultWideNote:
      'Resolver siempre procesa todos los movimientos pendientes del almacén, no solo los que se muestran arriba.',

    listHeading_one: '{{count}} movimiento pendiente mostrado',
    listHeading_other: '{{count}} movimientos pendientes mostrados',
    noMovesInScope: 'No hay movimientos pendientes en este ámbito.',
    moreFiles: '… y {{count}} más',

    reconcileOptionTitle: 'Mantener la nueva ubicación y actualizar el almacén para que coincida',
    reconcileOptionDescription:
      'Escribe la ruta de su disco en el servidor. Todos los demás obtienen la nueva ubicación en su próxima sincronización.',
    adoptOptionTitle: 'Devolver los archivos a donde los tiene el almacén',
    adoptOptionDescription:
      'Renombra los archivos de su disco de vuelta a la ruta que el servidor ya registra. No se escribe nada en el servidor.',

    eligibleCount_one: '{{count}} archivo listo',
    eligibleCount_other: '{{count}} archivos listos',
    blockedCount_one: '{{count}} archivo desprotegido por otra persona',
    blockedCount_other: '{{count}} archivos desprotegidos por otros',
    conflictCount_one: '{{count}} archivo omitido — destino ya ocupado',
    conflictCount_other: '{{count}} archivos omitidos — destino ya ocupado',
    unverifiedCount_one: '{{count}} archivo omitido — el contenido ya no coincide',
    unverifiedCount_other: '{{count}} archivos omitidos — el contenido ya no coincide',
    noEligible: 'Aquí todavía no hay nada que se pueda resolver.',
    unknownHolder: 'otro usuario',

    skipCheckedOutLabel_one:
      'Omitir el archivo desprotegido por otra persona y actualizar el resto',
    skipCheckedOutLabel_other:
      'Omitir los {{count}} archivos desprotegidos por otros y actualizar el resto',
    forceLabel_one: 'Renombrar también el archivo desprotegido por otra persona',
    forceLabel_other: 'Renombrar también los {{count}} archivos desprotegidos por otros',

    runReconcile: 'Actualizar el almacén',
    runAdopt: 'Restaurar archivos locales',

    contextMenuItem: 'Resolver archivos movidos…',
  },

  hiddenFolders: {
    hideFromNonAdmins: 'Ocultar a los no administradores',
    showToEveryone: 'Mostrar a todos',
    notAccessControl:
      'Oculta esta carpeta de la interfaz para quienes no son administradores. No es una restricción de acceso, los archivos siguen siendo legibles.',
    badgeLabel: 'Oculta a los no administradores',
    hidden: 'Carpeta oculta a los no administradores',
    unhidden: 'Carpeta visible para todos',
    updateFailed: 'No se pudo actualizar la visibilidad de la carpeta',
    updateNotPermitted: 'Puede que no tengas permiso para cambiar la visibilidad de la carpeta',
    scanSkipped: 'Se omitieron {{count}} archivos en carpetas ocultas a los no administradores',
  },
}
