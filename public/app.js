/* ==========================================================================
   Assistant liturgique — interface (JavaScript natif, aucune dépendance)

   CONTRAT D'API ATTENDU
   ---------------------
   Requête  : POST /api/generate
     En-têtes : Content-Type: application/json
                Accept: application/json
                X-Gemini-Api-Key: <clé personnelle facultative> (jamais dans le corps)
     Corps JSON (noms réglables dans FIELD_MAP ci-dessous) :
       { date: "AAAA-MM-JJ", celebration, tempsLiturgique, anneeLiturgique: "A"|"B"|"C",
         premiereLecture, deuxiemeLecture, evangile, textesBibliques, consignes }

   Réponse réussie : 200, application/json
     {
       "introductions": [ "texte 1", "texte 2" ],            // exactement 2
       "intentions":    [ "t1", "t2", "t3", "t4" ],          // exactement 4
       "qualityReport": "texte" | ["ligne", …] | {clé: valeur}, // facultatif
       "document": {                                          // une des deux formes
         "filename": "travail-liturgique.docx",
         "url": "/api/download/abc123"                        // même origine, renvoie le .docx
         // ou
         "base64": "UEsDBBQ…"                                 // contenu du .docx encodé en base64
       }
     }
   Les éléments des listes peuvent aussi être des objets { "text": "…" } ou { "texte": "…" }.

   Réponse en erreur : statut HTTP ≠ 2xx avec, idéalement, { "error": "message lisible" }.
   ========================================================================== */

(() => {
  'use strict';

  const pagePath = window.location.pathname.replace(/\/+$/, '') || '/';
  const pageName = pagePath === '/atelier' ? 'atelier' : pagePath === '/redaction' ? 'redaction' : pagePath === '/auth' ? 'auth' : 'home';
  document.body.classList.add(`page-${pageName}`);

  /* ---------- Configuration ---------- */
  const API_URL = '/api/generate';
  const KEY_HEADER = 'X-Gemini-Api-Key';
  const TIMEOUT_MS = 125000;
  const EXPECTED = { introductions: 2, intentions: 4 };
  const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const WORK_STORAGE_KEY = 'sjc-liturgie-works-v1';
  const MAX_SHARED_LINK = 18000;

  // Correspondance « champ du formulaire » -> « nom attendu par le backend ».
  // Modifiez uniquement la partie droite si votre serveur utilise d'autres noms.
  const FIELD_MAP = {
    date: 'date',
    celebration: 'celebration',
    tempsLiturgique: 'tempsLiturgique',
    anneeLiturgique: 'anneeLiturgique',
    premiereLecture: 'premiereLecture',
    deuxiemeLecture: 'deuxiemeLecture',
    evangile: 'evangile',
    textesBibliques: 'textesBibliques',
    consignes: 'consignes',
    ton: 'ton'
  };

  /* ---------- Personnalisation du site (à compléter) ---------- */
  // Numéro WhatsApp du créateur : format international, chiffres uniquement
  // (indicatif du pays + numéro, sans « + », sans espaces, sans tirets).
  // Laissé vide tant que le format n'est pas confirmé : le bouton reste alors inactif.
  const WHATSAPP_CREATOR_NUMBER = '229154806378';
  const WHATSAPP_PREFILLED_MESSAGE = 'Bonjour, je vous contacte au sujet de votre Assistant liturgique.';
  // Nom d'utilisateur Instagram exact (sans @ ni adresse complète).
  const INSTAGRAM_CREATOR_USERNAME = 'g_t_b_0';
  // Facultatifs : laissez vide pour conserver les emplacements génériques.
  const CREATOR_NAME = '';       // affiché à la place de « [À COMPLÉTER] »
  const CREATOR_PHOTO_URL = '';  // photo ou avatar du créateur (chemin ou URL https)
  const PARISH_LOGO_URL = '';    // logo officiel, uniquement avec l'autorisation de la paroisse

  const INTRO_TITLES = ['Introduction à la première lecture', 'Introduction à la deuxième lecture'];
  const LOADING_MESSAGES = [
    'Méditation des textes bibliques…',
    'Rédaction des introductions aux lectures…',
    'Composition des intentions de prière…',
    'Préparation du document Word…'
  ];

  /* ---------- Raccourcis DOM ---------- */
  const $ = (id) => document.getElementById(id);
  const form = $('liturgyForm');

  // AELF_AUTO_FILL_V1
  const dateInput = $('date');
  const freeDateInput = $('freeDate');
  const dateField = dateInput ? dateInput.closest('.field') : null;
  let lastAelfReadings = [];
  const aelfStatus = document.createElement('p');

  aelfStatus.id = 'aelfStatus';
  aelfStatus.setAttribute('role', 'status');
  aelfStatus.setAttribute('aria-live', 'polite');
  aelfStatus.style.marginTop = '8px';
  aelfStatus.style.fontSize = '0.9rem';

  if (dateField) dateField.appendChild(aelfStatus);

  let aelfRequestId = 0;

  function showAelfStatus(message, isError = false) {
    aelfStatus.textContent = message;
    aelfStatus.style.color = isError ? 'var(--danger, #b42318)' : '';
  }

  function setAelfField(name, value) {
    const field = form.elements[name];
    if (field && typeof value === 'string') {
      field.value = value;
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function selectLiturgicalYear(year) {
    if (!year) return;
    const radio = form.querySelector(
      'input[name="anneeLiturgique"][value="' + year + '"]'
    );
    if (radio) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function renderAelfReadings(data) {
    const metadata = [
      data.celebration,
      data.date ? formatDate(data.date) : '',
      data.tempsLiturgique || inferLiturgicalTime(data.celebration),
      data.anneeLiturgique ? 'Année ' + data.anneeLiturgique : ''
    ].filter(Boolean).join(' · ');
    $('aelfCelebrationMeta').textContent = metadata || 'Calendrier AELF chargé.';
    $('freeReadingsMeta').textContent = metadata || 'Calendrier AELF chargé.';
    lastAelfReadings = [
      ['Première lecture', data.premiereLecture, data.textePremiereLecture],
      ['Psaume', data.psaume, data.textePsaume],
      ['Deuxième lecture', data.deuxiemeLecture, data.texteDeuxiemeLecture],
      ['Évangile', data.evangile, data.texteEvangile]
    ].filter((item) => item[1]).map((item) => ({ label: item[0], reference: item[1], text: item[2] || '' }));

    paintAelfReadings(lastAelfReadings);
  }

  function paintAelfReadings(readings) {
    document.querySelectorAll('.aelf-reading-list').forEach((list) => {
      list.replaceChildren();
      if (!Array.isArray(readings) || !readings.length) {
        list.appendChild(el('p', '', 'Aucune lecture disponible pour cette date.'));
        return;
      }
      readings.forEach((reading) => {
        const card = el('article', 'aelf-reading');
        const heading = el('h5', '', reading.label + ' · ' + reading.reference);
        const body = el('p', '', reading.text || 'Le texte intégral n’est pas disponible dans la réponse AELF.');
        card.append(heading, body);
        list.appendChild(card);
      });
    });
  }

  async function loadAelfReadings(date) {
    if (!date) return;
    const requestId = ++aelfRequestId;
    $('freeReadingsMeta').textContent = 'Chargement du calendrier AELF…';
    document.querySelectorAll('.aelf-reading-list').forEach((list) => {
      list.replaceChildren(el('p', '', 'Chargement des lectures du calendrier AELF…'));
    });
    try {
      const response = await fetch('/api/liturgy?date=' + encodeURIComponent(date), {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000)
      });
      const data = await response.json();
      if (requestId !== aelfRequestId) return;
      if (!response.ok) throw new Error(data.error || 'Impossible de récupérer les lectures.');
      renderAelfReadings(data);
      if (data.celebration) $('freeTitle').value = data.celebration;
    } catch (error) {
      if (requestId !== aelfRequestId) return;
      $('freeReadingsMeta').textContent = error instanceof Error ? error.message : 'Erreur de chargement AELF.';
      document.querySelectorAll('.aelf-reading-list').forEach((list) => {
        list.replaceChildren(el('p', 'field__error', error instanceof Error ? error.message : 'Erreur de chargement AELF.'));
      });
    }
  }

  function inferLiturgicalTime(celebration) {
    const value = String(celebration || '').toLocaleLowerCase('fr');

    if (value.includes('avent')) return 'Avent';
    if (value.includes('carême')) return 'Carême';
    if (value.includes('triduum') || value.includes('vendredi saint')) return 'Triduum pascal';
    if (value.includes('pâques') || value.includes('pascal')) return 'Temps pascal';
    if (value.includes('noël') || value.includes('noel')) return 'Temps de Noël';
    if (value.includes('temps ordinaire')) return 'Temps ordinaire';

    return '';
  }

  if (dateInput) {
    dateInput.addEventListener('change', async () => {
      const date = dateInput.value;
      const requestId = ++aelfRequestId;

      if (!date) {
        showAelfStatus('');
        return;
      }

      showAelfStatus('Recherche des lectures dans le calendrier AELF…');

      try {
        const response = await fetch(
          '/api/liturgy?date=' + encodeURIComponent(date),
          {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(20000)
          }
        );

        const data = await response.json();

        if (requestId !== aelfRequestId) return;

        if (!response.ok) {
          throw new Error(data.error || 'Impossible de récupérer les lectures.');
        }

        setAelfField('celebration', data.celebration || '');
        setAelfField('premiereLecture', data.premiereLecture || '');
        setAelfField('deuxiemeLecture', data.deuxiemeLecture || '');
        setAelfField('evangile', data.evangile || '');
        if (freeDateInput) freeDateInput.value = date;
        renderAelfReadings(data);

        const liturgicalTime = data.tempsLiturgique || inferLiturgicalTime(data.celebration);
        if (liturgicalTime) setAelfField('tempsLiturgique', liturgicalTime);

        selectLiturgicalYear(data.anneeLiturgique || '');

        const readings = [
          ['Première lecture', data.premiereLecture, data.textePremiereLecture],
          ['Psaume', data.psaume, data.textePsaume],
          ['Deuxième lecture', data.deuxiemeLecture, data.texteDeuxiemeLecture],
          ['Évangile', data.evangile, data.texteEvangile]
        ]
          .filter(item => item[1])
          .map(item => item[0] + ' — ' + item[1] + (item[2] ? '\n' + item[2] : ''));

        setAelfField('textesBibliques', readings.join('\n\n'));

        if (!data.deuxiemeLectureDisponible) {
          showAelfStatus(
            'Calendrier récupéré, mais aucune deuxième lecture n’est indiquée pour cette date. Le format exige deux introductions : vérifie la célébration avant de générer.',
            true
          );
        } else {
          showAelfStatus('Lectures récupérées depuis l’AELF. Vérifie les informations avant de continuer.');
        }
      } catch (error) {
        if (requestId !== aelfRequestId) return;
        showAelfStatus(
          error instanceof Error ? error.message : 'Erreur lors de la récupération du calendrier.',
          true
        );
      }
    });
  }
  if (freeDateInput) {
    freeDateInput.addEventListener('change', () => loadAelfReadings(freeDateInput.value));
  }
  $('loadAelfBtn').addEventListener('click', () => {
    if (!dateInput.value) { showAelfStatus('Choisissez d’abord une date.', true); return; }
    dateInput.dispatchEvent(new Event('change', { bubbles: true }));
  });

  function moveToSunday(direction) {
    const date = dateInput.value ? new Date(dateInput.value + 'T12:00:00') : new Date();
    const day = date.getDay();
    const offset = direction < 0 ? (day === 0 ? -7 : -day) : (day === 0 ? 7 : 7 - day);
    date.setDate(date.getDate() + offset);
    const localIso = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
    dateInput.value = localIso;
    if (freeDateInput) freeDateInput.value = localIso;
    dateInput.dispatchEvent(new Event('change', { bubbles: true }));
  }
  $('prevSunday').addEventListener('click', () => moveToSunday(-1));
  $('nextSunday').addEventListener('click', () => moveToSunday(1));
  function moveFreeToSunday(direction) {
    const date = freeDateInput.value ? new Date(freeDateInput.value + 'T12:00:00') : new Date();
    const day = date.getDay();
    date.setDate(date.getDate() + (direction < 0 ? (day === 0 ? -7 : -day) : (day === 0 ? 7 : 7 - day)));
    freeDateInput.value = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
    loadAelfReadings(freeDateInput.value);
  }
  $('freePrevSunday').addEventListener('click', () => moveFreeToSunday(-1));
  $('freeNextSunday').addEventListener('click', () => moveFreeToSunday(1));

  const steps = Array.from(document.querySelectorAll('.step'));
  const prevBtn = $('prevBtn');
  const nextBtn = $('nextBtn');
  const generateBtn = $('generateBtn');
  const keyInput = $('geminiKey');
  const personalKeyFallback = $('personalKeyFallback');
  let serverKeyConfigured = false;
  let serverStatusChecked = false;
  let cloudSyncConfigured = false;
  let authMode = 'login';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    step: 1,
    busy: false,
    controller: null,
    result: null,
    loadingTimer: null
  };
  let currentWorkId = null;
/* ---------- Utilitaires ---------- */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Retire toute trace de la clé d'un message avant affichage.
  function scrub(message) {
    let out = String(message == null ? '' : message);
    const key = keyInput.value.trim();
    if (key.length >= 8) out = out.split(key).join('[clé masquée]');
    out = out.replace(/AIza[0-9A-Za-z_\-]{10,}/g, '[clé masquée]');
    return out.length > 400 ? out.slice(0, 400) + '…' : out;
  }

  fetch('/api/health', { headers: { Accept: 'application/json' }, cache: 'no-store' })
    .then((response) => response.json())
    .then((data) => {
      serverKeyConfigured = Boolean(data && (data.geminiConfigured || (data.providers && data.providers.length)));
      cloudSyncConfigured = Boolean(data && data.cloudSyncConfigured);
      if (cloudSyncConfigured && authToken()) loadCloudWorks();
      serverStatusChecked = true;
      const status = $('serviceStatusText');
      const providerNames = data?.providers?.length ? data.providers.join(' → ') : 'mode local de secours';
      if (status) status.textContent = `Génération disponible : ${providerNames}. Aucune clé personnelle requise.`;
      if (personalKeyFallback) personalKeyFallback.hidden = false;
      keyInput.placeholder = serverKeyConfigured
        ? 'Facultatif : utiliser une autre clé'
        : 'Facultatif : clé Gemini personnelle';
      if (!cloudSyncConfigured) $('authDescription').textContent = 'La bibliothèque de cet appareil fonctionne sans compte. Pour la retrouver partout, activez la synchronisation partagée avec les paramètres Supabase indiqués dans le README.';
    })
    .catch(() => {
      serverStatusChecked = true;
      const status = $('serviceStatusText');
      if (status) status.textContent = 'Impossible de vérifier le service. Vous pouvez essayer une clé personnelle en dépannage.';
      if (personalKeyFallback) personalKeyFallback.hidden = false;
    });

  function toast(message, type = 'info', duration = 4500) {
    const box = el('div', 'toast toast--' + type, scrub(message));
    $('toasts').appendChild(box);
    window.setTimeout(() => {
      box.classList.add('is-leaving');
      window.setTimeout(() => box.remove(), 320);
    }, duration);
  }

  /* ---------- Connexion facultative et bibliothèque partagée ---------- */
  const AUTH_TOKEN_KEY = 'sjc-liturgie-session-v1';
  const AUTH_REFRESH_KEY = 'sjc-liturgie-refresh-v1';
  const authDialog = $('authDialog');
  const authToken = () => sessionStorage.getItem(AUTH_TOKEN_KEY) || '';
  function showAuthMessage(message, isError = false) {
    const status = $('authStatus');
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  }
  function updateAuthControls() {
    const signedIn = Boolean(authToken());
    $('authOpenBtn').hidden = signedIn;
    $('authLogoutBtn').hidden = !signedIn;
    $('heroSignInBtn').hidden = signedIn;
    $('heroLogoutBtn').hidden = !signedIn;
    const summary = document.querySelector('.saved-works > summary');
    if (summary) summary.firstChild.textContent = signedIn ? 'Travaux du groupe ' : 'Mes travaux enregistrés ';
    $('heroWorkCount').textContent = $('savedWorkCount').textContent;
  }
  async function cloudRequest(route, options = {}) {
    if (!authToken()) throw new Error('Connectez-vous pour synchroniser les travaux.');
    const request = (token) => fetch(route, {
      ...options,
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}`, ...(options.headers || {}) },
      credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000)
    });
    let response = await request(authToken());
    if (response.status === 401 && sessionStorage.getItem(AUTH_REFRESH_KEY)) {
      try {
        const refreshResponse = await fetch('/api/auth/refresh', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ refreshToken: sessionStorage.getItem(AUTH_REFRESH_KEY) }), cache: 'no-store'
        });
        const refreshed = await readJsonSafely(refreshResponse);
        if (refreshResponse.ok && refreshed?.accessToken) {
          sessionStorage.setItem(AUTH_TOKEN_KEY, refreshed.accessToken);
          if (refreshed.refreshToken) sessionStorage.setItem(AUTH_REFRESH_KEY, refreshed.refreshToken);
          response = await request(refreshed.accessToken);
        }
      } catch { /* L'erreur de session est traitée par la réponse initiale. */ }
    }
    const data = await readJsonSafely(response);
    if (!response.ok) {
      if (response.status === 401) { sessionStorage.removeItem(AUTH_TOKEN_KEY); sessionStorage.removeItem(AUTH_REFRESH_KEY); updateAuthControls(); }
      throw new Error(data?.error || 'La synchronisation en ligne a échoué.');
    }
    return data;
  }
  async function loadCloudWorks() {
    if (!authToken()) return;
    try {
      const { works = [] } = await cloudRequest('/api/works');
      const combined = new Map();
      works.forEach((work) => { if (validWork(work)) combined.set(work.id, work); });
      readLibrary().forEach((work) => {
        if (!validWork(work)) return;
        const current = combined.get(work.id);
        if (!current || Date.parse(work.updatedAt || '') > Date.parse(current.updatedAt || '')) combined.set(work.id, work);
      });
      writeLibrary([...combined.values()]);
      renderSavedWorks();
      toast(`${works.length} travail(aux) récupéré(s) depuis la bibliothèque partagée.`, 'success');
    } catch (error) { toast(error.message, 'error', 6000); }
  }
  async function syncCloudWork(work) {
    if (!authToken()) return;
    try {
      await cloudRequest('/api/works', { method: 'POST', body: JSON.stringify({ work }) });
      toast('Travail enregistré dans la bibliothèque partagée.', 'success');
    } catch (error) { toast(`Copie locale conservée ; synchronisation en ligne impossible : ${error.message}`, 'error', 6500); }
  }
  $('authOpenBtn').addEventListener('click', () => {
    authMode = 'login';
    $('authTitle').textContent = 'Se connecter';
    $('authSubmitBtn').textContent = 'Se connecter';
    $('authModeToggle').textContent = 'Créer un compte';
    $('authDescription').textContent = cloudSyncConfigured
      ? 'Connectez-vous pour retrouver et partager les travaux du groupe sur plusieurs appareils.'
      : 'La connexion en ligne sera disponible après configuration de Supabase ; la bibliothèque locale fonctionne déjà sans compte.';
    showAuthMessage(cloudSyncConfigured ? '' : 'Synchronisation en ligne non configurée. Consultez le README pour l’activer.');
    authDialog.showModal();
  });
  $('authCloseBtn').addEventListener('click', () => authDialog.close());
  $('authModeToggle').addEventListener('click', () => {
    authMode = authMode === 'login' ? 'signup' : 'login';
    $('authTitle').textContent = authMode === 'login' ? 'Se connecter' : 'Créer un compte';
    $('authSubmitBtn').textContent = authMode === 'login' ? 'Se connecter' : 'Créer mon compte';
    $('authModeToggle').textContent = authMode === 'login' ? 'Créer un compte' : 'J’ai déjà un compte';
    $('authPassword').autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
    showAuthMessage('');
  });
  $('authForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!cloudSyncConfigured) { showAuthMessage('La connexion en ligne n’est pas configurée. La bibliothèque locale reste disponible.'); return; }
    const submit = $('authSubmitBtn');
    submit.disabled = true;
    showAuthMessage('Connexion en cours…');
    try {
      const response = await fetch(`/api/auth/${authMode}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email: $('authEmail').value, password: $('authPassword').value }),
        credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000)
      });
      const data = await readJsonSafely(response);
      if (!response.ok) throw new Error(data?.error || 'Connexion refusée.');
      if (!data.accessToken) { showAuthMessage('Compte créé. Vérifiez votre boîte e-mail pour confirmer l’adresse, puis connectez-vous.'); return; }
      sessionStorage.setItem(AUTH_TOKEN_KEY, data.accessToken);
      if (data.refreshToken) sessionStorage.setItem(AUTH_REFRESH_KEY, data.refreshToken);
      updateAuthControls();
      authDialog.close();
      $('authPassword').value = '';
      if (pageName === 'auth') { window.location.href = '/atelier'; return; }
      await loadCloudWorks();
    } catch (error) { showAuthMessage(error.message || 'Connexion impossible.', true); }
    finally { submit.disabled = false; }
  });
  $('authLogoutBtn').addEventListener('click', () => {
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
    sessionStorage.removeItem(AUTH_REFRESH_KEY);
    updateAuthControls();
    toast('Vous êtes déconnecté. Les travaux déjà enregistrés dans ce navigateur restent disponibles.');
  });
  $('heroLogoutBtn').addEventListener('click', () => { $('authLogoutBtn').click(); window.location.href = '/'; });
  $('heroMyWorksBtn').addEventListener('click', () => {
    const library = $('savedWorks');
    library.open = true;
    library.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
  });
  updateAuthControls();

  /* ---------- Thème ---------- */
  const themeBtn = $('themeToggle');
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const dark = theme === 'dark';
    themeBtn.setAttribute('aria-pressed', String(dark));
    themeBtn.setAttribute('aria-label', dark ? 'Passer au thème clair' : 'Passer au thème sombre');
  }
  (function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem('al-theme'); } catch (e) { /* stockage indisponible */ }
    applyTheme(saved || 'light');
  })();
  themeBtn.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('al-theme', next); } catch (e) { /* ignoré */ }
  });

  /* ---------- Menu mobile ---------- */
  const navToggle = $('navToggle');
  const nav = $('mainNav');
  function setNav(open) {
    nav.classList.toggle('is-open', open);
    navToggle.setAttribute('aria-expanded', String(open));
    navToggle.setAttribute('aria-label', open ? 'Fermer le menu' : 'Ouvrir le menu');
  }
  navToggle.addEventListener('click', () => setNav(!nav.classList.contains('is-open')));
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) setNav(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setNav(false); });

  /* ---------- Apparition au défilement ---------- */
  const revealEls = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !reduceMotion) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) { entry.target.classList.add('is-visible'); io.unobserve(entry.target); }
      });
    }, { threshold: 0.12 });
    revealEls.forEach((node) => io.observe(node));
  } else {
    revealEls.forEach((node) => node.classList.add('is-visible'));
  }

  /* ---------- Lien actif dans la navigation ---------- */
  if ('IntersectionObserver' in window) {
    const links = Array.from(document.querySelectorAll('.nav__link'));
    const spy = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        links.forEach((a) => a.classList.toggle('is-active', a.getAttribute('href') === '#' + entry.target.id));
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    ['accueil', 'preparer', 'fonctionnalites', 'communaute', 'a-propos'].forEach((id) => { const s = $(id); if (s) spy.observe(s); });
  }

  /* ---------- Étapes et validation ---------- */
  const STEP_NAMES = { 1: 'Célébration', 2: 'Références bibliques', 3: 'Personnalisation', 4: 'Génération' };

  function showStep(n, back = false, moveFocus = true) {
    state.step = n;
    steps.forEach((s) => {
      const active = Number(s.dataset.step) === n;
      s.hidden = !active;
      s.classList.toggle('is-active', active);
      s.classList.toggle('is-back', active && back);
    });
    const pct = n * 25;
    $('progressFill').style.width = pct + '%';
    $('progressBar').setAttribute('aria-valuenow', String(pct));
    $('progressLabel').textContent = 'Étape ' + n + ' sur 4';
    $('progressName').textContent = STEP_NAMES[n];
    document.querySelectorAll('.progress__steps li').forEach((li) => {
      const dot = Number(li.dataset.dot);
      li.classList.toggle('is-current', dot === n);
      li.classList.toggle('is-done', dot < n);
    });
    prevBtn.disabled = n === 1 || state.busy;
    nextBtn.hidden = n === 4;
    generateBtn.hidden = n !== 4;
    const heading = steps[n - 1].querySelector('h3');
    if (heading && moveFocus && !state.busy) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
  }

  function setFieldError(control, message) {
    const id = control.name || control.id;
    const err = $('err-' + id);
    const radios = control.type === 'radio';
    const targets = radios ? form.querySelectorAll('input[name="' + control.name + '"]') : [control];
    targets.forEach((t) => {
      if (message) t.setAttribute('aria-invalid', 'true'); else t.removeAttribute('aria-invalid');
    });
    if (err) { err.textContent = message || ''; err.hidden = !message; }
  }

  function validateStep(n) {
    const panel = steps[n - 1];
    let firstInvalid = null;
    const seenRadios = new Set();

    panel.querySelectorAll('input[required], select[required], textarea[required]').forEach((control) => {
      let message = '';
      if (control.type === 'radio') {
        if (seenRadios.has(control.name)) return;
        seenRadios.add(control.name);
        const chosen = form.querySelector('input[name="' + control.name + '"]:checked');
        if (!chosen) message = 'Veuillez choisir une option.';
      } else if (!control.value.trim()) {
        message = 'Ce champ est obligatoire.';
      }
      setFieldError(control, message);
      if (message && !firstInvalid) firstInvalid = control;
    });

    if (n === 4) {
      const message = validateKey();
      setFieldError(keyInput, message);
      if (message && !firstInvalid) firstInvalid = keyInput;
    }

    if (firstInvalid) { firstInvalid.focus(); return false; }
    return true;
  }

  // Contrôle de forme uniquement : ne prouve pas que la clé soit valide.
  function validateKey() {
    const key = keyInput.value.trim();
    if (!key) return '';
    if (key.length < 20 || !/^[\x21-\x7E]+$/.test(key)) return 'Le format de la clé semble incorrect (caractères ou longueur).';
    return '';
  }

  // Effacer l'erreur dès que l'utilisateur corrige
  form.addEventListener('input', (e) => {
    const t = e.target;
    if (t && t.getAttribute && t.getAttribute('aria-invalid') === 'true') {
      if (t === keyInput) { if (!validateKey()) setFieldError(t, ''); }
      else if (t.value && t.value.trim()) setFieldError(t, '');
    }
  });
  form.addEventListener('change', (e) => {
    if (e.target.type === 'radio') setFieldError(e.target, '');
  });

  function goNext() { if (validateStep(state.step)) showStep(Math.min(4, state.step + 1)); }
  function goPrev() { showStep(Math.max(1, state.step - 1), true); }
  nextBtn.addEventListener('click', goNext);
  prevBtn.addEventListener('click', goPrev);

  /* ---------- Clé API : affichage, effacement ---------- */
  $('keyToggle').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const show = keyInput.type === 'password';
    keyInput.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(show));
    $('keyToggleLabel').textContent = show ? 'Masquer' : 'Afficher';
  });
  $('keyClear').addEventListener('click', () => {
    keyInput.value = '';
    keyInput.type = 'password';
    $('keyToggle').setAttribute('aria-pressed', 'false');
    $('keyToggleLabel').textContent = 'Afficher';
    setFieldError(keyInput, '');
    keyInput.focus();
    toast('Clé effacée de ce formulaire.', 'info', 2800);
  });

  /* ---------- Vues ---------- */
  const views = { form: $('formView'), free: $('freeWritingView'), loading: $('loadingView'), results: $('resultsView') };
  function showView(name) {
    Object.keys(views).forEach((k) => { views[k].hidden = k !== name; });
    const target = name === 'form' || name === 'free' ? $('preparer') : views[name];
    if (target) target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }

  function setBusy(busy) {
    state.busy = busy;
    generateBtn.disabled = busy;
    nextBtn.disabled = busy;
    prevBtn.disabled = busy || state.step === 1;
    form.setAttribute('aria-busy', String(busy));
  }

  function showFormError(message, title) {
    $('formErrorTitle').textContent = title || 'La génération a échoué';
    $('formErrorText').textContent = scrub(message);
    $('formError').hidden = false;
  }
  function clearFormError() { $('formError').hidden = true; $('formErrorText').textContent = ''; }

  /* ---------- Chargement ---------- */
  function startLoadingMessages() {
    let i = 0;
    const msg = $('loadingMessage');
    msg.textContent = LOADING_MESSAGES[0];
    window.clearInterval(state.loadingTimer);
    state.loadingTimer = window.setInterval(() => {
      i = Math.min(i + 1, LOADING_MESSAGES.length - 1);
      msg.textContent = LOADING_MESSAGES[i];
    }, 7000);
  }
  function stopLoadingMessages() { window.clearInterval(state.loadingTimer); }

  /* ---------- Envoi au serveur ---------- */
  function buildPayload() {
    const payload = {};
    Object.keys(FIELD_MAP).forEach((formName) => {
      const field = form.elements[formName];
      let value = '';
      if (field && field.length !== undefined && field.type === undefined) {
        const chosen = form.querySelector('input[name="' + formName + '"]:checked');
        value = chosen ? chosen.value : '';
      } else if (field) {
        value = String(field.value || '').trim();
      }
      payload[FIELD_MAP[formName]] = value;
    });
    return payload;
  }

  async function readJsonSafely(response) {
    const type = (response.headers.get('content-type') || '').toLowerCase();
    if (!type.includes('json')) return null;
    try { return await response.json(); } catch (e) { return null; }
  }

  function errorFromStatus(status, serverMessage) {
    const fromServer = serverMessage ? scrub(serverMessage) : '';
    if (status === 400 || status === 422) return fromServer || 'Les informations envoyées ne sont pas acceptées par le serveur. Vérifiez le formulaire.';
    if (status === 401 || status === 403) return fromServer || 'La requête a été refusée. Vérifiez votre clé Gemini et ses autorisations.';
    if (status === 404) return 'Le service de génération est introuvable. Le serveur est-il démarré ?';
    if (status === 408 || status === 504) return 'Le serveur a mis trop de temps à répondre. Réessayez dans un instant.';
    if (status === 413) return 'Les textes envoyés sont trop volumineux. Réduisez le champ des textes bibliques.';
    if (status === 429) return fromServer || 'Le quota ou la limite de requêtes Gemini est atteint. Réessayez plus tard.';
    if (status >= 500) return fromServer || 'Le serveur a rencontré une erreur pendant la génération.';
    return fromServer || 'Erreur inattendue (code ' + status + ').';
  }

  function itemText(item) {
    if (typeof item === 'string') return item.trim();
    if (item && typeof item === 'object') {
      const v = item.text !== undefined ? item.text : item.texte;
      if (typeof v === 'string') return v.trim();
    }
    return '';
  }

  // Valide strictement la réponse : exactement 2 introductions et 4 intentions, non vides.
  function parseResult(data) {
    if (!data || typeof data !== 'object') throw new Error('La réponse du serveur est vide ou illisible.');
    if (data.ok === false || data.error) throw new Error(data.error || 'Le serveur a signalé une erreur de génération.');
    const intros = Array.isArray(data.introductions) ? data.introductions.map(itemText) : [];
    const intentions = Array.isArray(data.intentions) ? data.intentions.map(itemText) : [];
    if (intros.length !== EXPECTED.introductions || intros.some((t) => !t)) {
      throw new Error('La réponse du serveur ne contient pas exactement ' + EXPECTED.introductions + ' introductions aux lectures.');
    }
    if (intentions.length !== EXPECTED.intentions || intentions.some((t) => !t)) {
      throw new Error('La réponse du serveur ne contient pas exactement ' + EXPECTED.intentions + ' intentions de prière universelle.');
    }
    const doc = data.document && typeof data.document === 'object' ? data.document : null;
    const hasDoc = !!(doc && (typeof doc.base64 === 'string' && doc.base64 || typeof doc.url === 'string' && doc.url));
    return { intros, intentions, doc: hasDoc ? doc : null, quality: data.qualityReport };
  }

  async function generate() {
    clearFormError();
    for (let n = 1; n <= 4; n += 1) {
      if (!validateStep(n)) { showStep(n); validateStep(n); return; }
    }
    if (state.busy) return;

    const payload = buildPayload();
    const controller = new AbortController();
    state.controller = controller;
    let timedOut = false;
    const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);

    setBusy(true);
    startLoadingMessages();
    showView('loading');

    try {
      const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
      if (keyInput.value.trim()) headers[KEY_HEADER] = keyInput.value.trim();

      const response = await fetch(API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
        credentials: 'same-origin',
        cache: 'no-store'
      });

      const data = await readJsonSafely(response);
      if (!response.ok) {
        throw new Error(errorFromStatus(response.status, data && (data.error || data.message)));
      }
      if (data === null) throw new Error('Le serveur n\'a pas renvoyé de JSON. Vérifiez la réponse de /api/generate.');

      const result = parseResult(data);
      state.result = Object.assign(result, {
        title: payload[FIELD_MAP.celebration] || '',
        date: payload[FIELD_MAP.date] || '',
        tone: payload[FIELD_MAP.ton] || '',
        welcome: '',
        readings: lastAelfReadings,
        references: [payload[FIELD_MAP.premiereLecture], payload[FIELD_MAP.deuxiemeLecture]]
      });
      currentWorkId = null;
      renderResults(state.result);
      showView('results');
      toast('Génération terminée.', 'success');
    } catch (err) {
      let message;
      if (err && err.name === 'AbortError') {
        message = timedOut
          ? 'Délai dépassé : le serveur n\'a pas répondu à temps. Réessayez.'
          : 'Génération annulée.';
      } else if (err instanceof TypeError) {
        message = 'Impossible de joindre le serveur. Vérifiez qu\'il est démarré et que vous êtes connecté.';
      } else {
        message = (err && err.message) || 'Une erreur inattendue est survenue.';
      }
      showView('form');
      showStep(4);
      showFormError(message, timedOut ? 'Délai dépassé' : 'La génération a échoué');
      toast(message, 'error', 7000);
    } finally {
      window.clearTimeout(timer);
      stopLoadingMessages();
      state.controller = null;
      setBusy(false);
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.step < 4) { goNext(); return; }
    generate();
  });
  $('cancelBtn').addEventListener('click', () => { if (state.controller) state.controller.abort(); });

  /* ---------- Rendu des résultats (textContent uniquement) ---------- */
  function buildCard(title, text, variant, iconId, delayMs, collection, index) {
    const node = $('resultCardTpl').content.firstElementChild.cloneNode(true);
    node.classList.add('result-card--' + variant);
    node.style.animationDelay = delayMs + 'ms';
    node.querySelector('.result-card__title').textContent = title;
    const editor = node.querySelector('.result-card__text');
    editor.value = text;
    editor.setAttribute('aria-label', title + ' — texte modifiable');
    editor.addEventListener('input', () => {
      if (!state.result) return;
      if (collection === 'psalmIntro' || collection === 'conclusion') state.result[collection] = editor.value;
      else if (state.result[collection]) state.result[collection][index] = editor.value;
    });
    node.querySelector('[data-icon]').appendChild($(iconId).content.cloneNode(true));
    const copyBtn = node.querySelector('[data-copy]');
    copyBtn.setAttribute('aria-label', 'Copier : ' + title);
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(editor.value);
      flashCopied(copyBtn, ok);
    });
    const rewrite = el('details', 'rewrite-controls');
    const summary = el('summary', '', 'Réécrire avec une consigne');
    const instruction = el('textarea', 'rewrite-controls__instruction');
    instruction.rows = 2;
    instruction.maxLength = 1000;
    instruction.placeholder = 'Ex. Simplifier le vocabulaire et raccourcir la phrase…';
    const rewriteBtn = el('button', 'btn btn--outline', 'Proposer une nouvelle version');
    rewriteBtn.type = 'button';
    rewriteBtn.addEventListener('click', () => rewritePassage(collection, index, editor, instruction, rewriteBtn));
    rewrite.append(summary, instruction, rewriteBtn);
    node.appendChild(rewrite);
    return node;
  }

  async function rewritePassage(collection, index, editor, instruction, button) {
    if (!state.result || !editor.value.trim()) { toast('Écrivez d’abord un texte à réécrire.', 'error'); return; }
    button.disabled = true;
    const oldLabel = button.textContent;
    button.textContent = 'Réécriture en cours…';
    try {
      const reference = collection === 'intros' && state.result.references
        ? state.result.references[index] || '' : '';
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (keyInput.value.trim()) headers[KEY_HEADER] = keyInput.value.trim();
      const response = await fetch('/api/rewrite', {
        method: 'POST', headers,
        body: JSON.stringify({ kind: collection === 'intentions' ? 'intention' : 'introduction', content: editor.value, instruction: instruction.value, reference }),
        signal: AbortSignal.timeout(90000), credentials: 'same-origin', cache: 'no-store'
      });
      const data = await readJsonSafely(response);
      if (!response.ok) throw new Error(errorFromStatus(response.status, data && data.error));
      if (!data || typeof data.text !== 'string' || !data.text.trim()) throw new Error('Gemini n’a pas renvoyé de nouvelle version.');
      editor.value = data.text.trim();
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      toast(data.degraded
        ? 'Aucune IA disponible : le texte original a été conservé. Réessayez la réécriture lorsque la connexion revient.'
        : `Nouvelle version proposée${data.provider ? ` par ${data.provider}` : ''}. Vérifiez-la avant de la garder.`, data.degraded ? 'info' : 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'La réécriture a échoué.', 'error', 6000);
    } finally {
      button.disabled = false; button.textContent = oldLabel;
    }
  }

  function formatDate(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
    const d = new Date(iso + 'T12:00:00');
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  function renderResults(res) {
    $('resDate').textContent = formatDate(res.date);
    $('resTitle').textContent = res.title;

    const introGrid = $('introGrid');
    const intentionGrid = $('intentionGrid');
    introGrid.replaceChildren();
    intentionGrid.replaceChildren();

    if (res.intros[0]) introGrid.appendChild(buildCard(INTRO_TITLES[0], res.intros[0], 'wine', 'iconBook', 0, 'intros', 0));
    if (res.psalmIntro) introGrid.appendChild(buildCard('Introduction au psaume', res.psalmIntro, 'gold', 'iconBook', 80, 'psalmIntro', 0));
    if (res.intros[1]) introGrid.appendChild(buildCard(INTRO_TITLES[1], res.intros[1], 'violet', 'iconBook', 160, 'intros', 1));
    if (res.conclusion) introGrid.appendChild(buildCard('Mot de conclusion', res.conclusion, 'wine', 'iconBook', 240, 'conclusion', 0));
    res.intentions.forEach((text, i) => {
      intentionGrid.appendChild(buildCard('Intention ' + (i + 1), text, 'gold', 'iconPrayer', 220 + i * 90, 'intentions', i));
    });

    // Document Word
    $('downloadBtn').hidden = false;
    $('docReadyText').textContent = 'Vous pouvez corriger chaque texte, enregistrer le travail, l’imprimer ou l’exporter en Word.';
    lastAelfReadings = Array.isArray(res.readings) ? res.readings : [];
    paintAelfReadings(lastAelfReadings);

    // Rapport de qualité : affiché seulement s'il est fourni par le serveur.
    renderQuality(res.quality);
  }

  function qualityLines(value, prefix) {
    const out = [];
    if (value == null || value === '') return out;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out.push((prefix ? prefix + ' : ' : '') + String(value));
    } else if (Array.isArray(value)) {
      value.forEach((v) => out.push(...qualityLines(v, prefix)));
    } else if (typeof value === 'object') {
      Object.keys(value).forEach((k) => out.push(...qualityLines(value[k], k)));
    }
    return out;
  }
  function renderQuality(report) {
    const list = $('qualityList');
    list.replaceChildren();
    const lines = qualityLines(report).slice(0, 40);
    lines.forEach((line) => list.appendChild(el('li', '', line)));
    $('qualityBox').hidden = lines.length === 0;
  }

  /* ---------- Copie ---------- */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* repli ci-dessous */ }
    try {
      const area = el('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch (e) { return false; }
  }

  function flashCopied(btn, ok) {
    if (!ok) { toast('La copie a échoué. Sélectionnez le texte manuellement.', 'error', 5000); return; }
    const label = btn.querySelector('.copy-btn__label');
    btn.classList.add('is-copied');
    if (label) label.textContent = 'Copié';
    window.setTimeout(() => {
      btn.classList.remove('is-copied');
      if (label) label.textContent = 'Copier';
    }, 1800);
  }

  $('copyAllBtn').addEventListener('click', async (e) => {
    const res = state.result;
    if (!res) return;
    const parts = [];
    if (res.title) parts.push(res.title, '');
    if (res.welcome) parts.push('MOT D’ACCUEIL', res.welcome, '');
    parts.push('INTRODUCTIONS AUX LECTURES', '');
    if (res.intros[0]) parts.push(INTRO_TITLES[0], res.intros[0], '');
    if (res.psalmIntro) parts.push('Introduction au psaume', res.psalmIntro, '');
    if (res.intros[1]) parts.push(INTRO_TITLES[1], res.intros[1], '');
    parts.push('PRIÈRE UNIVERSELLE', '');
    res.intentions.forEach((t, i) => parts.push('Intention ' + (i + 1), t, ''));
    if (res.conclusion) parts.push('MOT DE CONCLUSION', res.conclusion, '');
    const ok = await copyText(parts.join('\n').trim());
    const label = e.currentTarget.querySelector('span');
    if (ok) {
      toast('Tous les textes ont été copiés.', 'success', 3000);
      if (label) { label.textContent = 'Copié'; window.setTimeout(() => { label.textContent = 'Tout copier'; }, 1800); }
    } else {
      toast('La copie a échoué. Sélectionnez les textes manuellement.', 'error', 5000);
    }
  });

  /* ---------- Téléchargement du document Word ---------- */
  function base64ToBlob(b64, mime) {
    const clean = b64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function safeFilename(name) {
    let base = String(name || 'travail-liturgique.docx').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim();
    if (!/\.docx$/i.test(base)) base += '.docx';
    return base || 'travail-liturgique.docx';
  }

  $('downloadBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const work = state.result;
    if (!work) { toast('Aucun travail à exporter.', 'error'); return; }
    btn.disabled = true;
    try {
      const response = await fetch('/api/export-docx', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ title: work.title, date: work.date, tone: work.tone, welcome: work.welcome, introductions: work.intros, psalmIntro: work.psalmIntro || '', conclusion: work.conclusion || '', intentions: work.intentions, readings: work.readings || [] }),
        credentials: 'same-origin', cache: 'no-store'
      });
      const data = await readJsonSafely(response);
      if (!response.ok) throw new Error(errorFromStatus(response.status, data && data.error));
      const doc = data && data.document;
      if (!doc || !doc.base64) throw new Error('Le serveur n’a pas fourni le document Word.');
      const file = base64ToBlob(doc.base64, doc.mimeType || DOCX_MIME);
      if (!file.size) throw new Error('Le document reçu est vide.');
      const url = URL.createObjectURL(file);
      const link = el('a');
      link.href = url;
      link.download = safeFilename(doc.filename || work.title + '.docx');
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast('Le document Word à jour a été créé et téléchargé.', 'success');
    } catch (err) {
      toast((err && err.message) || 'Le téléchargement a échoué.', 'error', 7000);
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------- Rédaction libre, travaux enregistrés et partage ---------- */
  function readLibrary() {
    try {
      const value = JSON.parse(localStorage.getItem(WORK_STORAGE_KEY) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (e) { return []; }
  }

  function writeLibrary(items) {
    try { localStorage.setItem(WORK_STORAGE_KEY, JSON.stringify(items.slice(0, 80))); return true; }
    catch (e) { toast('Le stockage de ce navigateur est plein ou indisponible. Exportez vos travaux pour les conserver.', 'error', 6000); return false; }
  }

  function validWork(value) {
    return value && typeof value === 'object' && typeof value.title === 'string' &&
      Array.isArray(value.intros) && value.intros.length === 2 &&
      Array.isArray(value.intentions) && value.intentions.length >= 4 && value.intentions.length <= 20;
  }

  function currentFreeWork() {
    const text = $('freeFullText').value.trim();
    const sectionNames = {
      welcome: 'MOT D’ACCUEIL', intro1: 'INTRODUCTION À LA PREMIÈRE LECTURE',
      psalmIntro: 'INTRODUCTION AU PSAUME', intro2: 'INTRODUCTION À LA DEUXIÈME LECTURE',
      prayer: 'PRIÈRE UNIVERSELLE', conclusion: 'MOT DE CONCLUSION'
    };
    const sections = {};
    const normalizedNames = new Map(Object.entries(sectionNames).map(([key, heading]) => [heading.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, "'").toUpperCase(), key]));
    let active = '';
    text.split(/\r?\n/).forEach((line) => {
      const normalized = line.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, "'").toUpperCase();
      if (normalizedNames.has(normalized)) { active = normalizedNames.get(normalized); sections[active] = []; }
      else if (active) sections[active].push(line);
    });
    const get = (key) => (sections[key] || []).join('\n').trim();
    const prayerBlocks = get('prayer').split(/(?=^\s*\d+[.)]\s*)/m).map((part) => part.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
    while (prayerBlocks.length < 4) prayerBlocks.push('');
    const first = lastAelfReadings.find((reading) => reading.label === 'Première lecture');
    const second = lastAelfReadings.find((reading) => reading.label === 'Deuxième lecture');
    const intros = [get('intro1'), get('intro2')];
    if (!intros.some(Boolean) && text && !Object.keys(sections).length) intros[0] = text;
    return {
      title: $('freeTitle').value.trim() || 'Travail liturgique',
      date: $('freeDate').value,
      welcome: get('welcome'),
      intros,
      psalmIntro: get('psalmIntro'),
      conclusion: get('conclusion'),
      intentions: prayerBlocks.slice(0, 20),
      freeText: text,
      readings: lastAelfReadings,
      tone: 'Rédaction libre',
      references: [first?.reference || '', second?.reference || '']
    };
  }

  function insertFreeText(text) {
    const field = $('freeFullText');
    field.focus();
    const start = Number.isInteger(field.selectionStart) ? field.selectionStart : field.value.length;
    const end = Number.isInteger(field.selectionEnd) ? field.selectionEnd : start;
    const prefix = start > 0 && field.value[start - 1] !== '\n' ? '\n' : '';
    const suffix = end < field.value.length && field.value[end] !== '\n' ? '\n' : '';
    field.setRangeText(prefix + text + suffix, start, end, 'end');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const freeTextTemplates = {
    welcome: 'MOT D’ACCUEIL\n[Texte d’accueil de l’assemblée]\n',
    intro1: 'INTRODUCTION À LA PREMIÈRE LECTURE\n[Présenter le message de la première lecture]\n',
    psalm: 'INTRODUCTION AU PSAUME\n[Introduire la réponse de l’assemblée au psaume]\n',
    intro2: 'INTRODUCTION À LA DEUXIÈME LECTURE\n[Présenter le message de la deuxième lecture]\n',
    prayer: 'PRIÈRE UNIVERSELLE\n1. Pour l’Église et sa mission. Seigneur, nous te prions.\n2. Pour les responsables et la paix dans le monde. Seigneur, nous te prions.\n3. Pour les personnes malades et éprouvées. Seigneur, nous te prions.\n4. Pour notre assemblée. Seigneur, nous te prions.\n',
    conclusion: 'MOT DE CONCLUSION\n[Conclusion de la célébration]\n'
  };
  const freeWordCount = () => {
    const count = $('freeFullText').value.trim().split(/\s+/).filter(Boolean).length;
    $('freeWordCount').textContent = `${count} mot${count === 1 ? '' : 's'} · environ ${Math.max(1, Math.ceil(count / 120))} min de lecture à voix haute`;
    $('freeSaveStatus').textContent = 'Modifications non enregistrées';
  };
  $('freeFullText').addEventListener('input', freeWordCount);
  $('addFreeIntention').addEventListener('click', () => {
    const existing = $('freeFullText').value.match(/^\s*\d+[.)]\s/gm) || [];
    const next = existing.length + 1;
    if (next > 20) { toast('Le document est limité à vingt intentions.', 'info'); return; }
    insertFreeText(`${next}. [Nouvelle intention]\n`);
  });
  document.querySelectorAll('[data-free-tool]').forEach((button) => button.addEventListener('click', () => {
    const kind = button.dataset.freeTool;
    if (kind === 'response') {
      insertFreeText('Seigneur, nous te prions.');
      return;
    }
    insertFreeText(freeTextTemplates[kind] || '');
  }));
  $('freePlanBtn').addEventListener('click', () => {
    const plan = [freeTextTemplates.welcome, freeTextTemplates.intro1, freeTextTemplates.psalm, freeTextTemplates.intro2, freeTextTemplates.prayer, freeTextTemplates.conclusion].join('\n');
    insertFreeText(plan);
    toast('Le plan de départ est prêt. Personnalisez-le avec les lectures du jour.', 'success');
  });

  function saveWork(work, quiet = false) {
    if (!validWork(work)) { toast('Le travail ne peut pas être enregistré dans ce format.', 'error'); return false; }
    const id = currentWorkId || work.id || String(Date.now());
    const item = Object.assign({}, work, { id, updatedAt: new Date().toISOString() });
    const items = readLibrary();
    const existing = items.findIndex((entry) => entry.id === id);
    if (existing >= 0) items.splice(existing, 1);
    items.unshift(item);
    if (!writeLibrary(items)) return false;
    currentWorkId = id;
    renderSavedWorks();
    if (authToken()) void syncCloudWork(item);
    else if (!quiet) toast('Travail enregistré sur cet appareil.', 'success');
    return true;
  }

  function downloadJSON(name, value) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = el('a');
    link.href = url;
    let filename = String(name || 'travail-liturgique.json').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim();
    if (!/\.json$/i.test(filename)) filename += '.json';
    link.download = filename;
    document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function renderSavedWorks() {
    const list = $('savedWorkList');
    const items = readLibrary();
    $('savedWorkCount').textContent = String(items.length);
    $('heroWorkCount').textContent = String(items.length);
    renderFreeLibrary();
    list.replaceChildren();
    if (!items.length) { list.appendChild(el('p', 'text-muted', 'Aucun travail enregistré sur cet appareil.')); return; }
    items.forEach((work) => {
      const row = el('article', 'saved-work');
      const info = el('div', 'saved-work__info');
      info.append(el('strong', '', work.title || 'Travail liturgique'), el('small', '', [formatDate(work.date || ''), work.updatedAt ? new Date(work.updatedAt).toLocaleDateString('fr-FR') : ''].filter(Boolean).join(' · ')));
      const actions = el('div', 'saved-work__buttons');
      const open = el('button', 'btn btn--outline', 'Ouvrir'); open.type = 'button';
      open.addEventListener('click', () => {
        if (!validWork(work)) { toast('Ce travail enregistré est incomplet.', 'error'); return; }
        state.result = Object.assign({}, work, { readings: Array.isArray(work.readings) ? work.readings : [] });
        currentWorkId = work.id || null;
        renderResults(state.result); showView('results');
      });
      const share = el('button', 'btn btn--ghost', 'Partager'); share.type = 'button';
      share.addEventListener('click', () => shareWork(work));
      const remove = el('button', 'btn btn--ghost', 'Supprimer'); remove.type = 'button';
      remove.addEventListener('click', () => {
        const next = readLibrary().filter((entry) => entry.id !== work.id);
        if (writeLibrary(next)) {
          if (currentWorkId === work.id) currentWorkId = null;
          renderSavedWorks();
          if (authToken()) void cloudRequest(`/api/works/${encodeURIComponent(work.id)}`, { method: 'DELETE' }).catch((error) => toast(error.message, 'error'));
        }
      });
      actions.append(open, share, remove); row.append(info, actions); list.appendChild(row);
    });
  }

  function renderFreeLibrary() {
    const list = $('freeLibraryList');
    if (!list) return;
    const works = readLibrary().filter((work) => work.tone === 'Rédaction libre' || typeof work.freeText === 'string');
    list.replaceChildren();
    if (!works.length) { list.appendChild(el('p', 'field__help', 'Aucun travail libre enregistré.')); return; }
    works.forEach((work) => {
      const button = el('button', 'free-library__item');
      button.type = 'button';
      button.append(el('strong', '', work.title || 'Travail libre'), el('small', '', formatDate(work.date || '')));
      button.addEventListener('click', () => {
        $('freeTitle').value = work.title || '';
        $('freeDate').value = work.date || '';
        $('freeFullText').value = work.freeText || '';
        currentWorkId = work.id || null;
        lastAelfReadings = Array.isArray(work.readings) ? work.readings : [];
        paintAelfReadings(lastAelfReadings);
        freeWordCount();
        $('freeSaveStatus').textContent = 'Enregistré';
        if ($('freeDate').value && !lastAelfReadings.length) loadAelfReadings($('freeDate').value);
      });
      list.appendChild(button);
    });
  }

  function workShareUrl(work) {
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(work)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    return window.location.origin + window.location.pathname + '#travail=' + encoded;
  }

  async function shareWork(work) {
    if (!validWork(work)) { toast('Enregistrez d’abord un travail complet à partager.', 'error'); return; }
    const url = workShareUrl(work);
    if (url.length > MAX_SHARED_LINK) {
      downloadJSON('travail-liturgique.json', work);
      toast('Le travail est trop long pour un lien. Le fichier JSON à partager a été téléchargé.', 'info', 6000);
      return;
    }
    const text = 'Travail liturgique · ' + work.title;
    try {
      if (navigator.share) await navigator.share({ title: work.title, text, url });
      else if (await copyText(url)) toast('Lien de partage copié. Envoyez-le aux membres du groupe.', 'success', 6000);
      else throw new Error('Copie indisponible');
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      if (await copyText(url)) toast('Lien de partage copié. Envoyez-le aux membres du groupe.', 'success', 6000);
      else { downloadJSON('travail-liturgique.json', work); toast('Le fichier de partage a été téléchargé.', 'info'); }
    }
  }

  $('openFreeWriting').addEventListener('click', () => {
    const query = new URLSearchParams({ date: dateInput.value || '', title: $('celebration').value || '' });
    window.location.href = `/redaction?${query.toString()}`;
  });
  if ($('backToAssisted')) $('backToAssisted').addEventListener('click', () => { window.location.href = '/atelier'; });
  $('newWorkBtn').addEventListener('click', () => {
    form.reset();
    $('freeDate').value = '';
    $('freeTitle').value = '';
    $('freeFullText').value = '';
    state.result = null; currentWorkId = null; lastAelfReadings = [];
    document.querySelectorAll('.aelf-reading-list').forEach((list) => list.replaceChildren(el('p', '', 'Choisissez une date pour afficher les lectures du jour.')));
    $('aelfCelebrationMeta').textContent = 'Chargez le calendrier pour consulter les lectures.';
    clearFormError(); showView('form'); showStep(1, true);
  });
  $('freeNewWorkBtn').addEventListener('click', () => {
    currentWorkId = null;
    $('freeTitle').value = '';
    $('freeDate').value = '';
    $('freeFullText').value = '';
    lastAelfReadings = [];
    paintAelfReadings([]);
    $('freeReadingsMeta').textContent = 'Choisissez la date pour consulter les textes AELF.';
    $('freeSaveStatus').textContent = 'Non enregistré';
    freeWordCount();
  });
  $('showFreeWork').addEventListener('click', () => {
    state.result = currentFreeWork();
    renderResults(state.result); showView('results');
  });
  $('saveFreeDraft').addEventListener('click', () => {
    if (saveWork(currentFreeWork())) $('freeSaveStatus').textContent = authToken() ? 'Enregistré en ligne' : 'Enregistré dans ce navigateur';
  });
  $('freeExportBtn').addEventListener('click', () => {
    state.result = currentFreeWork();
    renderResults(state.result);
    showView('results');
    $('downloadBtn').click();
  });
  $('atelierNewWorkBtn').addEventListener('click', () => $('newWorkBtn').click());
  $('atelierGenerateBtn').addEventListener('click', () => { showStep(4, false, false); form.requestSubmit(); });
  $('closeSavedWorks').addEventListener('click', () => { $('savedWorks').open = false; });
  $('saveWorkBtn').addEventListener('click', () => saveWork(state.result));
  $('shareWorkBtn').addEventListener('click', () => shareWork(state.result));
  $('shareWhatsAppBtn').addEventListener('click', () => {
    if (!validWork(state.result)) { toast('Enregistrez d’abord un travail complet à partager.', 'error'); return; }
    const url = workShareUrl(state.result);
    if (url.length > MAX_SHARED_LINK) { downloadJSON('travail-liturgique.json', state.result); toast('Le travail est trop long pour un lien WhatsApp ; le fichier JSON a été téléchargé.', 'info', 6000); return; }
    const message = 'Travail liturgique · ' + state.result.title + '\n' + url;
    window.open('https://wa.me/?text=' + encodeURIComponent(message), '_blank', 'noopener,noreferrer');
  });
  $('printWorkBtn').addEventListener('click', () => window.print());
  $('exportLibraryBtn').addEventListener('click', () => {
    const items = readLibrary();
    if (!items.length) { toast('Aucun travail à exporter.', 'info'); return; }
    downloadJSON('travaux-liturgiques-saint-jean.json', { version: 1, works: items });
  });
  $('importWorkFile').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const imported = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.works) ? parsed.works : [parsed]);
      const valid = imported.filter(validWork).map((work) => Object.assign({}, work, { id: String(Date.now()) + '-' + Math.random().toString(36).slice(2) }));
      if (!valid.length) throw new Error('Aucun travail valide trouvé dans ce fichier.');
      if (writeLibrary([...valid, ...readLibrary()])) { renderSavedWorks(); toast(valid.length + ' travail(aux) importé(s).', 'success'); }
    } catch (error) { toast(error instanceof Error ? error.message : 'Import impossible.', 'error'); }
    event.target.value = '';
  });
  renderSavedWorks();
  if (pageName === 'redaction') {
    const params = new URLSearchParams(window.location.search);
    $('freeDate').value = params.get('date') || dateInput.value || '';
    $('freeTitle').value = params.get('title') || '';
    showView('free');
    freeWordCount();
    renderFreeLibrary();
    if ($('freeDate').value) loadAelfReadings($('freeDate').value);
  } else if (pageName === 'atelier') {
    if (dateInput.value) loadAelfReadings(dateInput.value);
  } else if (pageName === 'auth') {
    authDialog.showModal();
  }

  function openSharedWork() {
    const match = window.location.hash.match(/^#travail=([A-Za-z0-9_-]+)$/);
    if (!match) return;
    try {
      const raw = match[1].replace(/-/g, '+').replace(/_/g, '/');
      const work = JSON.parse(decodeURIComponent(escape(atob(raw))));
      if (!validWork(work)) throw new Error('Travail invalide');
      state.result = Object.assign({}, work, { readings: Array.isArray(work.readings) ? work.readings : [] });
      currentWorkId = null;
      renderResults(state.result); showView('results');
      toast('Travail partagé ouvert. Enregistrez-le pour le garder dans votre bibliothèque.', 'success', 6000);
    } catch (e) { toast('Le lien de travail partagé est invalide ou incomplet.', 'error'); }
  }

  /* ---------- Nouvelle génération ---------- */
  $('restartBtn').addEventListener('click', () => {
    state.result = null;
    $('introGrid').replaceChildren();
    $('intentionGrid').replaceChildren();
    clearFormError();
    showView('form');
    showStep(1, true);
  });

  /* ---------- Identité paroissiale et contacts du créateur ---------- */
  function buildWhatsAppUrl() {
    if (!/^\d{8,15}$/.test(WHATSAPP_CREATOR_NUMBER)) return '';
    const text = WHATSAPP_PREFILLED_MESSAGE ? '?text=' + encodeURIComponent(WHATSAPP_PREFILLED_MESSAGE) : '';
    return 'https://wa.me/' + WHATSAPP_CREATOR_NUMBER + text;
  }
  function buildInstagramUrl() {
    if (!/^[A-Za-z0-9._]{1,30}$/.test(INSTAGRAM_CREATOR_USERNAME)) return '';
    return 'https://www.instagram.com/' + encodeURIComponent(INSTAGRAM_CREATOR_USERNAME) + '/';
  }

  function initContacts() {
    const urls = { whatsapp: buildWhatsAppUrl(), instagram: buildInstagramUrl() };
    const unavailable = {
      whatsapp: 'Le contact WhatsApp sera bientôt disponible.',
      instagram: 'Le lien Instagram n\'est pas encore configuré.'
    };
    document.querySelectorAll('[data-contact]').forEach((link) => {
      const kind = link.getAttribute('data-contact');
      const url = urls[kind];
      if (url) {
        link.setAttribute('href', url);
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
      } else {
        link.classList.add('is-disabled');
        link.setAttribute('aria-disabled', 'true');
        link.setAttribute('role', 'link');
        link.setAttribute('title', unavailable[kind] || '');
        link.addEventListener('click', (e) => { e.preventDefault(); toast(unavailable[kind] || 'Contact non configuré.', 'info', 3500); });
      }
    });
    const missing = Object.keys(urls).filter((k) => !urls[k]);
    const note = $('contactNote');
    if (note && missing.length) {
      note.textContent = missing.map((k) => unavailable[k]).join(' ');
      note.hidden = false;
    }
  }

  function initIdentity() {
    const year = $('year');
    if (year) year.textContent = String(new Date().getFullYear());

    if (PARISH_LOGO_URL) {
      document.querySelectorAll('[data-logo-slot]').forEach((slot) => {
        const img = el('img');
        img.src = PARISH_LOGO_URL;
        img.alt = 'Emblème du groupe des lecteurs Saint Jean Chrysostome';
        slot.replaceChildren(img);
      });
    }
    if (CREATOR_PHOTO_URL) {
      document.querySelectorAll('[data-avatar-slot]').forEach((slot) => {
        const img = el('img');
        img.src = CREATOR_PHOTO_URL;
        img.alt = CREATOR_NAME ? 'Photo de ' + CREATOR_NAME : 'Photo du créateur';
        slot.replaceChildren(img);
      });
    }
  }

  /* ---------- Initialisation ---------- */
  initIdentity();
  initContacts();
  showStep(1, false, false);
  openSharedWork();
})();
