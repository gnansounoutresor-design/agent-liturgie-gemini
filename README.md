# Assistant liturgique

Site web du groupe des lecteurs Saint Jean Chrysostome pour préparer la liturgie en français. L'application récupère les lectures depuis l'AELF et produit deux introductions, quatre intentions de prière et un document Word.

L'atelier propose une rédaction assistée ou libre, la consultation des lectures AELF, des aides d'insertion pour le mot d'accueil, les introductions (y compris le psaume), les intentions et la conclusion, ainsi que l'ajout d'intentions libres. Les textes peuvent être retouchés, réécrits, imprimés, partagés par WhatsApp ou lien et exportés en Word. La bibliothèque locale accepte l'import/export JSON ; les comptes et la synchronisation Supabase sont facultatifs.

## Démarrer en local

Prérequis : Node.js 20 ou plus récent. Depuis l'Explorateur, double-cliquez sur `start-local.cmd`. Le lanceur installe les dépendances manquantes puis démarre le serveur sans modifier la stratégie d'exécution PowerShell. Gardez la fenêtre ouverte et ouvrez `http://127.0.0.1:3000`.

Depuis PowerShell, ouvrez d'abord le dossier qui contient `package.json`, puis lancez `& "C:\Program Files\nodejs\npm.cmd" start`. npm lancé depuis `C:\Users\USER` ne trouvera pas le projet.

La génération assistée nécessite au moins un fournisseur IA configuré. Gemini est essayé en premier, puis DeepSeek, puis OpenAI. En cas d'absence ou d'échec de tous les fournisseurs, l'application renvoie une erreur explicite : elle ne remplace plus le résultat par un texte local générique.

Les clés IA restent sur le serveur et les visiteurs n'ont pas à en saisir. Une clé Gemini personnelle peut être fournie pour une requête lorsque le serveur n'a aucun fournisseur disponible. Sans Supabase, les brouillons restent dans le navigateur.

### Activer les comptes et la bibliothèque partagée

1. Créez un projet Supabase et exécutez [`supabase/schema.sql`](supabase/schema.sql) dans son SQL Editor.
2. Ajoutez `SUPABASE_URL` et `SUPABASE_ANON_KEY` dans `.env` localement et dans les variables Vercel. N'utilisez pas la clé `service_role`.
3. Dans Supabase Auth → URL Configuration, ajoutez les URL de l'application locale et de production à la liste des redirections permises.
4. Activez la confirmation d'adresse e-mail dans Supabase Auth, puis utilisez **Se connecter** pour créer un compte ou ouvrir une session.

Les travaux partagés sont accessibles aux comptes authentifiés du même projet Supabase, comme sur l'espace de référence. Les brouillons du navigateur sont conservés en parallèle pour permettre le mode local.

## Déployer sur Vercel

1. Importez le dépôt GitHub `gnansounoutresor-design/agent-liturgie-gemini` dans Vercel.
2. Ajoutez les variables disponibles dans **Settings → Environment Variables** : `SUPABASE_URL` et `SUPABASE_ANON_KEY` pour les comptes et la bibliothèque partagée, puis au moins une clé parmi `GEMINI_API_KEY`, `DEEPSEEK_API_KEY` et `OPENAI_API_KEY`. Gardez les clés d'IA côté serveur ; ne les mettez jamais dans le code ou dans GitHub.
3. Déployez le projet. Vercel détecte l'application Express depuis `server.mjs`; `vercel.json` inclut le corpus et les fichiers du site et autorise jusqu'à 120 secondes pour une génération.
4. Vérifiez `/api/health` sur le domaine de production : `providers` indique les fournisseurs et modèles configurés, et `localFallback` est `false`.

L'application essaie les fournisseurs configurés dans l'ordre. La récupération AELF nécessite toujours une connexion ; les lectures affichées ne peuvent être rafraîchies sans accès à ce service. Les dates passées sont acceptées pour permettre la préparation et la vérification d'anciens dimanches. La génération exige le texte des lectures et s'arrête si ces sources manquent. Relire les références bibliques et les textes générés reste nécessaire.

## Fonctionnalités

- Recherche automatique des lectures de la messe par date sur AELF.
- Atelier assisté en une page et rédaction libre avec bibliothèque latérale.
- Génération de deux introductions et quatre intentions avec Gemini, DeepSeek ou OpenAI, après contrôle des textes sources.
- Copie individuelle ou complète et export Word `.docx`.
- Compte facultatif et bibliothèque partagée via Supabase ; mode local utilisable sans compte.
- Thème clair/sombre, animations avec respect de la préférence de mouvement réduit.
