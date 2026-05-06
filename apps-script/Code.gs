/**
 * Backend del sociograma sobre Google Apps Script.
 *
 * MODELO DE DATOS:
 *   - Una hoja por clase (nombre del tab = identificador de la clase).
 *     Cada hoja tiene columnas `Nombre` y `Código`. El docente carga los
 *     nombres y luego pulsa "Generar códigos" en el dashboard, que llama
 *     a `accion=generar_codigos` y completa los códigos faltantes.
 *   - Hojas reservadas (no son clases): `respuestas`, `completados`,
 *     `grupos`. También se ignoran las hojas cuyo header no incluya
 *     "Nombre" / "Código".
 *
 * Endpoints:
 *   POST /exec
 *     body { token, codigo, nombre, clase, respuestas }       → cuestionario
 *     Para acciones admin todas llevan id_token (Google id_token JWT del
 *     usuario logueado, dominio @ADMIN_DOMAIN):
 *     body { action: "save_grupos", id_token, ... }
 *     body { action: "crear_clase", id_token, clase, nombres? }
 *     body { action: "agregar_estudiante", id_token, clase, nombre }
 *     body { action: "generar_codigos", id_token, clase }
 *     body { action: "eliminar_estudiante", id_token, clase, codigo }
 *     body { action: "borrar_respuestas",   id_token, clase, codigo }   → habilita reenvío
 *     body { action: "importar_estudiantes", id_token, clase, estudiantes:[{codigo,nombre}], modo }
 *
 *   GET /exec
 *     ?action=ping                                    → healthcheck (público)
 *     ?action=admin_check&id_token=...                → valida Google id_token
 *     ?action=login_cuestionario&codigo=...           → login de alumno (público)
 *     ?action=clases&id_token=...                     → lista de clases con conteo
 *     ?action=estudiantes&id_token=...[&clase=]       → estudiantes (todas o una clase)
 *     ?action=respuestas&id_token=...                 → hoja `respuestas`
 *     ?action=completados&id_token=...                → hoja `completados`
 *     ?action=grupos&id_token=...[&clase=]            → grupos guardados
 *     ?action=fotos_clase&id_token=...&clase=...      → fotos de la clase
 *                                                       (lee Drive, opcional)
 *
 * Después de cambiar este archivo: "Implementar → Administrar
 * implementaciones → editar → Versión nueva".
 */

const CONFIG = {
  SHEET_ID: "1WpNz1Qj1elOq5GxEBNBGq8bOyhZw88SaRs0wx5Al76Q",
  TOKEN: "d7d1e6cb97cca059ffcdd126d5f4132a76e99442382f29cf",
  // Contraseña heredada (no se usa para autorizar acciones nuevas, queda
  // sólo por si querés volver a habilitar el modo password). El admin real
  // ahora se valida con Google Sign-In + dominio.
  ADMIN_PASSWORD: "Colegio4392HCA",
  // OAuth Client ID (Web application) creado en Google Cloud Console.
  GOOGLE_CLIENT_ID: "1096411533432-sdaj35tq8q0gvq0sir5k008ru59b6sfa.apps.googleusercontent.com",
  // Sólo usuarios con email @ADMIN_DOMAIN pueden ejecutar acciones admin.
  ADMIN_DOMAIN: "hca.edu.uy",
  // ID de la carpeta de Drive con las fotos de los estudiantes. Estructura
  // esperada: <FOTOS_FOLDER_ID>/<nombre_de_la_clase>/<archivos>. Cada
  // archivo debe terminar con _<cedula>.<ext> (ej. ALBINI_CABRAL_Tomas_60094744.jpg).
  // Dejar vacío para desactivar la función de fotos: el sistema cae a
  // avatares con iniciales sin error.
  // La cuenta dueña del Apps Script tiene que tener acceso de lectura a
  // esta carpeta. La primera vez que se llame `fotos_clase`, Apps Script
  // va a pedir autorización del scope Drive readonly.
  FOTOS_FOLDER_ID: "1SgBNVimK62gXsXJEcqZtJW4hk6QoxF6L",
};

const HOJA_RESPUESTAS = "respuestas";
const HOJA_COMPLETADOS = "completados";
const HOJA_GRUPOS = "grupos";
const HOJAS_RESERVADAS = [HOJA_RESPUESTAS, HOJA_COMPLETADOS, HOJA_GRUPOS];

const HEADERS_RESPUESTAS = [
  "timestamp", "codigo", "nombre", "clase",
  "numero_pregunta", "texto_pregunta",
  "evaluado_codigo", "evaluado_nombre",
  "opcion_texto", "otro_texto",
];
const HEADERS_COMPLETADOS = ["codigo", "nombre", "clase", "completado_at"];
const HEADERS_GRUPOS = ["clase", "nombre_grupo", "codigos", "nombres", "saved_at"];
const HEADERS_CLASE = ["Nombre", "Código"];

// Caracteres del código generado: alfanumérico sin caracteres ambiguos
// (sin 0/O/1/I/L) para evitar errores al copiar a mano.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 6;
const CACHE_TTL_LOGIN = 60;       // segundos
const CACHE_KEY_LOGIN = "login_v2";

// ---------- POST ----------
// El lock global se eliminó de aquí: bajo carga (toda una clase enviando a la
// vez) hacía que muchos alumnos recibieran `lock_timeout`. Cada handler decide
// su propio bloqueo:
//   - submitRespuestas: lock corto con reintentos + fallback con appendRow
//     atómico. Las respuestas del alumno SIEMPRE se persisten.
//   - acciones admin: withLock() con timeout amplio (rara vez concurrentes).
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ ok: false, error: "empty_body" });
    }
    let body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (err) {
      return jsonResponse({ ok: false, error: "invalid_json" });
    }

    switch (body.action) {
      case "save_grupos":          return withLock(() => saveGrupos(body), 30000);
      case "crear_clase":          return withLock(() => crearClase(body), 30000);
      case "agregar_estudiante":   return withLock(() => agregarEstudiante(body), 30000);
      case "generar_codigos":      return withLock(() => generarCodigos(body), 45000);
      case "eliminar_estudiante":  return withLock(() => eliminarEstudiante(body), 30000);
      case "borrar_respuestas":    return withLock(() => borrarRespuestas(body), 45000);
      case "importar_estudiantes": return withLock(() => importarEstudiantes(body), 60000);
      case "debug_auth":           return debugAuth(body);
      default:                     return submitRespuestas(body);
    }
  } catch (err) {
    console.error(err);
    return jsonResponse({ ok: false, error: "server_error", detail: String(err) });
  }
}

// Lock con reintentos (jitter) y un timeout total. Devuelve un jsonResponse
// con `error: "lock_timeout"` sólo si nunca pudo agarrarlo en `totalMs`.
function withLock(fn, totalMs) {
  const lock = LockService.getScriptLock();
  const deadline = Date.now() + (totalMs || 30000);
  let acquired = false;
  while (Date.now() < deadline) {
    try {
      lock.waitLock(Math.min(5000, Math.max(500, deadline - Date.now())));
      acquired = true;
      break;
    } catch (e) {
      Utilities.sleep(200 + Math.floor(Math.random() * 600));
    }
  }
  if (!acquired) return jsonResponse({ ok: false, error: "lock_timeout" });
  try { return fn(); }
  finally { lock.releaseLock(); }
}

function submitRespuestas(body) {
  if (body.token !== CONFIG.TOKEN) return jsonResponse({ ok: false, error: "forbidden" });
  const codigo = String(body.codigo || "").trim();
  const nombre = String(body.nombre || "").trim();
  const clase = String(body.clase || "").trim();
  const respuestas = Array.isArray(body.respuestas) ? body.respuestas : [];
  if (!codigo) return jsonResponse({ ok: false, error: "codigo_vacio" });
  if (!respuestas.length) return jsonResponse({ ok: false, error: "sin_respuestas" });

  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  if (!validarCodigoContraSheet(ss, codigo)) {
    return jsonResponse({ ok: false, error: "codigo_invalido" });
  }
  const hojaResp = obtenerHoja(ss, HOJA_RESPUESTAS, HEADERS_RESPUESTAS);
  const hojaCompl = obtenerHoja(ss, HOJA_COMPLETADOS, HEADERS_COMPLETADOS);

  if (yaCompleto(hojaCompl, codigo)) return jsonResponse({ ok: false, error: "ya_completado" });

  const now = new Date();
  const filas = respuestas.map((r) => [
    now, codigo, nombre, clase,
    r.numero_pregunta || "", r.texto_pregunta || "",
    r.evaluado_codigo || "", r.evaluado_nombre || "",
    r.opcion_texto || "", r.otro_texto || "",
  ]);

  // Intento rápido con lock (vía batch setValues, eficiente). Si bajo carga
  // alta no se obtiene en ~12s, caemos al modo "appendRow por fila": cada
  // appendRow es atómico internamente en Apps Script y NO lanza lock_timeout,
  // así garantizamos que las respuestas del alumno SIEMPRE persisten.
  const lock = LockService.getScriptLock();
  let acquired = false;
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try {
      lock.waitLock(Math.min(3000, Math.max(500, deadline - Date.now())));
      acquired = true;
      break;
    } catch (e) {
      Utilities.sleep(200 + Math.floor(Math.random() * 600));
    }
  }

  if (acquired) {
    try {
      // Re-chequear yaCompleto bajo lock para evitar dobles envíos por carrera.
      if (yaCompleto(hojaCompl, codigo)) {
        return jsonResponse({ ok: false, error: "ya_completado" });
      }
      if (filas.length) {
        hojaResp.getRange(hojaResp.getLastRow() + 1, 1, filas.length, HEADERS_RESPUESTAS.length).setValues(filas);
      }
      hojaCompl.appendRow([codigo, nombre, clase, now]);
      return jsonResponse({ ok: true, filas_guardadas: filas.length, modo: "batch" });
    } finally {
      lock.releaseLock();
    }
  }

  // Fallback robusto: appendRow por fila (atómico). Algo más lento pero a
  // prueba de carga. Marcamos las filas con sufijo en `clase` para que el
  // admin pueda identificarlas si quisiera, pero NO es obligatorio: los datos
  // están todos ahí.
  for (let i = 0; i < filas.length; i++) {
    hojaResp.appendRow(filas[i]);
  }
  hojaCompl.appendRow([codigo, nombre, clase, now]);
  return jsonResponse({ ok: true, filas_guardadas: filas.length, modo: "fallback_append" });
}

function saveGrupos(body) {
  if (body.token_admin !== CONFIG.ADMIN_PASSWORD) {
    return jsonResponse({ ok: false, error: "forbidden" });
  }
  const clase = String(body.clase || "").trim();
  const grupos = Array.isArray(body.grupos) ? body.grupos : [];
  if (!clase) return jsonResponse({ ok: false, error: "clase_vacia" });

  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const hoja = obtenerHoja(ss, HOJA_GRUPOS, HEADERS_GRUPOS);

  const last = hoja.getLastRow();
  if (last >= 2) {
    const valores = hoja.getRange(2, 1, last - 1, HEADERS_GRUPOS.length).getValues();
    for (let i = valores.length - 1; i >= 0; i--) {
      if (String(valores[i][0]).trim() === clase) hoja.deleteRow(i + 2);
    }
  }
  const now = new Date();
  const filas = grupos.map((g) => [
    clase, g.nombre || "",
    (g.codigos || []).join(", "),
    (g.nombres || []).join(", "),
    now,
  ]);
  if (filas.length) {
    hoja.getRange(hoja.getLastRow() + 1, 1, filas.length, HEADERS_GRUPOS.length).setValues(filas);
  }
  return jsonResponse({ ok: true, guardados: filas.length });
}

function crearClase(body) {
  const admin = verificarAdminToken(body.id_token);
  if (!admin) return jsonResponse({ ok: false, error: "unauthorized" });
  const clase = String(body.clase || "").trim();
  if (!clase) return jsonResponse({ ok: false, error: "clase_vacia" });
  if (esHojaReservada(clase)) return jsonResponse({ ok: false, error: "nombre_reservado" });

  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  if (ss.getSheetByName(clase)) return jsonResponse({ ok: false, error: "clase_existe" });
  const hoja = ss.insertSheet(clase);
  hoja.appendRow(HEADERS_CLASE);
  hoja.setFrozenRows(1);
  hoja.setColumnWidth(1, 240);
  hoja.setColumnWidth(2, 120);

  const nombres = Array.isArray(body.nombres) ? body.nombres : [];
  if (nombres.length) {
    const filas = nombres
      .map((n) => String(n || "").trim())
      .filter(Boolean)
      .map((n) => [n, ""]);
    if (filas.length) hoja.getRange(2, 1, filas.length, 2).setValues(filas);
  }
  invalidarCacheLogin();
  return jsonResponse({ ok: true, clase, agregados: (Array.isArray(body.nombres) ? body.nombres.length : 0) });
}

function agregarEstudiante(body) {
  const admin = verificarAdminToken(body.id_token);
  if (!admin) return jsonResponse({ ok: false, error: "unauthorized" });
  const clase = String(body.clase || "").trim();
  const nombre = String(body.nombre || "").trim();
  if (!clase || !nombre) return jsonResponse({ ok: false, error: "datos_incompletos" });
  if (esHojaReservada(clase)) return jsonResponse({ ok: false, error: "nombre_reservado" });

  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const hoja = obtenerHojaClase(ss, clase, true);
  hoja.appendRow([nombre, ""]);
  invalidarCacheLogin();
  return jsonResponse({ ok: true, clase, nombre });
}

function eliminarEstudiante(body) {
  const admin = verificarAdminToken(body.id_token);
  if (!admin) return jsonResponse({ ok: false, error: "unauthorized" });
  const clase = String(body.clase || "").trim();
  const codigo = String(body.codigo || "").trim();
  if (!clase || !codigo) return jsonResponse({ ok: false, error: "datos_incompletos" });

  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const hoja = obtenerHojaClase(ss, clase, false);
  if (!hoja) return jsonResponse({ ok: false, error: "clase_no_existe" });
  const last = hoja.getLastRow();
  if (last < 2) return jsonResponse({ ok: false, error: "vacio" });
  const cols = mapaColumnasClase(hoja);
  const valores = hoja.getRange(2, 1, last - 1, hoja.getLastColumn()).getValues();
  let borrados = 0;
  for (let i = valores.length - 1; i >= 0; i--) {
    const cod = String(valores[i][cols.codigo] || "").trim();
    if (cod === codigo) { hoja.deleteRow(i + 2); borrados++; }
  }
  invalidarCacheLogin();
  return jsonResponse({ ok: true, borrados });
}

// Habilita el reenvío del cuestionario para un alumno: borra todas sus
// filas en `respuestas` y su fila en `completados`. La próxima vez que
// el alumno entre con su código va a poder enviar como si fuese la
// primera vez. Es idempotente: si no había nada que borrar, devuelve 0.
function borrarRespuestas(body) {
  const admin = verificarAdminToken(body.id_token);
  if (!admin) return jsonResponse({ ok: false, error: "unauthorized" });
  const clase = String(body.clase || "").trim();
  const codigo = String(body.codigo || "").trim();
  if (!codigo) return jsonResponse({ ok: false, error: "codigo_vacio" });

  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const hojaResp = obtenerHoja(ss, HOJA_RESPUESTAS, HEADERS_RESPUESTAS);
  const hojaCompl = obtenerHoja(ss, HOJA_COMPLETADOS, HEADERS_COMPLETADOS);

  // `respuestas`: barrer de abajo hacia arriba para deletear sin reindexar.
  let borradasResp = 0;
  const lastResp = hojaResp.getLastRow();
  if (lastResp >= 2) {
    const colCodigo = HEADERS_RESPUESTAS.indexOf("codigo");
    const valores = hojaResp.getRange(2, 1, lastResp - 1, HEADERS_RESPUESTAS.length).getValues();
    for (let i = valores.length - 1; i >= 0; i--) {
      if (String(valores[i][colCodigo] || "").trim() === codigo) {
        hojaResp.deleteRow(i + 2);
        borradasResp++;
      }
    }
  }

  // `completados`: igual.
  let borradasCompl = 0;
  const lastCompl = hojaCompl.getLastRow();
  if (lastCompl >= 2) {
    const colCodigo = HEADERS_COMPLETADOS.indexOf("codigo");
    const valores = hojaCompl.getRange(2, 1, lastCompl - 1, HEADERS_COMPLETADOS.length).getValues();
    for (let i = valores.length - 1; i >= 0; i--) {
      if (String(valores[i][colCodigo] || "").trim() === codigo) {
        hojaCompl.deleteRow(i + 2);
        borradasCompl++;
      }
    }
  }

  return jsonResponse({
    ok: true, codigo, clase,
    respuestas_borradas: borradasResp,
    completados_borrados: borradasCompl,
  });
}

// Diagnóstico de autenticación con Google. Verifica el id_token contra el
// endpoint público de Google y devuelve metadata útil (no expone secretos).
function debugAuth(body) {
  const idToken = String((body && body.id_token) || "");
  if (!idToken) {
    return jsonResponse({ ok: true, match: false, reason: "sin_id_token" });
  }
  const info = consultarTokenInfo(idToken);
  if (!info) {
    return jsonResponse({
      ok: true, match: false, reason: "tokeninfo_falló",
      sent_length: idToken.length,
      expected_audience: CONFIG.GOOGLE_CLIENT_ID,
      expected_domain: CONFIG.ADMIN_DOMAIN,
    });
  }
  const audOk = info.aud === CONFIG.GOOGLE_CLIENT_ID;
  const domainOk = String(info.email || "").toLowerCase().endsWith("@" + CONFIG.ADMIN_DOMAIN.toLowerCase());
  const emailVerified = info.email_verified === "true" || info.email_verified === true;
  const expira = info.exp ? new Date(Number(info.exp) * 1000).toISOString() : null;
  return jsonResponse({
    ok: true,
    match: audOk && domainOk && emailVerified,
    audience_ok: audOk,
    domain_ok: domainOk,
    email_verified: emailVerified,
    email: info.email || null,
    name: info.name || null,
    aud_received: info.aud || null,
    aud_expected: CONFIG.GOOGLE_CLIENT_ID,
    domain_expected: CONFIG.ADMIN_DOMAIN,
    expira,
  });
}

// Llama al endpoint de Google y devuelve los claims si el token es válido y
// pertenece a una cuenta del dominio configurado, o null si no.
// Cachea el resultado por unos minutos para no martillar la API en cada llamada.
function verificarAdminToken(idToken) {
  if (!idToken) return null;
  const info = consultarTokenInfo(idToken);
  if (!info) return null;
  if (info.aud !== CONFIG.GOOGLE_CLIENT_ID) return null;
  if (!(info.email_verified === "true" || info.email_verified === true)) return null;
  const email = String(info.email || "").toLowerCase();
  if (!email.endsWith("@" + String(CONFIG.ADMIN_DOMAIN).toLowerCase())) return null;
  if (info.exp && Number(info.exp) * 1000 < Date.now()) return null;
  return { email: info.email, name: info.name || info.email };
}

function consultarTokenInfo(idToken) {
  const cache = CacheService.getScriptCache();
  const key = "tok:" + Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken)
    .map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, "0")).join("");
  const cached = cache.get(key);
  if (cached) return JSON.parse(cached);
  try {
    const r = UrlFetchApp.fetch(
      "https://www.googleapis.com/oauth2/v3/tokeninfo?id_token=" + encodeURIComponent(idToken),
      { muteHttpExceptions: true }
    );
    if (r.getResponseCode() !== 200) return null;
    const info = JSON.parse(r.getContentText());
    // Cache hasta el exp del token o 5 min (lo que ocurra antes).
    const ttl = Math.max(60, Math.min(300, info.exp ? Number(info.exp) - Math.floor(Date.now()/1000) : 300));
    cache.put(key, JSON.stringify(info), ttl);
    return info;
  } catch (e) {
    console.error("consultarTokenInfo:", e);
    return null;
  }
}

function importarEstudiantes(body) {
  const admin = verificarAdminToken(body.id_token);
  if (!admin) return jsonResponse({ ok: false, error: "unauthorized" });
  const clase = String(body.clase || "").trim();
  if (!clase) return jsonResponse({ ok: false, error: "clase_vacia" });
  if (esHojaReservada(clase)) return jsonResponse({ ok: false, error: "nombre_reservado" });

  const estudiantes = Array.isArray(body.estudiantes) ? body.estudiantes : [];
  const modo = String(body.modo || "merge").toLowerCase();
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);

  // Índice global de códigos → clase, para detectar conflictos cross-clase.
  const usadosGlobal = {};
  ss.getSheets().forEach((h) => {
    const n = h.getName();
    if (esHojaReservada(n)) return;
    try { mapaColumnasClase(h); } catch (e) { return; }
    leerEstudiantesClase(ss, n).forEach((e) => {
      if (e.codigo) usadosGlobal[e.codigo] = n;
    });
  });

  const hoja = obtenerHojaClase(ss, clase, true);
  const cols = mapaColumnasClase(hoja);

  if (modo === "reemplazar") {
    const last = hoja.getLastRow();
    if (last >= 2) hoja.getRange(2, 1, last - 1, hoja.getLastColumn()).clearContent();
  }

  // Mapa código → nro fila (1-based) en la hoja actual.
  const mapaExistente = {};
  {
    const last = hoja.getLastRow();
    if (last >= 2) {
      const v = hoja.getRange(2, 1, last - 1, hoja.getLastColumn()).getValues();
      for (let i = 0; i < v.length; i++) {
        const cod = String(v[i][cols.codigo] || "").trim();
        if (cod) mapaExistente[cod] = i + 2;
      }
    }
  }

  let agregados = 0, actualizados = 0, conflictos = [], invalidos = 0;
  const filasNuevas = [];
  estudiantes.forEach((e) => {
    const codigo = String((e && e.codigo) || "").trim();
    const nombre = String((e && e.nombre) || "").trim();
    if (!codigo || !nombre) { invalidos++; return; }

    const duenio = usadosGlobal[codigo];
    if (duenio && duenio !== clase) {
      conflictos.push({ codigo, nombre, clase_actual: duenio });
      return;
    }
    const filaExistente = mapaExistente[codigo];
    if (filaExistente) {
      // Actualizar nombre si cambió.
      const actual = String(hoja.getRange(filaExistente, cols.nombre + 1).getValue() || "").trim();
      if (actual !== nombre) {
        hoja.getRange(filaExistente, cols.nombre + 1).setValue(nombre);
        actualizados++;
      }
    } else {
      const fila = new Array(hoja.getLastColumn() || 2).fill("");
      fila[cols.nombre] = nombre;
      fila[cols.codigo] = codigo;
      filasNuevas.push(fila);
      mapaExistente[codigo] = -1; // marcar como pendiente
      usadosGlobal[codigo] = clase;
      agregados++;
    }
  });

  if (filasNuevas.length) {
    const desde = hoja.getLastRow() + 1;
    hoja.getRange(desde, 1, filasNuevas.length, filasNuevas[0].length).setValues(filasNuevas);
  }

  invalidarCacheLogin();
  return jsonResponse({
    ok: true, clase, agregados, actualizados, invalidos,
    conflictos: conflictos.slice(0, 20),
    conflictos_total: conflictos.length,
  });
}

function generarCodigos(body) {
  const admin = verificarAdminToken(body.id_token);
  if (!admin) return jsonResponse({ ok: false, error: "unauthorized" });
  const clase = String(body.clase || "").trim();
  if (!clase) return jsonResponse({ ok: false, error: "clase_vacia" });

  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const hoja = obtenerHojaClase(ss, clase, false);
  if (!hoja) return jsonResponse({ ok: false, error: "clase_no_existe" });
  const cols = mapaColumnasClase(hoja);
  const last = hoja.getLastRow();
  if (last < 2) return jsonResponse({ ok: true, generados: 0 });

  // Set global de códigos ya en uso (para garantizar unicidad cross-clase).
  const usados = recolectarCodigosUsados(ss);

  const rango = hoja.getRange(2, 1, last - 1, hoja.getLastColumn());
  const valores = rango.getValues();
  let generados = 0;
  for (let i = 0; i < valores.length; i++) {
    const nombre = String(valores[i][cols.nombre] || "").trim();
    let codigo = String(valores[i][cols.codigo] || "").trim();
    if (!nombre) continue;
    if (codigo) { usados[codigo] = true; continue; }
    codigo = generarCodigoUnico(usados);
    usados[codigo] = true;
    valores[i][cols.codigo] = codigo;
    generados++;
  }
  if (generados > 0) rango.setValues(valores);
  invalidarCacheLogin();
  return jsonResponse({ ok: true, generados });
}

// ---------- GET ----------
function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const action = String(params.action || "ping");

    // Endpoints públicos.
    if (action === "ping") {
      return jsonResponse({ ok: true, service: "sociogramas", time: new Date() });
    }
    if (action === "admin_check") {
      // Validamos un Google id_token y devolvemos el email del admin si pasó.
      const admin = verificarAdminToken(params.id_token);
      return jsonResponse({ ok: !!admin, email: admin && admin.email, name: admin && admin.name });
    }
    if (action === "login_cuestionario") {
      return loginCuestionario(String(params.codigo || "").trim());
    }

    // A partir de acá, todas las acciones requieren un id_token válido.
    const admin = verificarAdminToken(params.id_token);
    if (!admin) {
      return jsonResponse({ ok: false, error: "unauthorized" });
    }
    const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    if (action === "clases") {
      return jsonResponse({ ok: true, data: listarClases(ss) });
    }
    if (action === "estudiantes") {
      const clase = String(params.clase || "").trim();
      const data = clase ? leerEstudiantesClase(ss, clase) : leerTodosLosEstudiantes(ss);
      return jsonResponse({ ok: true, data });
    }
    if (action === "respuestas") {
      const hoja = obtenerHoja(ss, HOJA_RESPUESTAS, HEADERS_RESPUESTAS);
      return jsonResponse({ ok: true, data: hojaToObjects(hoja) });
    }
    if (action === "completados") {
      const hoja = obtenerHoja(ss, HOJA_COMPLETADOS, HEADERS_COMPLETADOS);
      return jsonResponse({ ok: true, data: hojaToObjects(hoja) });
    }
    if (action === "grupos") {
      const hoja = obtenerHoja(ss, HOJA_GRUPOS, HEADERS_GRUPOS);
      let data = hojaToObjects(hoja);
      if (params.clase) data = data.filter((g) => String(g.clase || "").trim() === String(params.clase).trim());
      return jsonResponse({ ok: true, data });
    }
    if (action === "fotos_clase") {
      return fotosClase(String(params.clase || "").trim());
    }
    return jsonResponse({ ok: false, error: "accion_desconocida" });
  } catch (err) {
    console.error(err);
    return jsonResponse({ ok: false, error: "server_error", detail: String(err) });
  }
}

// ---------- Lectura de roster ----------
function listarClases(ss) {
  return ss.getSheets()
    .map((h) => h.getName())
    .filter((n) => !esHojaReservada(n))
    .map((n) => {
      const hoja = ss.getSheetByName(n);
      let cols;
      try { cols = mapaColumnasClase(hoja); } catch (e) { return null; }
      const last = hoja.getLastRow();
      let total = 0, conCodigo = 0;
      if (last >= 2) {
        const v = hoja.getRange(2, 1, last - 1, hoja.getLastColumn()).getValues();
        for (let i = 0; i < v.length; i++) {
          const nombre = String(v[i][cols.nombre] || "").trim();
          const codigo = String(v[i][cols.codigo] || "").trim();
          if (!nombre) continue;
          total++;
          if (codigo) conCodigo++;
        }
      }
      return { clase: n, total, con_codigo: conCodigo, sin_codigo: total - conCodigo };
    })
    .filter(Boolean);
}

function leerEstudiantesClase(ss, clase) {
  const hoja = obtenerHojaClase(ss, clase, false);
  if (!hoja) return [];
  const cols = mapaColumnasClase(hoja);
  const last = hoja.getLastRow();
  if (last < 2) return [];
  const v = hoja.getRange(2, 1, last - 1, hoja.getLastColumn()).getValues();
  const out = [];
  for (let i = 0; i < v.length; i++) {
    const nombre = String(v[i][cols.nombre] || "").trim();
    const codigo = String(v[i][cols.codigo] || "").trim();
    if (!nombre) continue;
    out.push({ codigo, nombre, clase });
  }
  return out;
}

function leerTodosLosEstudiantes(ss) {
  const out = [];
  ss.getSheets().forEach((hoja) => {
    const n = hoja.getName();
    if (esHojaReservada(n)) return;
    try { mapaColumnasClase(hoja); } catch (e) { return; }
    leerEstudiantesClase(ss, n).forEach((e) => out.push(e));
  });
  return out;
}

function loginCuestionario(codigo) {
  if (!codigo) return jsonResponse({ ok: false, error: "codigo_vacio" });
  const cache = CacheService.getScriptCache();
  let snapshot = cache.get(CACHE_KEY_LOGIN);
  if (snapshot) {
    snapshot = JSON.parse(snapshot);
  } else {
    const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    snapshot = leerTodosLosEstudiantes(ss);
    cache.put(CACHE_KEY_LOGIN, JSON.stringify(snapshot), CACHE_TTL_LOGIN);
  }
  const est = snapshot.find((e) => e.codigo === codigo);
  if (!est) return jsonResponse({ ok: false, error: "no_encontrado" });
  const companeros = snapshot
    .filter((e) => e.clase === est.clase && e.codigo !== est.codigo && e.codigo)
    .map((e) => ({ codigo: e.codigo, nombre: e.nombre, clase: e.clase }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  return jsonResponse({ ok: true, estudiante: est, companeros });
}

function validarCodigoContraSheet(ss, codigo) {
  // Reusamos el cache de login (mismo snapshot).
  const cache = CacheService.getScriptCache();
  let snapshot = cache.get(CACHE_KEY_LOGIN);
  if (!snapshot) {
    snapshot = JSON.stringify(leerTodosLosEstudiantes(ss));
    cache.put(CACHE_KEY_LOGIN, snapshot, CACHE_TTL_LOGIN);
  }
  const arr = JSON.parse(snapshot);
  return arr.some((e) => e.codigo === codigo);
}

function invalidarCacheLogin() {
  try { CacheService.getScriptCache().remove(CACHE_KEY_LOGIN); } catch (e) {}
}

// ---------- Helpers de hojas ----------
function obtenerHoja(ss, nombre, headers) {
  let hoja = ss.getSheetByName(nombre);
  if (!hoja) {
    hoja = ss.insertSheet(nombre);
    hoja.appendRow(headers);
    hoja.setFrozenRows(1);
    return hoja;
  }
  if (hoja.getLastRow() === 0) {
    hoja.appendRow(headers);
    hoja.setFrozenRows(1);
  }
  return hoja;
}

function obtenerHojaClase(ss, clase, crearSiFalta) {
  let hoja = ss.getSheetByName(clase);
  if (!hoja) {
    if (!crearSiFalta) return null;
    hoja = ss.insertSheet(clase);
    hoja.appendRow(HEADERS_CLASE);
    hoja.setFrozenRows(1);
    return hoja;
  }
  if (hoja.getLastRow() === 0) {
    hoja.appendRow(HEADERS_CLASE);
    hoja.setFrozenRows(1);
  }
  return hoja;
}

function mapaColumnasClase(hoja) {
  const last = hoja.getLastColumn();
  const headers = hoja.getRange(1, 1, 1, last).getValues()[0].map((h) => String(h || "").trim().toLowerCase());
  const nombre = headers.indexOf("nombre");
  let codigo = headers.indexOf("código");
  if (codigo < 0) codigo = headers.indexOf("codigo");
  if (nombre < 0 || codigo < 0) {
    throw new Error('La hoja "' + hoja.getName() + '" debe tener columnas "Nombre" y "Código".');
  }
  return { nombre, codigo };
}

function esHojaReservada(nombre) {
  return HOJAS_RESERVADAS.indexOf(nombre) >= 0;
}

function recolectarCodigosUsados(ss) {
  const usados = {};
  leerTodosLosEstudiantes(ss).forEach((e) => { if (e.codigo) usados[e.codigo] = true; });
  return usados;
}

function generarCodigoUnico(usados) {
  for (let intento = 0; intento < 200; intento++) {
    let c = "";
    for (let i = 0; i < CODE_LEN; i++) {
      c += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
    }
    if (!usados[c]) return c;
  }
  // Plan B: agrandar un dígito.
  for (let intento = 0; intento < 200; intento++) {
    let c = "";
    for (let i = 0; i < CODE_LEN + 1; i++) {
      c += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
    }
    if (!usados[c]) return c;
  }
  throw new Error("No se pudo generar un código único");
}

function hojaToObjects(hoja) {
  const last = hoja.getLastRow();
  if (last < 2) return [];
  const values = hoja.getRange(1, 1, last, hoja.getLastColumn()).getValues();
  const headers = values[0].map((h) => String(h).trim());
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = {};
    headers.forEach((h, j) => {
      let v = values[i][j];
      if (v instanceof Date) v = v.toISOString();
      row[h] = v;
    });
    out.push(row);
  }
  return out;
}

// Lista las fotos de los estudiantes de una clase. Estructura esperada en
// Drive: <FOTOS_FOLDER_ID>/<nombre_clase>/<archivos>. El nombre del archivo
// debe terminar con `_<cedula>.<ext>` (ej. ALBINI_CABRAL_Tomas_60094744.jpg).
// Devuelve un map codigo → file_id que el frontend usa para construir
// thumbnail URLs de Drive. Cachea 10 min para no listar Drive en cada
// carga.
//
// Si FOTOS_FOLDER_ID no está configurado, la subcarpeta no existe, o
// alguno de los pasos falla, devuelve `{ok: true, fotos: [], reason: ...}`
// — el frontend cae transparentemente a avatares con iniciales.
function fotosClase(clase) {
  if (!clase) return jsonResponse({ ok: true, fotos: [], reason: "clase_vacia" });
  if (!CONFIG.FOTOS_FOLDER_ID) return jsonResponse({ ok: true, fotos: [], reason: "fotos_no_configuradas" });

  const cache = CacheService.getScriptCache();
  const cacheKey = "fotos:" + clase;
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return jsonResponse(JSON.parse(cached)); } catch (e) { /* recompute */ }
  }

  let folder;
  try {
    folder = DriveApp.getFolderById(CONFIG.FOTOS_FOLDER_ID);
  } catch (e) {
    console.warn("fotos_clase: no se puede abrir FOTOS_FOLDER_ID", e);
    return jsonResponse({ ok: true, fotos: [], reason: "folder_inaccesible" });
  }

  // Buscar la subcarpeta cuyo nombre coincida con `clase` (case-insensitive,
  // ignora espacios duplicados).
  const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  const claseNorm = norm(clase);
  let subfolder = null;
  const it = folder.getFolders();
  while (it.hasNext()) {
    const f = it.next();
    if (norm(f.getName()) === claseNorm) { subfolder = f; break; }
  }
  if (!subfolder) {
    const out = { ok: true, fotos: [], reason: "subcarpeta_no_existe" };
    cache.put(cacheKey, JSON.stringify(out), 60); // cache corto: el docente puede crear la carpeta
    return jsonResponse(out);
  }

  // Listar archivos. Extraer la cédula del nombre: último número de
  // 6-9 dígitos antes de la extensión.
  const re = /_(\d{6,9})\.(jpg|jpeg|png|webp|gif)$/i;
  const fotos = [];
  const archivos = subfolder.getFiles();
  while (archivos.hasNext()) {
    const f = archivos.next();
    const m = re.exec(f.getName());
    if (!m) continue;
    fotos.push({ codigo: m[1], file_id: f.getId(), file_name: f.getName() });
  }

  const out = { ok: true, fotos, clase, subcarpeta: subfolder.getName() };
  cache.put(cacheKey, JSON.stringify(out), 600); // 10 min
  return jsonResponse(out);
}

function yaCompleto(hojaCompl, codigo) {
  const last = hojaCompl.getLastRow();
  if (last < 2) return false;
  const codigos = hojaCompl.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < codigos.length; i++) {
    if (String(codigos[i][0]).trim() === codigo) return true;
  }
  return false;
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
