import type { TranslationDict } from '../types'

// Portuguese translations (Português)
export const pt: TranslationDict = {
  checkoutDisplay: {
    you: 'Você',
    loadingOwner: 'A carregar o proprietário do checkout',
    ownerUnavailable: 'Proprietário do checkout indisponível',
    checkedOutBy: 'Em checkout por {{name}}',
    checkedOutByOnComputer: 'Em checkout por {{name}} em {{computer}}',
    anotherComputer: 'outro computador',
    differentComputer: 'computador diferente',
    otherComputer: 'outro PC',
  },
  common: {
    save: 'Guardar',
    cancel: 'Cancelar',
    delete: 'Eliminar',
    edit: 'Editar',
    add: 'Adicionar',
    remove: 'Remover',
    close: 'Fechar',
    search: 'Pesquisar',
    loading: 'A carregar...',
    error: 'Erro',
    success: 'Sucesso',
    warning: 'Aviso',
    info: 'Informação',
    yes: 'Sim',
    no: 'Não',
    ok: 'OK',
    confirm: 'Confirmar',
    back: 'Voltar',
    next: 'Seguinte',
    refresh: 'Atualizar',
    reset: 'Repor',
    apply: 'Aplicar',
    clear: 'Limpar',
    select: 'Selecionar',
    selectAll: 'Selecionar tudo',
    none: 'Nenhum',
    all: 'Todos',
    name: 'Nome',
    description: 'Descrição',
    type: 'Tipo',
    size: 'Tamanho',
    date: 'Data',
    status: 'Estado',
    actions: 'Ações',
    settings: 'Definições',
    preferences: 'Preferências',
    help: 'Ajuda',
    about: 'Sobre',
    version: 'Versão',
    file: 'Ficheiro',
    folder: 'Pasta',
    files: 'Ficheiros',
    folders: 'Pastas',
    open: 'Abrir',
    connect: 'Ligar',
    connecting: 'A ligar...',
    default: 'Predefinido',
    or: 'ou',
    optional: 'opcional',
  },

  welcome: {
    title: 'BluePLM',
    tagline: 'Gestão de ciclo de vida de produto open source',
    selectAccountType: 'Selecione o tipo de conta',
    teamMember: 'Membro da Equipa',
    teamMemberDesc: 'Engenheiros, administradores e visualizadores',
    supplier: 'Fornecedor',
    supplierDesc: 'Acesso ao portal de fornecedores',
    workOffline: 'Trabalhar Offline',
    offlineMode: 'Modo Offline',

    teamSignIn: 'Início de Sessão de Membro da Equipa',
    signInWithOrg: 'Inicie sessão com a sua conta da organização',
    signInWithGoogle: 'Iniciar sessão com Google',
    tryAgain: 'Tentar novamente',
    connecting: 'A ligar...',
    roleSetByOrg: 'O seu papel (Admin, Engenheiro, Visualizador) é definido pela sua organização',

    supplierPortal: 'Portal do Fornecedor',
    createAccount: 'Crie a sua conta de fornecedor',
    signInToAccount: 'Inicie sessão na sua conta',
    email: 'Email',
    password: 'Palavra-passe',
    confirmPassword: 'Confirmar palavra-passe',
    passwordMismatch: 'As palavras-passe não coincidem',
    phone: 'Telefone',
    phoneNumber: 'Número de telefone',
    fullName: 'Nome completo',
    createAccountBtn: 'Criar Conta',
    signIn: 'Iniciar Sessão',
    alreadyHaveAccount: 'Já tem uma conta? Inicie sessão',
    noAccount: 'Não tem conta? Crie uma',
    useEmailPassword: 'Usar email e palavra-passe',
    useGoogleInstead: 'Ou iniciar sessão com Google',
    sendVerificationCode: 'Enviar Código de Verificação',
    verificationCode: 'Código de Verificação',
    verifyAndSignIn: 'Verificar e Iniciar Sessão',
    useDifferentNumber: 'Usar outro número',
    verificationSent: 'Foi enviado um código de verificação para',
    includeCountryCode: 'Inclua o código do país (ex: +351 para Portugal, +55 para Brasil)',
    supplierInviteNote:
      'Os fornecedores são convidados pelas organizações. Contacte o seu comprador se precisar de acesso.',

    connectingToOrg: 'A ligar à sua organização...',
    organizationVaults: 'Cofres da Organização',
    noVaultsCreated: 'Nenhum Cofre Criado',
    noVaultsAdminMsg: 'Crie um cofre em Definições → Organização para começar.',
    noVaultsUserMsg: 'Peça a um administrador da organização para criar um cofre.',
    advancedOptions: 'Ou use as opções avançadas abaixo para ligar manualmente.',
    localVault: 'Cofre Local',

    madeWith: 'Feito com 💙 pela Blue Robotics',
  },

  setup: {
    welcome: 'Bem-vindo ao BluePLM',
    connectToBackend: 'Ligue-se ao backend Supabase da sua organização para começar',
    imAdmin: 'Sou Administrador da Organização',
    imAdminDesc:
      'Configure o BluePLM com as credenciais Supabase da sua organização. Receberá um código para partilhar com a sua equipa.',
    haveCode: 'Tenho um Código de Organização',
    haveCodeDesc: 'Introduza o código fornecido pelo administrador da sua organização para ligar.',
    needHelp: 'Precisa de ajuda a configurar o Supabase?',

    adminSetup: 'Configuração de Administrador',
    enterCredentials: 'Introduza as suas credenciais Supabase das definições de API do seu projeto',
    projectId: 'ID do Projeto',
    projectIdHelp: 'Encontra-se no topo do seu Painel Supabase (ex. vvyhpdzqdizvorrhjhvq)',
    anonKey: 'Chave Anónima (Pública)',
    orgSlug: 'Slug da Organização',
    orgSlugHelp: 'Isto ajuda a identificar a sua organização no código gerado',
    connectToSupabase: 'Ligar ao Supabase',
    findInDashboard: 'Encontre estes valores no seu Painel Supabase → Definições do Projeto → API',

    connectedSuccess: 'Ligado com Sucesso!',
    shareCode: 'Partilhe este código com os membros da sua equipa para que possam ligar',
    organizationCode: 'Código da Organização',
    keepCodeSecure:
      'Os membros da equipa podem colar este código quando abrirem o BluePLM pela primeira vez. Mantenha este código seguro - contém as suas credenciais Supabase.',
    continueToBluePLM: 'Continuar para o BluePLM',

    joinOrg: 'Juntar-se à Sua Organização',
    enterCode: 'Introduza o código fornecido pelo administrador da sua organização',

    enterBothFields: 'Por favor introduza o ID do Projeto e a Chave Anónima',
    invalidProjectId: 'Por favor introduza um ID de Projeto válido (apenas letras e números)',
    failedToConnect: 'Falha ao ligar ao Supabase',
    enterOrgCode: 'Por favor introduza o Código da Organização',
    invalidCode: 'Código de Organização inválido. Por favor verifique e tente novamente.',
    failedWithCode: 'Falha ao ligar ao Supabase com o código fornecido',
  },

  source: {
    configTree: {
      drawings: 'Desenhos',
      ebom: 'eBOM',
      noDrawings: 'Nenhum desenho referencia esta configuração',
      noComponents: 'Não há componentes nesta configuração',
      expand: 'Expandir',
      collapse: 'Recolher',
    },
    configEdit: {
      checkOutToEdit: 'Faça check-out do ficheiro para editar',
    },
    configCommit: {
      write: 'Escrever no ficheiro',
      writeAndSync: 'Escrever e atualizar desenhos',
      writeAndSyncCount: 'Escrever e atualizar desenhos para {{count}} configurações',
      pending: 'Ainda não escrito no documento',
      swOffline: 'Inicie o serviço do SolidWorks para escrever os metadados da configuração',
      summary:
        'Configurações escritas: {{configurations}}; desenhos atualizados: {{updated}}, ignorados: {{skipped}}, falhados: {{failed}}',
    },
    configDrawings: {
      dialogTitle: 'Desenhos referenciam esta configuração',
      dialogBody:
        'Alguns desenhos referenciados não estão em checkout por si. Têm de ser colocados em checkout para receber a atualização.',
      checkOutAndUpdate: 'Fazer checkout e atualizar',
      forceModelOnly: 'Escrever apenas o modelo',
      heldBy: 'Em checkout por {{name}}',
      blocked: 'Em checkout por outra pessoa',
      notInVault: 'Não está neste cofre',
      ready: 'Pronto para atualizar',
      available: 'Disponível para checkout',
      modelOnlyWarning:
        'Escrever apenas o modelo deixa inalterados os desenhos que não estão em checkout por si.',
    },
  },

  settings: {
    title: 'Definições',
    preferences: 'Preferências',
    account: 'Conta',
    vault: 'Cofre',
    organization: 'Organização',
    integrations: 'Integrações',
    solidworks: 'SolidWorks',
    backup: 'Cópia de Segurança',
    api: 'API',
    logs: 'Registos',
    about: 'Sobre',
  },

  preferences: {
    title: 'Preferências',
    applicationUpdates: 'Atualizações da Aplicação',
    checkForUpdates: 'Verificar Atualizações',
    checking: 'A verificar...',
    upToDate: 'Atualizado',
    available: 'Disponível',
    youHaveLatest: 'Tem a versão mais recente',
    updateAvailable: 'Atualização disponível! Verifique a notificação.',
    couldNotCheck: 'Não foi possível verificar atualizações',
    checkForNewVersions: 'Verificar novas versões',

    appearance: 'Aparência',
    themeDark: 'Escuro',
    themeDarkDesc: 'Estilo VS Code Dark+',
    themeDeepBlue: 'Azul Profundo',
    themeDeepBlueDesc: 'Tema azul oceano',
    themeLight: 'Claro',
    themeLightDesc: 'Estilo VS Code Light+',
    themeChristmas: '🎄 Natal',
    themeChristmasDesc: 'Festivo com neve, trenós e sinos!',
    themeHalloween: '🎃 Halloween',
    themeHalloweenDesc: 'Assustador com fagulhas de fogueira, fantasmas e abóboras!',
    themeKenneth: '👑 Kenneth',
    themeKennethDesc: 'Elegância púrpura real',
    themeWeather: '🌤️ Clima Local',
    themeWeatherDesc: 'Tema dinâmico que se adapta ao seu clima local!',
    themeSystem: 'Sistema',
    themeSystemDesc: 'Seguir preferência do sistema',
    autoSeasonalThemes: 'Aplicar temas sazonais automaticamente',
    autoSeasonalThemesDesc: 'Mudar automaticamente para Halloween (1º out.) e Natal (1º dez.)',

    language: 'Idioma',
    displayLanguage: 'Idioma de Exibição',
    chooseLanguage: 'Escolha o idioma da interface',
    translationsNote:
      'Nota: Algumas traduções podem estar incompletas. Poderá ser necessário reiniciar.',

    fileExtensions: 'Extensões de Ficheiro',
    lowercaseExtensions: 'Extensões em minúsculas ao carregar',
    lowercaseExtensionsDesc: 'Converter .SLDPRT para .sldprt ao fazer check-in',

    ignorePatterns: 'Padrões a Ignorar (Manter Apenas Local)',
    ignorePatternsDesc:
      'Ficheiros que correspondam a estes padrões permanecerão locais e não serão sincronizados.',
    ignorePlaceholder: 'ex: *.tmp, .git/*, thumbs.db',
    connectVaultForPatterns: 'Ligue-se a um cofre para gerir padrões a ignorar.',
    noIgnorePatterns: 'Nenhum padrão de exclusão configurado',

    syncSettings: 'Configurações de Sincronização',
    autoDownloadCloudFiles: 'Descarregar ficheiros da nuvem automaticamente',
    autoDownloadCloudFilesDesc:
      'Descarregar automaticamente ficheiros que existem no servidor mas não localmente',
    autoDownloadUpdates: 'Descarregar atualizações automaticamente',
    autoDownloadUpdatesDesc:
      'Descarregar automaticamente quando o servidor tem versões mais recentes',
    excludedFiles: 'Ficheiros excluídos',
    excludedFilesDesc:
      '{{count}} ficheiro(s) excluído(s) do download automático (removidos manualmente)',
    clearExcludedFiles: 'Limpar lista',
    autoDiscardOrphanedFiles: 'Descartar ficheiros órfãos automaticamente',
    autoDiscardOrphanedFilesDesc:
      'Remover automaticamente ficheiros locais que já não existem no servidor',
    discardOrphaned: 'Descartar órfãos',
    discardOrphanedCount: 'Descartar órfãos ({{count}} ficheiro{{plural}})',
    orphanedFilesDescription:
      'Estes ficheiros foram sincronizados anteriormente mas foram eliminados do servidor por outro utilizador',
  },

  sidebar: {
    // Source Files
    explorer: 'Explorador',
    pending: 'Pendentes',
    history: 'Histórico',
    workflows: 'Fluxos de Trabalho de Ficheiros',
    trash: 'Lixo',
    // Products
    products: 'Explorador de Produtos',
    items: 'Navegador de Artigos',
    // Change Control
    ecr: 'ECRs / Problemas',
    eco: 'ECOs',
    notifications: 'Notificações',
    deviations: 'Desvios',
    releaseSchedule: 'Calendário de Lançamentos',
    process: 'Editor de Processos',
    // Supply Chain - Suppliers
    supplierDatabase: 'Base de Dados de Fornecedores',
    supplierPortal: 'Portal de Fornecedores',
    // Customers
    customers: 'Clientes',
    // Integrations
    googleDrive: 'Google Drive',
    // System
    terminal: 'Terminal',
    settings: 'Definições',
    // Section Headers
    sourceFiles: 'Ficheiros Fonte',
    itemsSection: 'Artigos',
    changeControl: 'Controlo de Alterações',
    supplyChain: 'Cadeia de Abastecimento',
    suppliers: 'Fornecedores',
    purchasing: 'Compras',
    logistics: 'Logística',
    production: 'Produção',
    quality: 'Qualidade',
    integrations: 'Integrações',
    // Sidebar control
    sidebarControl: 'Controlo da barra lateral',
    expanded: 'Expandida',
    collapsed: 'Recolhida',
    expandOnHover: 'Expandir ao passar',
  },

  fileBrowser: {
    name: 'Nome',
    fileStatus: 'Estado do Ficheiro',
    checkedOutBy: 'Extraído Por',
    version: 'Ver',
    itemNumber: 'Número do Artigo',
    description: 'Descrição',
    revision: 'Rev',
    state: 'Estado',
    ecoTags: 'ECOs',
    extension: 'Tipo',
    size: 'Tamanho',
    modified: 'Modificado',
    noFilesFound: 'Nenhum ficheiro encontrado',
    dropFilesHere: 'Largue ficheiros aqui para carregar',
  },

  autoDiscard: {
    removed: {
      generic_one: '{{count}} ficheiro eliminado do cofre',
      generic_other: '{{count}} ficheiros eliminados do cofre',
      fromFolder_one: '{{count}} ficheiro eliminado de {{folder}} (eliminado do cofre)',
      fromFolder_other: '{{count}} ficheiros eliminados de {{folder}} (eliminados do cofre)',
    },
    failed: {
      generic_one: 'Não foi possível descartar automaticamente {{count}} ficheiro órfão',
      generic_other: 'Não foi possível descartar automaticamente {{count}} ficheiros órfãos',
    },
    directoriesRemoved: {
      generic_one: 'Também foi eliminada {{count}} pasta vazia que ficou',
      generic_other: 'Também foram eliminadas {{count}} pastas vazias que ficaram',
    },
  },

  fileOps: {
    serverPathUpdateFailed:
      'Algumas mudanças de nome não chegaram ao servidor, que continua a registar os caminhos antigos. Os ficheiros afetados aparecem como movidos; execute reconcile-moved-paths para os atualizar.',
    cloudRenameFailed: 'Não foi possível mudar o nome no servidor',
    checkIn: 'Check-In',
    checkOut: 'Check-Out',
    download: 'Transferir',
    getLatest: 'Obter a versão mais recente',
    upload: 'Carregar',
    delete: 'Eliminar',
    rename: 'Renomear',
    move: 'Mover',
    copy: 'Copiar',
    paste: 'Colar',
    openFile: 'Abrir Ficheiro',
    openFolder: 'Abrir Pasta',
    openInExplorer: 'Abrir no Explorador',
    viewHistory: 'Ver Histórico',
    compare: 'Comparar',
    rollback: 'Reverter',
    discard: 'Descartar Alterações',
    forceRelease: 'Forçar Libertação',
  },

  syncError: {
    toast: 'Falha na sincronização: {{reason}}',
    toastWithMore: 'Falha na sincronização: {{reason}} (+{{count}} mais)',
    failed: 'Falha na sincronização',
    unknown: 'Erro desconhecido',
    pathCaseConflict:
      'Outro ficheiro já ocupa este caminho no servidor e difere apenas em maiúsculas e minúsculas. Atualize a lista de ficheiros para o ver.',
  },

  status: {
    ready: 'Pronto',
    syncing: 'A sincronizar...',
    uploading: 'A carregar...',
    downloading: 'A transferir...',
    processing: 'A processar...',
    connected: 'Ligado',
    disconnected: 'Desligado',
    offline: 'Offline',
    online: 'Online',
  },

  fileState: {
    released: 'Publicado',
    inWork: 'Em Trabalho',
    pending: 'Pendente',
    obsolete: 'Obsoleto',
    checkedOut: 'Extraído',
    checkedIn: 'Registado',
  },

  diffStatus: {
    added: 'Adicionado',
    modified: 'Modificado',
    deleted: 'Eliminado',
    outdated: 'Desatualizado',
    cloud: 'Nuvem',
    cloudNew: 'Novo (Nuvem)',
    moved: 'Movido',
    ignored: 'Ignorado',
  },

  vaultSetup: {
    title: 'Configurar o seu cofre',
    subtitle: 'Configure como os ficheiros são sincronizados para o seu computador',
    fileCount: '{{count}} ficheiros',
    fileCountSingular: '1 ficheiro',
    totalSize: '{{size}} no total',
    autoDownloadCloudTitle: 'Descarregar ficheiros da nuvem automaticamente',
    autoDownloadCloudDesc:
      'Descarregar automaticamente ficheiros que existem no servidor mas não no seu computador',
    autoDownloadUpdatesTitle: 'Descarregar atualizações de ficheiros automaticamente',
    autoDownloadUpdatesDesc:
      'Descarregar automaticamente versões mais recentes quando os ficheiros são atualizados no servidor',
    summary: 'Após conectar, o BluePLM irá descarregar {{count}} ficheiros ({{size}})',
    summaryNoDownload: 'Os ficheiros só serão descarregados quando os solicitar',
    connect: 'Conectar cofre',
    skip: 'Ignorar configuração',
  },

  solidworksVersion: {
    title: 'Escolha a sua versão do SOLIDWORKS',
    subtitle: 'Existem várias versões instaladas neste computador',
    explanation:
      'O BluePLM só consegue ligar-se a uma versão do SOLIDWORKS de cada vez. Escolha aquela que realmente usa, caso contrário o BluePLM pode indicar que o SOLIDWORKS está indisponível mesmo estando aberto.',
    windowsDefault: 'Predefinição do Windows',
    confirm: 'Usar esta versão',
    decideLater: 'Decidir mais tarde',
    settingTitle: 'Versão do SOLIDWORKS',
    settingLabel: 'Versão à qual ligar',
    settingDescription: 'Com que versão do SOLIDWORKS o BluePLM comunica',
    settingHint:
      'Esta alteração reinicia o serviço SOLIDWORKS. Escolha a versão em que abre os seus ficheiros.',
    automatic: 'Automática',
    automaticDescription: 'Usar a versão que o Windows registou como predefinida',
  },

  reconcileMovedPaths: {
    offline: 'Não é possível reconciliar caminhos movidos offline',
    notSignedIn: 'Faça login primeiro',
    noOrganization: 'Nenhuma organização conectada',
    noVault: 'Nenhum cofre conectado',
    nothingToReconcile: 'Nenhum arquivo está aguardando a atualização do seu caminho no servidor',

    reportHeading:
      '{{count}} arquivos foram movidos ou renomeados neste computador enquanto o servidor continuou registrando os caminhos antigos.',
    reportEligible: 'Em {{count}} o caminho do servidor pode ser gravado agora.',
    reportBlocked: '{{count}} estão com check-out feito por outras pessoas e não serão gravados:',
    reportHolder: '{{count}} em posse de {{user}}',
    unknownHolder: 'outro usuário',
    reportConflict: '{{count}} ignorados — outro registro de arquivo já ocupa o novo caminho:',
    reportUnverified:
      '{{count}} ignorados — o conteúdo do arquivo já não corresponde ao que o servidor registrou para ele, portanto a movimentação não pode ser verificada:',
    reportItem: '{{from}} → {{to}}',
    reportAndMore: '… e mais {{count}}',

    dryRunSummary:
      'Apenas verificação prévia: {{eligible}} de {{total}} caminhos do servidor podem ser gravados. Nada foi gravado.',
    dryRunNote: 'Apenas relatório. Nada é gravado sem --apply.',

    refused:
      'Nada foi gravado: {{count}} desses arquivos estão com check-out feito por outras pessoas ({{holders}}). Peça que façam check-in e execute novamente, ou execute com --skip-checked-out para reconciliar os demais e deixar os deles intactos.',
    nothingEligible:
      'Nada pode ser gravado: {{blocked}} estão com check-out feito por outras pessoas e {{skipped}} foram ignorados.',
    confirmUnavailable:
      'Nada foi gravado: este comando precisa de uma caixa de diálogo de confirmação e nenhuma estava disponível.',

    confirmTitle: 'Atualizar {{count}} caminhos do servidor?',
    confirmMessage:
      'O caminho no servidor de {{count}} arquivos será atualizado para onde eles estão agora no disco. Isto grava um registro e anota uma movimentação para cada um, e todos os outros computadores da organização receberão os novos caminhos na próxima sincronização.',
    confirmRemainder: '{{count}} outros permanecem inalterados ({{detail}}).',
    confirmText: 'Atualizar {{count}} caminhos',
    declined: 'Cancelado. Nada foi gravado.',

    progress: 'Atualizando {{count}} caminhos do servidor…',
    failureItem: '{{path}}: {{error}}',
    unknownError: 'Erro desconhecido',

    summaryComplete: '{{count}} caminhos do servidor reconciliados.',
    summaryPartial:
      '{{succeeded}} de {{total}} caminhos do servidor reconciliados — {{leftovers}}. Execute novamente para concluir.',
    summaryFailed: '{{count}} com falha',
    summaryNotAttempted: '{{count}} não tentados',
    summaryBlocked: '{{count}} com check-out de outros',
    summarySkipped: '{{count}} ignorados',
  },

  hiddenFolders: {
    hideFromNonAdmins: 'Ocultar de não administradores',
    showToEveryone: 'Mostrar a todos',
    notAccessControl:
      'Oculta esta pasta na interface para quem não é administrador. Não é uma restrição de acesso, os ficheiros continuam legíveis.',
    badgeLabel: 'Oculta de não administradores',
    hidden: 'Pasta oculta de não administradores',
    unhidden: 'Pasta visível para todos',
    updateFailed: 'Não foi possível atualizar a visibilidade da pasta',
    updateNotPermitted: 'Pode não ter permissão para alterar a visibilidade da pasta',
    scanSkipped: 'Foram ignorados {{count}} ficheiros em pastas ocultas de não administradores',
  },
}
