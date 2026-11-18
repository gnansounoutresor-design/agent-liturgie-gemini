# Sécurité

## Versions prises en charge

La branche `main` est la version en production. Les correctifs de sécurité sont publiés sur cette branche.

## Mesures en place

- Les mots de passe sont gérés par Supabase Auth et ne sont jamais enregistrés par l’application.
- L’accès aux profils et aux travaux est vérifié côté serveur avec le jeton de session Supabase.
- Row Level Security protège les tables `profiles` et `liturgical_works` ; le profil n’est visible que par son propriétaire.
- La clé Supabase `service_role` n’est utilisée que côté serveur pour la suppression d’un compte.
- Les réponses API n’autorisent pas la mise en cache et le site applique des en-têtes de sécurité CSP, HSTS en HTTPS, anti-cadrage et anti-MIME-sniffing.
- Les générations ne sont pas archivées dans un historique applicatif persistant.

## Signaler un problème

N’ouvrez pas de ticket public contenant une faille exploitable, une adresse e-mail, un jeton ou une clé. Signalez le problème au responsable du site via le [contact WhatsApp](https://wa.me/229154806378), en indiquant le chemin concerné, les étapes de reproduction et l’impact constaté. N’accédez pas aux comptes ou travaux d’autres personnes pendant une vérification.

Le responsable accusera réception dès que possible, évaluera l’impact et communiquera les mesures de correction aux personnes concernées si nécessaire.
