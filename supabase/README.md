# Supabase portal intake

The browser never receives a Supabase key. Contact information is encrypted by the `portal-intake` Edge Function; direct browser access to both tables is disabled with RLS and revoked grants.

1. Authenticate locally without putting a token in this repository: `npx supabase login`.
2. Link the project: `npx supabase link --project-ref qqxbnadczaocvvryzsfi`.
3. Apply the schema: `npx supabase db push`.
4. Copy `supabase/functions/.env.example` to a private file, generate both values with `openssl rand -base64 32`, then run `npx supabase secrets set --env-file <private-env-file>`.
5. Deploy the function: `npx supabase functions deploy portal-intake --no-verify-jwt`.

`ALLOWED_ORIGINS` must include the production GitHub Pages origin and any local development origin that should be allowed to submit data.
