/**
 * Backend del sociograma sobre Google Apps Script.
 *
 * Endpoints:
 *   POST /exec
 *     body { token, codigo, nombre, clase, respuestas }
 *       → registra respuestas del alumno.
 *     body { action: "save_grupos", token_admin, clase, grupos }
 *       → guarda la composición de grupos en la hoja "grupos".
 *   GET /exec?action=ping
 *       → healthcheck.
 *   GET /exec?action=admin_check&pw=...
 *       → valida la contraseña de admin.
 *   GET /exec?action=respuestas&pw=...
 *       → todas las respuestas (hoja `respuestas`).
 *   GET /exec?action=completados&pw=...
 *       → hoja `completados`.
 *   GET /exec?action=grupos&pw=...&clase=...
 *       → grupos guardados para una clase (opcional).
 *
 * Después de cambiar este archivo hay que hacer "Implementar → Administrar
 * implementaciones → editar → Versión nueva" para que la URL .../exec sirva
 * el código nuevo.
 */

const CONFIG = {
  SHEET_ID: "1WpNz1Qj1elOq5GxEBNBGq8bOyhZw88SaRs0wx5Al76Q",
  TOKEN: "d7d1e6cb97cca059ffcdd126d5f4132a76e99442382f29cf",
  ADMIN_PASSWORD: "Colegio4392HCA",
  // Cambiá `main` por la rama correcta si el CSV no está mergeado aún.
  ESTUDIANTES_URL: "https://raw.githubusercontent.com/martinferreiraHCA/sociogramas-2.0/main/data/estudiantes.csv",
};

const HOJA_RESPUESTAS = "respuestas";
const HOJA_COMPLETADOS = "completados";
const HOJA_GRUPOS = "grupos";

const HEADERS_RESPUESTAS = [
  "timestamp",
  "codigo",
  "nombre",
  "clase",
  "numero_pregunta",
  "texto_pregunta",
  "evaluado_codigo",
  "evaluado_nombre",
  "opcion_texto",
  "otro_texto",
];
const HEADERS_COMPLETADOS = ["codigo", "nombre", "clase", "completado_at"];
const HEADERS_GRUPOS = ["clase", "nombre_grupo", "codigos", "nombres", "saved_at"];

// ---------- POST ----------
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    return jsonResponse({ ok: false, error: "lock_timeout" });
  }
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

    if (body.action === "save_grupos") return saveGrupos(body);
    return submitRespuestas(body);
  } catch (err) {
    console.error(err);
    return jsonResponse({ ok: false, error: "server_error", detail: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function submitRespuestas(body) {
  if (body.token !== CONFIG.TOKEN) return jsonResponse({ ok: false, error: "forbidden" });
  const codigo = String(body.codigo || "").trim();
  const nombre = String(body.nombre || "").trim();
  const clase = String(body.clase || "").trim();
  const respuestas = Array.isArray(body.respuestas) ? body.respuestas : [];
  if (!codigo) return jsonResponse({ ok: false, error: "codigo_vacio" });
  if (!respuestas.length) return jsonResponse({ ok: false, error: "sin_respuestas" });

  if (CONFIG.ESTUDIANTES_URL) {
    if (!validarCodigoContraCSV(codigo)) return jsonResponse({ ok: false, error: "codigo_invalido" });
  }
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const hojaResp = obtenerHoja(ss, HOJA_RESPUESTAS, HEADERS_RESPUESTAS);
  const hojaCompl = obtenerHoja(ss, HOJA_COMPLETADOS, HEADERS_COMPLETADOS);

  if (yaCompleto(hojaCompl, codigo)) return jsonResponse({ ok: false, error: "ya_completado" });

  const now = new Date();
  const filas = respuestas.map((r) => [
    now,
    codigo,
    nombre,
    clase,
    r.numero_pregunta || "",
    r.texto_pregunta || "",
    r.evaluado_codigo || "",
    r.evaluado_nombre || "",
    r.opcion_texto || "",
    r.otro_texto || "",
  ]);
  if (filas.length) {
    hojaResp.getRange(hojaResp.getLastRow() + 1, 1, filas.length, HEADERS_RESPUESTAS.length).setValues(filas);
  }
  hojaCompl.appendRow([codigo, nombre, clase, now]);
  return jsonResponse({ ok: true, filas_guardadas: filas.length });
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

  // Borrar filas existentes para esta clase
  const last = hoja.getLastRow();
  if (last >= 2) {
    const valores = hoja.getRange(2, 1, last - 1, HEADERS_GRUPOS.length).getValues();
    for (let i = valores.length - 1; i >= 0; i--) {
      if (String(valores[i][0]).trim() === clase) hoja.deleteRow(i + 2);
    }
  }
  const now = new Date();
  const filas = grupos.map((g) => [
    clase,
    g.nombre || "",
    (g.codigos || []).join(", "),
    (g.nombres || []).join(", "),
    now,
  ]);
  if (filas.length) {
    hoja.getRange(hoja.getLastRow() + 1, 1, filas.length, HEADERS_GRUPOS.length).setValues(filas);
  }
  return jsonResponse({ ok: true, guardados: filas.length });
}

// ---------- GET ----------
function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const action = String(params.action || "ping");
    if (action === "ping") {
      return jsonResponse({ ok: true, service: "sociogramas", time: new Date() });
    }
    if (action === "admin_check") {
      return jsonResponse({ ok: params.pw === CONFIG.ADMIN_PASSWORD });
    }
    if (params.pw !== CONFIG.ADMIN_PASSWORD) {
      return jsonResponse({ ok: false, error: "forbidden" });
    }
    const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
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
    return jsonResponse({ ok: false, error: "accion_desconocida" });
  } catch (err) {
    console.error(err);
    return jsonResponse({ ok: false, error: "server_error", detail: String(err) });
  }
}

// ---------- Helpers ----------
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

function yaCompleto(hojaCompl, codigo) {
  const last = hojaCompl.getLastRow();
  if (last < 2) return false;
  const codigos = hojaCompl.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < codigos.length; i++) {
    if (String(codigos[i][0]).trim() === codigo) return true;
  }
  return false;
}

function validarCodigoContraCSV(codigo) {
  try {
    const cache = CacheService.getScriptCache();
    let csv = cache.get("estudiantes_csv");
    if (!csv) {
      const res = UrlFetchApp.fetch(CONFIG.ESTUDIANTES_URL, { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) return false;
      csv = res.getContentText();
      cache.put("estudiantes_csv", csv, 300);
    }
    const filas = parseCSV(csv);
    if (!filas.length) return false;
    const headers = filas[0].map((h) => h.trim().toLowerCase());
    const idxCodigo = headers.indexOf("codigo");
    if (idxCodigo < 0) return false;
    for (let i = 1; i < filas.length; i++) {
      if ((filas[i][idxCodigo] || "").trim() === codigo) return true;
    }
    return false;
  } catch (err) {
    console.error(err);
    return false;
  }
}

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\r") {}
      else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length && r.some((c) => c !== ""));
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
