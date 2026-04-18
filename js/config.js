// Configuración del cliente. Editá estos tres valores con los tuyos.
//
// SUPABASE_URL y SUPABASE_ANON_KEY los encontrás en
//   Supabase → Project Settings → API
//
// ADMIN_PASSWORD es la misma contraseña que cargaste en la tabla
//   app_config del schema.sql. Se valida del lado del servidor en cada
//   RPC, así que cambiarla acá sin actualizarla en Supabase no sirve.
window.APP_CONFIG = {
  SUPABASE_URL: "https://TU-PROYECTO.supabase.co",
  SUPABASE_ANON_KEY: "TU_ANON_KEY",
  ADMIN_PASSWORD: "cambiame"
};
