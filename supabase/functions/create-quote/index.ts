// create-quote: saves a fuel-surcharge quote for a signed-in member of a carrier.
//
// This file only does the plumbing: read the request, build the two Supabase clients, add CORS headers.
// The rules are in ../_shared/create-quote.mjs and the database calls in ../_shared/supabase-deps.mjs.
//
// Deploy with verify_jwt ON (the default): the platform then refuses requests without a valid user token
// before this code runs. The code still checks the token itself, because it must work either way.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { handleCreateQuote, MAX_BODY_BYTES } from '../_shared/create-quote.mjs';
import { makeDeps } from '../_shared/supabase-deps.mjs';

const CLIENT_OPTIONS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

// Keys are JSON objects such as {"default": "sb_publishable_..."}; see Supabase "Environment variables".
function keyNamed(envName: string): string | undefined {
  try {
    return JSON.parse(Deno.env.get(envName) ?? '{}')['default'];
  } catch {
    return undefined;
  }
}

let adminClient: ReturnType<typeof createClient> | undefined;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const url = Deno.env.get('SUPABASE_URL');
  const publishableKey = keyNamed('SUPABASE_PUBLISHABLE_KEYS');
  const secretKey = keyNamed('SUPABASE_SECRET_KEYS');
  if (!url || !publishableKey || !secretKey) {
    console.error(JSON.stringify({ event: 'missing_configuration', url: !!url, publishableKey: !!publishableKey, secretKey: !!secretKey }));
    return json(500, { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Nothing was saved.' } });
  }

  const declaredLength = Number(req.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return json(413, { error: { code: 'PAYLOAD_TOO_LARGE', message: `The request body may be at most ${MAX_BODY_BYTES} bytes.` } });
  }

  const authorization = req.headers.get('Authorization') ?? '';
  // Reads happen as the caller, so row level security applies.
  const userClient = createClient(url, publishableKey, {
    ...CLIENT_OPTIONS,
    global: { headers: { Authorization: authorization } },
  });
  adminClient ??= createClient(url, secretKey, CLIENT_OPTIONS);

  const result = await handleCreateQuote(
    { method: req.method, authorization, bodyText: req.method === 'POST' ? await req.text() : '' },
    makeDeps({ userClient, adminClient }),
  );
  return json(result.status, result.body);
});
