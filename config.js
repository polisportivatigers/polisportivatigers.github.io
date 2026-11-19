/* Configurazione pubblica del progetto Firebase "quinto-tigers".
   Questi valori identificano il progetto e non sono segreti: la protezione è nelle regole di Firestore. */
window.QUINTO_FIREBASE = {
  apiKey: 'AIzaSyCtOp0HFW_rx6kuIk-lFxJCx2LLF1P7Fo0',
  authDomain: 'quinto-tigers.firebaseapp.com',
  projectId: 'quinto-tigers',
  storageBucket: 'quinto-tigers.firebasestorage.app',
  messagingSenderId: '118646812303',
  appId: '1:118646812303:web:4ca1e1f8c1c3e8c9bb0afa',
};

/* Postino delle notifiche (Cloudflare, piano gratuito). Anche questi valori sono pubblici: la chiave privata è solo su Cloudflare. */
window.QUINTO_PUSH = {
  url: 'https://quinto-push.quinto-tigers.workers.dev',
  vapid: 'BBKjsMkvYGedcnZ-eEyURnCGvBHo34cHTHzz5FW_zsXt-2WqWOQuEq9PGh-N7E5uqvI6T44QIdckgPiBroGyKKA',
};
