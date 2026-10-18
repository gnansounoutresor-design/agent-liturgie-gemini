/* ==========================================================================
   Assistant liturgique — interface (JavaScript natif, aucune dépendance)

   CONTRAT D'API ATTENDU
   ---------------------
   Requête  : POST /api/generate
     En-têtes : Content-Type: application/json
                Accept: application/json
                X-Gemini-Api-Key: <clé saisie par l'utilisateur>   (jamais dans le corps)
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

  /* ---------- Configuration ---------- */
  const API_URL = '/api/generate';
  const KEY_HEADER = 'X-Gemini-Api-Key';
  const TIMEOUT_MS = 150000; // 2 min 30 : la génération par IA peut être longue
  const EXPECTED = { introductions: 2, intentions: 4 };
  const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

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
    consignes: 'consignes'
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
  const dateField = dateInput ? dateInput.closest('.field') : null;
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

  const steps = Array.from(document.querySelectorAll('.step'));
  const prevBtn = $('prevBtn');
  const nextBtn = $('nextBtn');
  const generateBtn = $('generateBtn');
  const keyInput = $('geminiKey');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    step: 1,
    busy: false,
    controller: null,
    result: null,
    loadingTimer: null
  };
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

  function toast(message, type = 'info', duration = 4500) {
    const box = el('div', 'toast toast--' + type, scrub(message));
    $('toasts').appendChild(box);
    window.setTimeout(() => {
      box.classList.add('is-leaving');
      window.setTimeout(() => box.remove(), 320);
    }, duration);
  }

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
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(saved || (prefersDark ? 'dark' : 'light'));
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
  const STEP_NAMES = { 1: 'Célébration', 2: 'Références bibliques', 3: 'Personnalisation', 4: 'Configuration de Gemini' };

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
    if (!key) return 'Veuillez saisir votre clé API Gemini.';
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
  const views = { form: $('formView'), loading: $('loadingView'), results: $('resultsView') };
  function showView(name) {
    Object.keys(views).forEach((k) => { views[k].hidden = k !== name; });
    const target = name === 'form' ? $('preparer') : views[name];
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
      headers[KEY_HEADER] = keyInput.value.trim();

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
        date: payload[FIELD_MAP.date] || ''
      });
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
  function buildCard(title, text, variant, iconId, delayMs) {
    const node = $('resultCardTpl').content.firstElementChild.cloneNode(true);
    node.classList.add('result-card--' + variant);
    node.style.animationDelay = delayMs + 'ms';
    node.querySelector('.result-card__title').textContent = title;
    node.querySelector('.result-card__text').textContent = text;
    node.querySelector('[data-icon]').appendChild($(iconId).content.cloneNode(true));
    const copyBtn = node.querySelector('[data-copy]');
    copyBtn.setAttribute('aria-label', 'Copier : ' + title);
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(text);
      flashCopied(copyBtn, ok);
    });
    return node;
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

    res.intros.forEach((text, i) => {
      introGrid.appendChild(buildCard(INTRO_TITLES[i], text, i === 0 ? 'wine' : 'violet', 'iconBook', i * 90));
    });
    res.intentions.forEach((text, i) => {
      intentionGrid.appendChild(buildCard('Intention ' + (i + 1), text, 'gold', 'iconPrayer', 220 + i * 90));
    });

    // Document Word
    const hasDoc = !!res.doc;
    $('downloadBtn').hidden = !hasDoc;
    $('docReadyText').textContent = hasDoc
      ? 'Le document Word est disponible au téléchargement.'
      : 'Les textes sont affichés ci-dessous. Le serveur n\'a pas fourni de document Word pour cette génération.';

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
    parts.push('INTRODUCTIONS AUX LECTURES', '');
    res.intros.forEach((t, i) => parts.push(INTRO_TITLES[i], t, ''));
    parts.push('PRIÈRE UNIVERSELLE', '');
    res.intentions.forEach((t, i) => parts.push('Intention ' + (i + 1), t, ''));
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
    const doc = state.result && state.result.doc;
    if (!doc) { toast('Aucun document Word n\'est disponible.', 'error'); return; }
    btn.disabled = true;
    try {
      let blob;
      if (typeof doc.base64 === 'string' && doc.base64) {
        blob = base64ToBlob(doc.base64, doc.mimeType || DOCX_MIME);
      } else {
        const target = new URL(doc.url, window.location.href);
        if (target.origin !== window.location.origin) throw new Error('Adresse de téléchargement refusée (origine différente).');
        const response = await fetch(target.href, { headers: { Accept: DOCX_MIME + ', application/octet-stream' }, credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) throw new Error(errorFromStatus(response.status, ''));
        blob = await response.blob();
      }
      const type = (blob.type || '').toLowerCase();
      if (!blob.size) throw new Error('Le document reçu est vide.');
      if (type.includes('json') || type.includes('html')) throw new Error('Le serveur n\'a pas renvoyé un fichier Word.');

      const file = new Blob([blob], { type: DOCX_MIME });
      const url = URL.createObjectURL(file);
      const link = el('a');
      link.href = url;
      link.download = safeFilename(doc.filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast('Le téléchargement du document Word a commencé.', 'success');
    } catch (err) {
      toast((err && err.message) || 'Le téléchargement a échoué.', 'error', 7000);
    } finally {
      btn.disabled = false;
    }
  });

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
        img.alt = 'Logo de la paroisse Sainte Joséphine Bakhita';
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
})();
