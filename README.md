# Vantix-kontotjeneste

Selvstændig Node/Express-tjeneste til Vantix Browser: login med e-mail/adgangskode, e-mailbekræftelse, nulstilling af adgangskode og synkronisering af allerede krypterede bokse. MySQL er en ekstern database; den forbindes **kun fra serveren**. Ingen databaseadgangskode må pakkes i desktop-programmet.

## Sikker opsætning på Render

1. Brug en Render **Web Service** (ikke Static Site), Node 22.17+ eller 24. Build: `npm ci`. Start: `npm start`. Health check: `/healthz`.
2. Sæt indstillingerne fra `.env.example` som Render-miljøvariabler. `BETTER_AUTH_URL` er den præcise HTTPS-origin uden sti. Hvis den udelades, bruges Render-variablen `RENDER_EXTERNAL_URL`. Opret en tilfældig `BETTER_AUTH_SECRET` på mindst 32 tegn. Bevar den mellem genstarter.
3. Sæt `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` og en **ny, ikke-delt** `DB_PASSWORD`. Sæt evt. `DB_SSL_CA` til databaseudbyderens CA-PEM. Forbindelsen kræver TLS, gyldigt certifikat og matchende værtsnavn; der findes ingen ukrypteret fallback eller indstilling til at omgå certifikatkontrollen. En database uden verificerbar TLS kan ikke bruges sikkert med denne tjeneste.
4. Opret en Resend-afsender på et verificeret domæne. Sæt `RESEND_API_KEY` og `EMAIL_FROM`. E-mails sendes via HTTPS; SMTP er ikke nødvendigt. Uden mailkonfiguration er login bevidst ikke aktivt. En API-nøgle skal have ret til at sende fra den valgte afsender. Providerfejl findes i Resend-dashboardet; mailadresse, mailindhold og tokens skrives ikke i serverlogs.
5. Gennemgå og tag backup af databasen. Initialisér skemaet med migrationen nedenfor. Genstart tjenesten efter ændring af miljøvariabler.

Indtast hemmeligheder direkte i Render eller et lokalt, ucommittet miljø. Send dem ikke via chat eller GitHub. Et tidligere delt databasekodeord skal roteres hos udbyderen først.

## Databaseskema (bevidst separat trin)

Serverstart og HTTP-anmodninger udfører **aldrig DDL**. En ufuldstændig tjeneste svarer på health/status, men returnerer HTTP 503 fra login, konto og synkronisering. Den opretter ikke falske sessioner og slår ikke e-mailbekræftelse fra.

Med databaseindstillingerne sikkert indlæst:

```sh
npm ci
npm run db:plan
# Læs planen, og tag backup først. Dette trin ændrer databasen:
npm run db:migrate
npm start
```

`db:plan` er read-only. Migrationen anvender den **fastlåste Better Auth 1.7.10-generering** for det præcise biblioteksskema. `db:migrate` opretter kun de navngivne Vantix-tabeller og manglende indeks; den stopper ved eksisterende tabelkolonner, som ville kræve ændringer, eller ved en usikker/ukendt plan. Ingen DROP, TRUNCATE eller DELETE. Den krypterede boks får en separat `vantix_encrypted_vault`-tabel med bruger-ID som primærnøgle og en revisionskontrol. MySQL-DDL er ikke atomisk; hvis et trin afbrydes, gennemgå planen igen før du genkører. Migrationen ændrer ikke andre applikationers tabeller.

En administrator kan køre dette én gang i en sikker server-shell. Hvis den valgte Render-plan ikke har Shell, kan administratoren selv midlertidigt vælge `npm run db:migrate && npm start` som startkommando efter at have gennemgået planen, og derefter sætte startkommandoen tilbage til `npm start`. Dette er en eksplicit databaseændring, ikke en automatisk fallback.

Tabeller: `vantix_user`, `vantix_session`, `vantix_account`, `vantix_verification`, `vantix_rate_limit`, `vantix_encrypted_vault`. Afklar evt. eksisterende tabeller med disse navne før initialisering. Begræns efter initialiseringen databasebrugerens rettigheder til nødvendige Vantix-tabeller, og brug backup hos databaseudbyderen. Ingen databaseadgang udføres af tests.

## API til desktop-programmet

Alle anmodninger bruger HTTPS og browserens cookie-session (`credentials: "include"`). HTTP-mutationer kræver `Origin` præcis lig serverens HTTPS-origin. Ingen wildcard-CORS. Auth POST kræver almindelig `Content-Length` og maks. 64 KiB; `fetch` sætter den automatisk for JSON-strenge.

- `GET /healthz`: proces-helbred, også under opsætning.
- `GET /api/status`: `{ ready, registrationEnabled, issues }`. Indeholder ingen hemmeligheder. Opsætningskontrol caches i højst 30 sekunder.
- `POST /api/auth/sign-up/email`: `{name,email,password}`. Bekræft e-mail før første login. Navnet er påkrævet. 12–128 tegn til kontoadgangskoden.
- `POST /api/auth/sign-in/email`: `{email,password,rememberMe}`. Sætter Secure/HttpOnly/SameSite=Lax-cookie.
- `POST /api/auth/sign-out`: `{}`. Tilbagekalder sessionen og rydder cookies.
- `POST /api/auth/send-verification-email`: `{email}`. Linket returnerer til `/verified`.
- `POST /api/auth/request-password-reset`: `{email}`. Linket går til den lokale `/reset-password`-side. Siden fjerner straks token fra adresselinjen og har ingen tredjepartsressourcer, referrer eller URL-accesslogs.
- `GET /api/account`: `{user:{id,displayName,email},apiVersion:2}`. Kun bekræftede, aktive brugere.
- `GET /api/sync`: `{envelope:null,revision:0}` eller `{envelope,revision,updatedAt}` for den aktuelle bruger.
- `PUT /api/sync`: `{envelope,expectedRevision}`, plus `X-Vantix-Sync: 1` og JSON-contenttype. Returnerer `{revision,updatedAt}` eller HTTP 409 ved konflikt. Opdateringen er atomisk og altid scoped til den godkendte bruger.

Boksformat: `{version:1,kdf:"scrypt-32768-8-1",salt,iv,tag,ciphertext}` med kanonisk Base64 og faste byte-længder for salt/IV/tag. Serveren accepterer kun krypteret envelope; adgangskoder til andre sider og boksens hovedadgangskode indsendes ikke. `REGISTRATION_ENABLED=false` lukker for nye registreringer uden at slå eksisterende login fra.

Better Auths offentlige handler behandler alle adgangskodeoperationer, så den vedvarende MySQL-baserede rate limiter bevares. Ændring via nulstillingslink tilbagekalder eksisterende sessioner. Kontoadgangskode og boksens hovedadgangskode er adskilte: nulstilling af kontoadgangskoden dekrypterer ikke boksen og gendanner ikke en glemt hovedadgangskode.

Den tidligere ChatGPT-konto og denne konto er forskellige identiteter. Der udføres ingen automatisk kontosammenfletning eller upload af en anden kontos lokale boks.

## Lokal kontrol

`npm test` kører kun syntetiske lokale testdata. De tester konfiguration/TLS, opsætningsblokering, origin/identitet, envelopevalidering, CAS/brugerisolation og en reel Better Auth e-mailbekræftelse → login → reset/tilbagekaldelse → logout med SQLite i hukommelsen. Ingen rigtig mail, eksterne databaseændringer eller brugeradgangskoder anvendes. Det erstatter ikke sikkerhedsrevision eller afprøvning af produktionens DB-certifikat, afsenderdomæne og login på to enheder.

Primære dokumentationer: [MySQL](https://better-auth.com/docs/adapters/mysql), [Express](https://better-auth.com/docs/integrations/express), [E-mail/adgangskode](https://better-auth.com/docs/authentication/email-password), [Rate limits](https://better-auth.com/docs/concepts/rate-limit).
