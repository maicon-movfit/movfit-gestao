// ======================== AUTH ========================
// ── Identidade oficial dos usuários ─────────────────────────────────────────
// campo 'nome' é a fonte oficial de exibição em toda a plataforma
// 'email' permanece apenas como identificador técnico / autenticação
const USUARIOS_CONFIG = {
  'ge.maiconoliveira@gmail.com':  { papel: 'admin', unidade: null,           nome: 'Maicon Oliveira' },
  'plucassayon@gmail.com':        { papel: 'rt',    unidade: 'premium24',    nome: 'Lucas Sayon' },
  'jssbarroslf@gmail.com':        { papel: 'rt',    unidade: 'premium24',    nome: 'Jéssica Barros' },
  'davidmodesto2015@hotmail.com': { papel: 'rt',    unidade: 'medicilandia', nome: 'David Modesto' },
  'elivelton.veto@gmail.com':     { papel: 'rt',    unidade: 'itaituba',     nome: 'Elivelton Veto' },
  'ludymylapsantos@gmail.com':    { papel: 'rt',    unidade: 'nrexpress',    nome: 'Ludymyla Santos' },
};

// Fallback: converte email em nome legível quando campo 'nome' não existe
// Usado SOMENTE como compatibilidade para dados históricos gravados sem nome
function formatarNomeDoEmail(email) {
  if(!email) return 'RT';
  return email.split('@')[0]
    .replace(/[._-]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

// Fonte oficial de nome para qualquer usuário (logado ou referenciado)
// Prioridade: nome cadastrado > displayName Firebase > formatação do email
// ── nomeParaId — normalização canônica de nome → ID de documento ───────────
// CRÍTICO: usada em TODO lugar que precisa transformar o nome de um professor
// em um ID de documento (colabId). Antes, cada ponto do código fazia essa
// conversão de forma própria com `.replace(/[^a-zA-Z0-9]/g,'_').toLowerCase()`,
// o que NÃO neutraliza acentos (Ã, Ç, etc viram "_") nem espaços duplicados —
// duas grafias levemente diferentes do mesmo nome (com/sem acento, espaço
// extra, maiúscula/minúscula) geravam DOIS perfis distintos no Firestore,
// cada um com seu próprio histórico de ciclos, PDI, conquistas e indicadores
// — fragmentando os dados do mesmo professor sem aviso nenhum.
// Esta função normaliza de forma determinística antes de gerar o ID:
// 1. remove acentos/diacríticos (NFD + remove marks)
// 2. converte para minúsculas
// 3. colapsa espaços múltiplos em um único
// 4. remove espaços nas pontas
// 5. troca qualquer caractere não alfanumérico por "_"
// 6. colapsa "_" repetidos em um único
function nomeParaId(nome) {
  if(!nome) return '_';
  return String(nome)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .trim()
    .replace(/\s+/g, ' ')          // colapsa espaços múltiplos
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')    // qualquer coisa que não seja letra/número vira _
    .replace(/_+/g, '_')           // colapsa underscores repetidos
    .replace(/^_+|_+$/g, '')       // remove _ nas pontas
    || '_';
}

function nomeExibicao(emailOuObj) {
  if(!emailOuObj) return 'RT';
  if(typeof emailOuObj === 'object') {
    return emailOuObj.nome || emailOuObj.displayName || formatarNomeDoEmail(emailOuObj.email);
  }
  // recebeu email string — buscar no config
  const cfg = USUARIOS_CONFIG[emailOuObj];
  if(cfg && cfg.nome) return cfg.nome;
  return formatarNomeDoEmail(emailOuObj);
}
