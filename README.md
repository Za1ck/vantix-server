# Vantix-kontotjeneste

Selvstændig Node/Express-server til Vantix Browser: e-mail/adgangskode, e-mailbekræftelse, nulstilling af adgangskode og synkronisering af allerede krypterede bokse. Serveren bruger Neon PostgreSQL med `pg.Pool`; desktop-programmet forbinder kun til serverens HTTPS-API. Databaseforbindelser og hemmeligheder må aldrig pakkes i browseren.

Vantix beholder Better Auth 1.7.10 og sine eksisterende loginregler. Neon leverer databasen, **ikke Neon Auth**. Den tidligere MySQL-database bliver ikke ændret eller kopieret af denne opsætning. En eventuel flytning af gamle brugere, sessioner eller krypterede bokse kræver en separat, gennemgået datamigration. Der udføres ingen automatisk kontosammenfletning.

## Neon-projekt og lokale miljøvariabler

Kør fra dette repositorys rod, `vantix-server`. Neon CLI-opsætningen kræver Node 22.20+ eller 24; selve Vantix-serverens runtime understøtter Node 22.17+ eller 24:

```sh
npm i -g neon@latest
neon init -y --org-id org-gentle-tree-57945652 --project-id silent-bread-50146724 --branch production --services postgres
neon deploy
```

Hvis global installation ikke virker, erstattes `neon` i kommandoerne med `npx neon@latest`. Hvis CLI'en åbner login i browseren, skal ejeren færdiggøre det der. Ved udløbet login køres `neon login`, hvorefter den afbrudte kommando gentages. Del ikke loginlinks, tokens eller forbindelsesstrenge i chat eller GitHub.

`neon.ts` beskriver Neon-opsætningen. `neon deploy` konfigurerer de valgte Neon-services og henter deres miljøvariabler; den udgiver **ikke** Node-serveren til Render. Forbindelsesstrengene gemmes i `.env.local`, eller `.env` hvis den allerede findes. Serveren og migrationsscriptet læser først `.env`, ellers `.env.local`; eksisterende variabler fra Render eller processen bevares. Filernes indhold må ikke committes. `.env`, `.env.*` og lokal `.neon`-tilstand er ignoreret; `.env.example` indeholder kun tomme værdier og pladsholdere.

- `DATABASE_URL`: Neon-forbindelsen med `-pooler` i værtsnavnet, til serverens almindelige forespørgsler. Node-serveren genbruger en lille `pg.Pool`.
- `DATABASE_URL_UNPOOLED`: direkte forbindelse uden `-pooler`, til den eksplicitte schemainitialisering. Begge strenge skal tilhøre det tilsigtede projekt, branch og databasenavn.
- `POSTGRES_SSL_CA`: valgfrit CA-certifikat i PEM-format, kun hvis databaseudbyderen kræver det. Literal `\n` understøttes.

Alle databaseforbindelser kræver TLS med gyldigt certifikat og matchende værtsnavn. URL-parametre må ikke slå denne politik fra; koden bruger den validerede PostgreSQL-adresse med eksplicit TLS-konfiguration. Der findes ingen ukrypteret fallback eller indstilling til at omgå certifikatkontrol. Neon-forbindelser og pooler er beskrevet i [Neons dokumentation](https://neon.com/docs/connect/connection-pooling).

## Sikker opsætning på Render

1. Brug en Render **Web Service**, ikke Static Site. Build: `npm ci && npm run build`. Start: `npm start`. Health check: `/healthz`.
2. Indtast Neon-strengene som Render-miljøvariabler, ikke i kildekode eller desktop-konfiguration. `DATABASE_URL` bruges under normal drift; `DATABASE_URL_UNPOOLED` behøves, hvor administratoren kører migrationen. Gamle `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` og `DB_SSL_CA` bruges ikke længere af serveren.
3. **Bevar den eksisterende `BETTER_AUTH_SECRET`** ved skift fra MySQL. Generér kun en ny tilfældig hemmelighed på mindst 32 tegn ved en helt ny installation. Bevar også serverens HTTPS-origin. `BETTER_AUTH_URL` er origin uden sti; hvis den udelades, bruges `RENDER_EXTERNAL_URL`.
4. Bevar `RESEND_API_KEY` og `EMAIL_FROM`. Afsenderen skal være godkendt i Resend. Mails sendes via HTTPS; SMTP er ikke nødvendigt. Uden gyldig mailkonfiguration åbner serveren bevidst ikke for login. Mailadresser, indhold, tokens og provider-fejl skrives ikke i serverlogs.
5. Initialisér kun den valgte Neon-database efter gennemgang af planen nedenfor, og deploy/genstart derefter tjenesten. Kontrollér `/api/status`: et levende `/healthz` betyder ikke i sig selv, at login og synkronisering er klar.

Indtast hemmeligheder direkte i Render eller et lokalt, ucommittet miljø. Send dem ikke i chat. Et tidligere delt MySQL-kodeord skal stadig roteres hos udbyderen; skift til Neon gør ikke det gamle kodeord hemmeligt igen.

## Databaseskema: eksplicit og separat trin

Serverstart og HTTP-anmodninger udfører **aldrig DDL**. En ufuldstændig tjeneste svarer på health/status, men returnerer HTTP 503 fra login, konto og synkronisering. Den opretter ikke falske sessioner og slår ikke e-mailbekræftelse fra.

Med de tilsigtede databaseindstillinger sikkert indlæst:

```sh
npm ci
npm run build
npm run db:plan
# Gennemgå planen og eksisterende tabeller, og tag backup først.
# Dette skriver til den database, miljøvariablerne vælger:
npm run db:migrate
npm start
```

`db:plan` er read-only og bruger den direkte forbindelse. `db:migrate` anvender den fastlåste Better Auth-generering og den separate PostgreSQL-definition til den krypterede boks. Initialiseringen er additiv og er ikke et generelt værktøj til at ændre eksisterende skemaer eller importere MySQL-data. Den skal ikke bruges uden gennemgang, hvis Vantix-tabeller allerede findes. Ved afbrydelse gennemgås planen igen før gentagelse; behandl ikke hele initialiseringen som én atomisk transaktion.

Tabellerne ligger i PostgreSQL-skemaet `public`: `vantix_user`, `vantix_session`, `vantix_account`, `vantix_verification`, `vantix_rate_limit`, `vantix_encrypted_vault`. Bruger-ID er UUID. Boksen har én række pr. bruger, BIGINT-revision med revisionskontrol og brugerfremmednøgle. Undersøg eksisterende tabeller og rettigheder inden initialisering, og konfigurér backup hos databaseudbyderen. Begræns runtime-brugerens rettigheder til nødvendige Vantix-tabeller, hvor driften tillader det.

En administrator kan køre migrationen én gang lokalt eller i en sikker server-shell. Hvis Render-planen ikke tilbyder Shell, kan administratoren efter gennemgang midlertidigt bruge `npm run db:migrate && npm start` som startkommando og derefter gendanne `npm start`. Det er en eksplicit databaseændring, ikke automatisk oprettelse ved almindelig serverstart.

## API til desktop-programmet

Alle anmodninger bruger HTTPS og browserens cookie-session (`credentials: "include"`). HTTP-mutationer kræver `Origin` præcis lig serverens HTTPS-origin. Ingen wildcard-CORS. Auth POST kræver `Content-Length` og maks. 64 KiB; `fetch` sætter længden automatisk for JSON-strenge.

- `GET /healthz`: proces-helbred, også under opsætning.
- `GET /api/status`: `{ ready, registrationEnabled, issues }`. Ingen hemmeligheder. Opsætningskontrol caches i højst 30 sekunder.
- `POST /api/auth/sign-up/email`: `{name,email,password}`. Bekræft e-mail før første login. Navn er påkrævet; kontoadgangskoden skal være 12–128 tegn.
- `POST /api/auth/sign-in/email`: `{email,password,rememberMe}`. Sætter Secure/HttpOnly/SameSite=Lax-cookie.
- `POST /api/auth/sign-out`: `{}`. Tilbagekalder sessionen og rydder cookies.
- `POST /api/auth/send-verification-email`: `{email}`. Linket returnerer til `/verified`.
- `POST /api/auth/request-password-reset`: `{email}`. Linket går til `/reset-password`. Siden fjerner straks token fra adresselinjen og har ingen tredjepartsressourcer eller referrer.
- `GET /api/account`: `{user:{id,displayName,email},apiVersion:2}`. Kun bekræftede, aktive brugere.
- `GET /api/sync`: `{envelope:null,revision:0}` eller `{envelope,revision,updatedAt}` for den aktuelle bruger.
- `PUT /api/sync`: `{envelope,expectedRevision}`, plus `X-Vantix-Sync: 1` og JSON-contenttype. Returnerer `{revision,updatedAt}` eller HTTP 409 ved konflikt. Opdateringen er atomisk og scoped til den godkendte bruger.

Boksformatet bevares: `{version:1,kdf:"scrypt-32768-8-1",salt,iv,tag,ciphertext}` med kanonisk Base64 og faste byte-længder for salt/IV/tag. Serveren accepterer kun den krypterede envelope; adgangskoder til andre sider og boksens hovedadgangskode indsendes ikke. `REGISTRATION_ENABLED=false` lukker for nye registreringer uden at slå eksisterende login fra.

Better Auths offentlige handler behandler alle adgangskodeoperationer og bevarer den PostgreSQL-baserede, vedvarende rate limiter. Nulstilling af kontoadgangskoden tilbagekalder eksisterende sessioner; den dekrypterer ikke boksen og gendanner ikke en glemt hovedadgangskode.

Den tidligere ChatGPT-konto og en Vantix-e-mailkonto er forskellige identiteter. Hverken databaseskiftet eller login sammenfletter dem eller uploader automatisk en anden kontos lokale boks. Eksisterende lokale ejerbindinger skal bevares.

## Kontrol og end-to-end-test

`npm run build` kontrollerer JavaScript-syntaks, typekontrollerer Neon-konfigurationen og kører `npm test`. Node-serveren afvikler ES-moduler direkte; build er derfor validering, ikke bundling af desktop-programmet.

`npm test` bruger kun syntetiske lokale testdata. Den kontrollerer konfiguration/TLS, opsætningsblokering, origin/identitet, envelopevalidering, CAS/brugerisolation og et reelt Better Auth-forløb med SQLite i hukommelsen. Den opretter ingen eksterne databaseforbindelser eller rigtige mails.

`npm run test:neon` er en særskilt, eksplicit integrationstest, som **skriver syntetiske konti, sessioner og krypterede bokse til en rigtig Neon-testbranch**. Kør den aldrig mod production. Før testen:

1. Opret en isoleret branch med navn `vantix-migration-test-...`. Kontrollér i Neon, at både pooled og direkte endpoint tilhører netop den branch; et filnavn eller en branch-tekst er ikke i sig selv bevis.
2. Gem kun testbranchens forbindelser i `.env.neon-test`, og initialisér testbranchens skema med `db:plan`/`db:migrate` i en proces med dens direkte forbindelse. Ændr ikke production-miljøfilen for at køre test.
3. Opret et kortlivet lokalt TLS-certifikat til HTTPS-fixturen med SAN for IP-adressen `127.0.0.1`. Gem det som `cert.pem` og `key.pem` i en midlertidig mappe. Certifikatet bruges kun som fixture-CA; produktionens certifikatkontrol ændres ikke.
4. Sæt følgende procesvariabler, og start testen. Eksempel i PowerShell:

```powershell
$env:VANTIX_E2E_ENV_FILE = (Resolve-Path '.env.neon-test').Path
$env:VANTIX_E2E_BRANCH_NAME = 'vantix-migration-test-DIN-UNIKKE-SUFFIX'
$env:VANTIX_TEST_TLS_DIR = 'C:\DIN-MIDLERTIDIGE-TESTCERTIFIKATMAPPE'
npm run test:neon
```

Testen afviser almindelige `.env`/`.env.local` som input og indlæser dem ikke. Den kontrollerer rigtig PostgreSQL-TLS og HTTPS-readiness, signup/bekræftelse/login, session-cookies, krypteret boks og brugerisolation, revisionskonflikter inklusive samtidige skriv, genstart/persistens, vedvarende rate limiting, password-reset og logout. Den skal afslutte med `status: "PASS"` og exitkode 0; et fejlet trin er ikke bevis for resten af forløbet. Output udelader tokens og forbindelsesdetaljer.

Mails fanges i hukommelsen: testen sender **ikke** via Resend, og den tester **ikke** den installerede Electron-browsers brugerflade. Verificér derfor rigtig maillevering og desktop-login særskilt. Ejeren skal efterfølgende fjerne den eksplicit oprettede testbranch og dens lokale testfiler; scriptet sletter ikke automatisk Neon-branches eller produktionsdata. Tests erstatter ikke en sikkerhedsrevision eller backup.

Primære dokumentationer: [Neon connection pooling](https://neon.com/docs/connect/connection-pooling), [node-postgres TLS](https://node-postgres.com/features/ssl), [Better Auth PostgreSQL](https://better-auth.com/docs/adapters/postgresql).
