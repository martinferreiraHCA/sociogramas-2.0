// Inicializa el cliente Supabase. Usa el SDK cargado por CDN
// (<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>)
// y expone las funciones que el resto del front consume.

(function () {
  const cfg = window.APP_CONFIG || {};
  if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("TU-PROYECTO")) {
    console.warn("[supabase] Editá js/config.js con la URL y anon key del proyecto.");
  }
  if (!window.supabase || !window.supabase.createClient) {
    console.error("[supabase] No se cargó el SDK. Verificá el <script> en el HTML.");
    return;
  }

  const client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  async function rpc(name, params) {
    const { data, error } = await client.rpc(name, params || {});
    if (error) {
      console.error(`[rpc ${name}]`, error);
      throw error;
    }
    return data;
  }

  async function loadPreguntas() {
    const [{ data: preguntas, error: e1 }, { data: opciones, error: e2 }] =
      await Promise.all([
        client.from("pregunta").select("*").order("numero_pregunta"),
        client.from("opcion_pregunta").select("*").order("orden")
      ]);
    if (e1) throw e1;
    if (e2) throw e2;
    return { preguntas, opciones };
  }

  window.SB = {
    client,
    rpc,
    loadPreguntas,
    config: cfg
  };
})();
