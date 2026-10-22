// ======================== FIREBASE CONFIG ========================
const firebaseConfig = {
  apiKey: "AIzaSyDfZ1_uxhjO_EPUWH4FK6JrUaHJLJHy3XM",
  authDomain: "mov-fit---gestao-de-carteira.firebaseapp.com",
  projectId: "mov-fit---gestao-de-carteira",
  storageBucket: "mov-fit---gestao-de-carteira.firebasestorage.app",
  messagingSenderId: "711045374561",
  appId: "1:711045374561:web:09455e9f3045cbd7900020"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();

// ── Offline persistence — Firebase SDK nativo ─────────────────────────────────
// Estratégia: Firebase SDK gerencia o cache IndexedDB automaticamente.
// "Server always wins" na resolução de conflitos — correto para o Pulso
// (um único RT por unidade; servidor é sempre a fonte de verdade).
db.enablePersistence({ synchronizeTabs: true }).catch(err => {
  // PersistenceUnavailableError: outro tab já é primário (multi-tab normal)
  // UnimplementedError: browser não suporta (Safari private / Firefox private)
  if (err.code === 'failed-precondition') {
    console.warn('[Pulso] Persistência offline: múltiplos tabs abertos. Apenas um sincroniza.');
  } else if (err.code === 'unimplemented') {
    console.warn('[Pulso] Persistência offline não disponível neste browser/modo.');
  }
  // Não é fatal — app funciona normalmente online
});
