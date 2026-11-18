# Assistant liturgique

Site web du groupe des lecteurs Saint Jean Chrysostome pour préparer la liturgie en français. L'application récupère les lectures depuis l'AELF et produit deux introductions, quatre intentions de prière et un document Word.

L'atelier propose une rédaction assistée ou libre, la consultation des lectures AELF, des aides d'insertion pour le mot d'accueil, les introductions (y compris le psaume), les intentions et la conclusion, ainsi que l'ajout d'intentions libres. Les textes peuvent être retouchés, réécrits, imprimés, partagés par WhatsApp ou lien et exportés en Word. La bibliothèque locale accepte l'import/export JSON ; les comptes et la synchronisation Supabase sont facultatifs.

## Démarrer en local

Prérequis : Node.js 20 ou plus récent. Depuis l'Explorateur, double-cliquez sur `start-local.cmd`. Le lanceur installe les dépendances manquantes puis démarre le serveur sans modifier la stratégie d'exécution PowerShell. Gardez la fenêtre ouverte et ouvrez `http://127.0.0.1:3000`.

Depuis PowerShell, ouvrez d'abord le dossier qui contient `package.json`, puis lancez `& "C:\Program Files\nodejs\npm.cmd" start`. npm lancé depuis `C:\Users\USER` ne trouvera pas le projet.

La génération assistée nécessite au moins un fournisseur IA configuré. Gemini est essayé en premier, puis DeepSeek, puis OpenAI. En cas d'absence ou d'échec de tous les fournisseurs, l'application renvoie une erreur explicite : elle ne remplace plus le résultat par un texte local générique.

Les clés IA restent sur le serveur et les visiteurs n'ont pas à en saisir. Une clé Gemini personnelle peut être fournie pour une requête lorsque le serveur n'a aucun fournisseur disponible. Sans Supabase, les brouillons restent dans le navigateur.

### Activer les comptes et la bibliothèque partagée

1. Dans Supabase, active **Allow new users to sign up** et **Confirm email**. Configure un serveur SMTP personnalisé pour envoyer les confirmations aux adresses des utilisateurs : le service d’envoi par défaut Supabase est limité aux adresses autorisées de l’équipe et n’est pas prévu pour la production.
2. Dans **Authentication → URL Configuration**, définis l’URL du site sur `https://priereuniversellebakhita.onrender.com/` et autorise cette URL ainsi que `http://localhost:3000/` pour le développement. Configure le modèle de confirmation pour renvoyer vers `{{ .RedirectTo }}` ou `{{ .SiteURL }}`.
3. Exécute [`supabase/schema.sql`](supabase/schema.sql) dans le SQL Editor Supabase. Le script crée le profil par compte, les règles Row Level Security et le propriétaire des travaux. Il est réexécutable : les anciens travaux sans propriétaire restent consultables par le groupe, mais ne peuvent pas être modifiés ou supprimés par un compte arbitraire.
4. Dans **Render → Environment**, configure `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_AUTH_REDIRECT_URL=https://priereuniversellebakhita.onrender.com/` et, pour activer la suppression autonome des comptes, `SUPABASE_SERVICE_ROLE_KEY`. La clé `service_role` est un secret serveur : ne la publie jamais dans Git, dans une page ou dans une variable `VITE_`/`PUBLIC_`.
5. N’active pas le CAPTCHA Supabase tant qu’un CAPTCHA n’est pas intégré à l’écran d’inscription : ce formulaire ne transmet actuellement aucun jeton CAPTCHA. Une protection CAPTCHA doit être ajoutée avec son fournisseur et ses clés avant d’être activée côté Supabase. `cloudSyncConfigured` confirme uniquement la présence de l’URL et de la clé publique ; il ne valide pas le schéma ni le SMTP. `accountDeletionAvailable` indique si la clé secrète de suppression est présente.

Les profils ne sont lisibles que par leur propriétaire. Les travaux nouvellement sauvegardés restent partagés avec les comptes authentifiés du groupe, mais les modifications et suppressions sont limitées à leur propriétaire. À la connexion, les brouillons locaux absents ou plus récents sont synchronisés. La suppression d’un compte efface son profil et les travaux en ligne qu’il possède ; les copies locales et les liens de partage déjà distribués doivent être effacés séparément.

Le formulaire propose également une réinitialisation du mot de passe par e-mail. Le lien de récupération doit être autorisé dans **Authentication → URL Configuration**, et le modèle de récupération Supabase doit utiliser `{{ .RedirectTo }}` ou `{{ .SiteURL }}` pour revenir sur le site.

## Déploiement

Le dépôt est relié à Render pour le site public. Les corrections poussées sur `main` déclenchent le déploiement automatique. Les paramètres d’authentification ci-dessus doivent être appliqués séparément dans Supabase et Render ; l’application ne peut pas les modifier avec la clé publique.

L'application essaie les fournisseurs configurés dans l'ordre. La récupération AELF nécessite toujours une connexion ; les lectures affichées ne peuvent être rafraîchies sans accès à ce service. Les dates passées sont acceptées pour permettre la préparation et la vérification d'anciens dimanches. La génération exige le texte des lectures et s'arrête si ces sources manquent. Relire les références bibliques et les textes générés reste nécessaire.

## Fonctionnalités

- Recherche automatique des lectures de la messe par date sur AELF.
- Atelier assisté en une page et rédaction libre avec bibliothèque latérale.
- Génération de deux introductions et quatre intentions avec Gemini, DeepSeek ou OpenAI, après contrôle des textes sources.
- Copie individuelle ou complète et export Word `.docx`.
- Compte facultatif et bibliothèque partagée via Supabase ; mode local utilisable sans compte.
- Thème clair/sombre, animations avec respect de la préférence de mouvement réduit.
