// API del frontend contra los CSVs estáticos y el Apps Script.
//
// - Carga `data/estudiantes.csv`, `data/preguntas.csv`, `data/opciones.csv`
//   y `data/flujos.csv` al iniciar.
// - `login(codigo)` devuelve el estudiante + sus compañeros (misma clase).
// - `submitRespuestas({ estudiante, respuestas })` hace POST al Apps Script.
//
// Para evitar preflight CORS con Apps Script mandamos Content-Type:
// text/plain;charset=utf-8 (POST con ese content-type es "simple request").

(function () {
  const cfg = window.APP_CONFIG || {};

  const paths = {
    estudiantes: "./data/estudiantes.csv",
    preguntas:   "./data/preguntas.csv",
    opciones:    "./data/opciones.csv",
    flujos:      "./data/flujos.csv",
  };

  let cache = null;

  async function fetchCSV(url) {
    const r = await fetch(url + "?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error("No se pudo cargar " + url);
    return U.csvToObjects(await r.text());
  }

  async function loadAll() {
    if (cache) return cache;
    const [estudiantes, preguntas, opciones, flujos] = await Promise.all([
      fetchCSV(paths.estudiantes),
      fetchCSV(paths.preguntas),
      fetchCSV(paths.opciones),
      fetchCSV(paths.flujos),
    ]);
    cache = {
      estudiantes: estudiantes
        .map(e => ({
          codigo: (e.codigo || "").trim(),
          nombre: (e.nombre || "").trim(),
          clase:  (e.clase  || "").trim(),
        }))
        .filter(e => e.codigo),
      preguntas: preguntas
        .map(p => ({
          numero: parseInt(p.numero, 10),
          texto:  (p.texto || "").trim(),
          tipo:   (p.tipo  || "").trim().toUpperCase(),
        }))
        .filter(p => p.numero && p.texto)
        .sort((a, b) => a.numero - b.numero),
      opciones: opciones
        .map(o => ({
          numero_pregunta: parseInt(o.numero_pregunta, 10),
          orden:           parseInt(o.orden, 10),
          texto:           (o.texto || "").trim(),
        }))
        .filter(o => o.numero_pregunta && o.texto)
        .sort((a, b) => (a.numero_pregunta - b.numero_pregunta) || (a.orden - b.orden)),
      flujos: flujos
        .map(f => ({
          numero_pregunta:     parseInt(f.numero_pregunta, 10),
          opcion_orden:        parseInt(f.opcion_orden, 10),
          siguiente_pregunta:  f.siguiente_pregunta === "" || f.siguiente_pregunta == null
                               ? null
                               : parseInt(f.siguiente_pregunta, 10),
        }))
        .filter(f => f.numero_pregunta && f.opcion_orden),
    };
    return cache;
  }

  async function login(codigoRaw) {
    const codigo = (codigoRaw || "").trim();
    if (!codigo) return { ok: false, error: "codigo_vacio" };
    const data = await loadAll();
    const est = data.estudiantes.find(e => e.codigo === codigo);
    if (!est) return { ok: false, error: "no_encontrado" };
    const companeros = data.estudiantes
      .filter(e => e.clase === est.clase && e.codigo !== est.codigo)
      .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    return {
      ok: true,
      estudiante: est,
      companeros,
      preguntas: data.preguntas,
      opciones: data.opciones,
      flujos: data.flujos,
    };
  }

  async function submitRespuestas(payload) {
    if (!cfg.APPS_SCRIPT_URL || cfg.APPS_SCRIPT_URL.includes("PEGAR_")) {
      throw new Error("Falta configurar APPS_SCRIPT_URL en js/config.js");
    }
    const body = JSON.stringify({
      token: cfg.APPS_SCRIPT_TOKEN,
      codigo: payload.estudiante.codigo,
      nombre: payload.estudiante.nombre,
      clase:  payload.estudiante.clase,
      respuestas: payload.respuestas,
    });
    // Content-Type text/plain evita preflight CORS con Apps Script.
    const r = await fetch(cfg.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body,
      redirect: "follow",
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  }

  // Para cache-busting cuando el docente edita CSVs en el repo sin esperar el bust del fetch.
  function clearCache() { cache = null; }

  window.API = { loadAll, login, submitRespuestas, clearCache };
})();
