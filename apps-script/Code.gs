/**
 * Backend del sociograma sobre Google Apps Script.
 *
 * Despliegue:
 *   1. Crear una Google Sheet nueva (en tu Drive). Copiar su ID (la parte
 *      entre /d/ y /edit en la URL).
 *   2. Abrir https://script.google.com → Nuevo proyecto.
 *   3. Pegar este archivo como `Code.gs`.
 *   4. Editar las constantes CONFIG abajo (SHEET_ID, TOKEN, ESTUDIANTES_URL).
 *   5. Desplegar → Nuevo despliegue → Tipo: Aplicación web.
 *        - Ejecutar como: tú.
 *        - Quién tiene acceso: Cualquiera (para que la página lo pueda llamar).
 *   6. Copiar la URL de la app web a `js/config.js` (APPS_SCRIPT_URL).
 *
 * La Google Sheet es "el Excel en tu Drive": se puede abrir con Excel desde
 * Drive ("Abrir con → Microsoft Excel") o exportar con Archivo → Descargar →
 * Microsoft Excel.
 */

const CONFIG = {
  // ID de la Google Sheet destino (la parte entre /d/ y /edit de la URL).
  SHEET_ID: "1WpNz1Qj1elOq5GxEBNBGq8bOyhZw88SaRs0wx5Al76Q",
  // Token compartido con el front (js/config.js). Si no coincide, se rechaza.
  TOKEN: "d7d1e6cb97cca059ffcdd126d5f4132a76e99442382f29cf",
  // URL cruda del estudiantes.csv en el repo (raw.githubusercontent.com/...).
  // Sirve para validar que el código existe antes de registrar.
  // Si la dejás vacía, no se valida contra el CSV (menos seguro).
  // Cambiá `main` por la rama correcta cuando corresponda.
  ESTUDIANTES_URL: "https://raw.githubusercontent.com/martinferreiraHCA/sociogramas-2.0/claude/csv-quiz-excel-export-CXa8Z/data/estudiantes.csv",
};

const HOJA_RESPUESTAS = "respuestas";
const HOJA_COMPLETADOS = "completados";

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

    if (body.token !== CONFIG.TOKEN) {
      return jsonResponse({ ok: false, error: "forbidden" });
    }

    const codigo = String(body.codigo || "").trim();
    const nombre = String(body.nombre || "").trim();
    const clase = String(body.clase || "").trim();
    const respuestas = Array.isArray(body.respuestas) ? body.respuestas : [];

    if (!codigo) return jsonResponse({ ok: false, error: "codigo_vacio" });
    if (!respuestas.length) return jsonResponse({ ok: false, error: "sin_respuestas" });

    // Validación opcional contra estudiantes.csv
    if (CONFIG.ESTUDIANTES_URL) {
      const valido = validarCodigoContraCSV(codigo);
      if (!valido) return jsonResponse({ ok: false, error: "codigo_invalido" });
    }

    const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    const hojaResp = obtenerHoja(ss, HOJA_RESPUESTAS, HEADERS_RESPUESTAS);
    const hojaCompl = obtenerHoja(ss, HOJA_COMPLETADOS, HEADERS_COMPLETADOS);

    if (yaCompleto(hojaCompl, codigo)) {
      return jsonResponse({ ok: false, error: "ya_completado" });
    }

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
      hojaResp
        .getRange(hojaResp.getLastRow() + 1, 1, filas.length, HEADERS_RESPUESTAS.length)
        .setValues(filas);
    }
    hojaCompl.appendRow([codigo, nombre, clase, now]);

    return jsonResponse({ ok: true, filas_guardadas: filas.length });
  } catch (err) {
    console.error(err);
    return jsonResponse({ ok: false, error: "server_error", detail: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  // Endpoint de salud: útil para verificar que el deploy funcione.
  return jsonResponse({ ok: true, service: "sociogramas", time: new Date() });
}

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
      cache.put("estudiantes_csv", csv, 300); // 5 min
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
  let row = [];
  let field = "";
  let inQuotes = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\r") {
        // skip
      } else if (ch === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length && r.some((c) => c !== ""));
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
