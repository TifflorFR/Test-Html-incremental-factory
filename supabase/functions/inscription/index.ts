// Inscription par pseudo + mot de passe pour Incrémental Factory.
// Supabase Auth exige un email : on en fabrique un interne à partir du pseudo (jamais montré au
// joueur, jamais écrit — le domaine .invalid est réservé et ne peut pas recevoir de courrier).
// Le compte est créé ici avec la clé service, déjà confirmé : aucun email de confirmation ne part.
// Public par nature (le joueur n'a pas encore de compte), d'où verify_jwt désactivé au déploiement.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, content-type, authorization, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Doit rester identique à pseudoEmail() dans index.html.
const DOMAIN = "joueurs.incremental-factory.invalid";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error_code: "method" }, 405);
  const { pseudo, password } = await req.json().catch(() => ({}));
  const p = String(pseudo ?? "").trim();
  if (!/^[A-Za-z0-9_-]{3,20}$/.test(p)) return json({ error_code: "pseudo_invalid" }, 400);
  // 72 : bcrypt ignore silencieusement tout ce qui dépasse
  if (typeof password !== "string" || password.length < 6 || password.length > 72)
    return json({ error_code: "weak_password" }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { error } = await admin.auth.admin.createUser({
    email: p.toLowerCase() + "@" + DOMAIN,
    password,
    email_confirm: true,
    user_metadata: { pseudo: p },
  });
  if (error) {
    const taken = error.code === "email_exists" || error.code === "user_already_exists";
    return json({ error_code: taken ? "pseudo_taken" : "server", msg: taken ? undefined : error.message }, taken ? 409 : 500);
  }
  return json({ ok: true });
});
