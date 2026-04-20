// API del frontend contra los CSVs estáticos y el Apps Script.
//
// Fuentes:
//   - `data/preguntas.csv`, `data/opciones.csv`, `data/flujos.csv` → CSV en el repo.
//   - Lista de estudiantes y códigos → Google Sheet vía Apps Script
//     (una hoja por clase con columnas "Nombre" / "Código").
//
// Para evitar preflight CORS con Apps Script mandamos
// Content-Type: text/plain;charset=utf-8 (POST con ese content-type es
// "simple request").

(function () {
  const cfg = window.APP_CONFIG || {};

  const paths = {
    preguntas: "./data/preguntas.csv",
    opciones:  "./data/opciones.csv",
    flujos:    "./data/flujos.csv",
  };

  let cache = null;

  function requireAppsScript() {
    if (!cfg.APPS_SCRIPT_URL || cfg.APPS_SCRIPT_URL.includes("PEGAR_")) {
      throw new Error("Falta configurar APPS_SCRIPT_URL en js/config.js");
    }
  }

  async function fetchCSV(url) {
    const r = await fetch(url + "?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error("No se pudo cargar " + url);
    return U.csvToObjects(await r.text());
  }

  async function loadAll() {
    if (cache) return cache;
    const [preguntas, opciones, flujos] = await Promise.all([
      fetchCSV(paths.preguntas),
      fetchCSV(paths.opciones),
      fetchCSV(paths.flujos),
    ]);
    cache = {
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

  // Login del estudiante: valida el código contra la Google Sheet y devuelve
  // compañeros + configuración del cuestionario.
  async function login(codigoRaw) {
    const codigo = (codigoRaw || "").trim();
    if (!codigo) return { ok: false, error: "codigo_vacio" };
    requireAppsScript();
    const [config, r] = await Promise.all([
      loadAll(),
      getJSON("login_cuestionario", { codigo }),
    ]);
    if (!r.ok) return r;
    return {
      ok: true,
      estudiante: r.estudiante,
      companeros: (r.companeros || []).sort((a, b) => a.nombre.localeCompare(b.nombre, "es")),
      preguntas: config.preguntas,
      opciones: config.opciones,
      flujos: config.flujos,
    };
  }

  async function submitRespuestas(payload) {
    requireAppsScript();
    return await postJSON({
      token: cfg.APPS_SCRIPT_TOKEN,
      codigo: payload.estudiante.codigo,
      nombre: payload.estudiante.nombre,
      clase:  payload.estudiante.clase,
      respuestas: payload.respuestas,
    });
  }

  async function adminCheck(pw) { return await getJSON("admin_check", { pw }); }
  async function fetchRespuestas(pw)  { return await getJSON("respuestas", { pw }); }
  async function fetchCompletados(pw) { return await getJSON("completados", { pw }); }
  async function fetchGrupos(pw, clase) {
    const p = { pw };
    if (clase) p.clase = clase;
    return await getJSON("grupos", p);
  }
  async function fetchClases(pw) { return await getJSON("clases", { pw }); }
  async function fetchEstudiantes(pw, clase) {
    const p = { pw };
    if (clase) p.clase = clase;
    return await getJSON("estudiantes", p);
  }

  async function saveGrupos(pw, clase, grupos) {
    return await postJSON({ action: "save_grupos", token_admin: pw, clase, grupos });
  }
  async function crearClase(pw, clase, nombres) {
    return await postJSON({ action: "crear_clase", token_admin: pw, clase, nombres: nombres || [] });
  }
  async function agregarEstudiante(pw, clase, nombre) {
    return await postJSON({ action: "agregar_estudiante", token_admin: pw, clase, nombre });
  }
  async function generarCodigos(pw, clase) {
    return await postJSON({ action: "generar_codigos", token_admin: pw, clase });
  }
  async function eliminarEstudiante(pw, clase, codigo) {
    return await postJSON({ action: "eliminar_estudiante", token_admin: pw, clase, codigo });
  }
  async function importarEstudiantes(pw, clase, estudiantes, modo) {
    return await postJSON({
      action: "importar_estudiantes",
      token_admin: pw,
      clase,
      estudiantes: estudiantes || [],
      modo: modo || "merge",
    });
  }

  // ---- Helpers HTTP ----
  // Enmascara credenciales para no imprimirlas en consola.
  function redact(body) {
    const out = Object.assign({}, body || {});
    ["token", "token_admin", "pw"].forEach(k => {
      if (out[k]) out[k] = "***" + String(out[k]).slice(-2);
    });
    return out;
  }

  async function getJSON(action, params) {
    requireAppsScript();
    const qs = Object.entries(Object.assign({ action }, params || {}))
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const url = cfg.APPS_SCRIPT_URL + "?" + qs;
    const label = `[API GET] action=${action}`;
    console.debug(label, redact(Object.assign({ action }, params || {})));
    let r;
    try { r = await fetch(url, { redirect: "follow" }); }
    catch (err) { console.error(label, "fetch_failed", err); throw err; }
    if (!r.ok) { console.error(label, "HTTP " + r.status); throw new Error("HTTP " + r.status); }
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); }
    catch (err) {
      console.error(label, "invalid_json. Body preview:", text.slice(0, 400));
      throw new Error("respuesta_no_json");
    }
    if (!json.ok) console.warn(label, "→", json);
    else console.debug(label, "→ ok", summarize(json));
    return json;
  }

  async function postJSON(body) {
    requireAppsScript();
    const label = `[API POST] action=${body && body.action ? body.action : "(submit)"}`;
    console.debug(label, redact(body));
    let r;
    try {
      r = await fetch(cfg.APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(body),
        redirect: "follow",
      });
    } catch (err) { console.error(label, "fetch_failed", err); throw err; }
    if (!r.ok) { console.error(label, "HTTP " + r.status); throw new Error("HTTP " + r.status); }
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); }
    catch (err) {
      console.error(label, "invalid_json. Body preview:", text.slice(0, 400));
      throw new Error("respuesta_no_json");
    }
    if (!json.ok) console.warn(label, "→", json);
    else console.debug(label, "→ ok", summarize(json));
    return json;
  }

  function summarize(json) {
    if (Array.isArray(json.data)) return { ok: true, "data.length": json.data.length };
    return json;
  }

  function clearCache() { cache = null; }

  window.API = {
    loadAll,
    login,
    submitRespuestas,
    adminCheck,
    fetchRespuestas,
    fetchCompletados,
    fetchGrupos,
    fetchClases,
    fetchEstudiantes,
    saveGrupos,
    crearClase,
    agregarEstudiante,
    generarCodigos,
    eliminarEstudiante,
    importarEstudiantes,
    clearCache,
  };
})();
