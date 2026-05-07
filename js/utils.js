// Utilidades compartidas: parsing de CSV, toasts, helpers DOM y storage.

(function () {
  // ----- Toast simple, sin dependencias -----
  function ensureToastContainer() {
    let c = document.getElementById("toast-container");
    if (c) return c;
    c = document.createElement("div");
    c.id = "toast-container";
    document.body.appendChild(c);
    return c;
  }
  function toast(message, type) {
    const c = ensureToastContainer();
    const el = document.createElement("div");
    el.className = "toast toast-" + (type || "info");
    el.textContent = message;
    c.appendChild(el);
    setTimeout(() => el.classList.add("show"), 10);
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 300);
    }, 3500);
  }

  // ----- LocalStorage helpers -----
  function lsGet(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }
  function lsDel(key) {
    try { localStorage.removeItem(key); } catch {}
  }

  // ----- DOM helpers -----
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === "class") node.className = attrs[k];
        else if (k === "html") node.innerHTML = attrs[k];
        else if (k.startsWith("on") && typeof attrs[k] === "function") {
          node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else if (attrs[k] !== undefined && attrs[k] !== null) {
          node.setAttribute(k, attrs[k]);
        }
      }
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(c => {
        if (c == null) return;
        node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      });
    }
    return node;
  }

  // ----- CSV parsing (RFC 4180-ish) -----
  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", inQuotes = false;
    text = text.replace(/^\uFEFF/, ""); // BOM
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') { inQuotes = false; }
        else { field += ch; }
      } else {
        if (ch === '"') { inQuotes = true; }
        else if (ch === ",") { row.push(field); field = ""; }
        else if (ch === "\r") { /* skip */ }
        else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
        else { field += ch; }
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.length && r.some(c => c !== ""));
  }

  // Convierte filas → array de objetos usando la primera fila como header.
  function csvToObjects(text) {
    const rows = parseCSV(text);
    if (!rows.length) return [];
    const headers = rows[0].map(h => h.trim());
    return rows.slice(1).map(r => {
      const o = {};
      headers.forEach((h, i) => o[h] = (r[i] || "").trim());
      return o;
    });
  }

  // Genera CSV a partir de un array de objetos (todas las claves se convierten en columnas).
  function objectsToCSV(rows) {
    if (!rows.length) return "";
    const headers = Array.from(rows.reduce((s, r) => {
      Object.keys(r).forEach(k => s.add(k));
      return s;
    }, new Set()));
    const esc = v => {
      if (v == null) return "";
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [
      headers.join(","),
      ...rows.map(r => headers.map(h => esc(r[h])).join(","))
    ].join("\n");
  }

  function downloadFile(filename, contents, mime) {
    const blob = new Blob([contents], { type: mime || "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 100);
  }

  // ----- Misc -----
  function getQueryParam(name) {
    const url = new URL(window.location.href);
    return url.searchParams.get(name);
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Color para opciones de la pregunta de afinidad.
  function colorOpcionAfinidad(texto) {
    const t = (texto || "").toLowerCase();
    if (t.includes("verde"))    return { icon: "🟩", cls: "opcion-verde",    key: "verde" };
    if (t.includes("amarillo")) return { icon: "🟨", cls: "opcion-amarillo", key: "amarillo" };
    if (t.includes("rojo"))     return { icon: "🟥", cls: "opcion-rojo",     key: "rojo" };
    if (t.includes("blanco"))   return { icon: "⚪", cls: "opcion-blanco",   key: "blanco" };
    return { icon: "", cls: "", key: "" };
  }

  // ----- Roster escolar (CSV institucional) -----
  // Lee un CSV con el formato de exportación del colegio (encabezados en la
  // 3ra fila aprox., columnas `Documento` = CI y `Nombre` + `Primer Apellido`
  // + ...) y devuelve [{codigo, nombre, curso, grupo}] con el CI como código
  // y el nombre prolijo "Nombre Apellido".
  function parseRosterEscolar(csvText) {
    const rows = parseCSV(csvText);
    if (!rows.length) return { headerIdx: -1, rows: [] };

    // Encontrar fila de encabezados: contiene "Documento" y "Nombre".
    let headerIdx = -1;
    for (let i = 0; i < Math.min(15, rows.length); i++) {
      const r = rows[i].map(c => (c || "").trim().toLowerCase());
      if (r.includes("documento") && r.includes("nombre")) { headerIdx = i; break; }
    }
    if (headerIdx < 0) return { headerIdx: -1, rows: [] };

    const headers = rows[headerIdx].map(c => (c || "").trim().toLowerCase());
    const firstIdx = (name) => headers.indexOf(name);
    const iDoc = firstIdx("documento");
    const iNombre = firstIdx("nombre");
    const iPrimerNombre   = firstIdx("primer nombre");
    const iSegundoNombre  = firstIdx("segundo nombre");
    const iPrimerApellido = firstIdx("primer apellido");
    const iSegundoApellido= firstIdx("segundo apellido");
    const iCurso = firstIdx("curso");
    const iGrupo = firstIdx("grupo");
    const iTipoDoc = firstIdx("tipo de documento");
    const iConPase = firstIdx("con pase");
    const iFechaNac = ["fecha de nacimiento", "fecha nacimiento", "fecha de nac.", "fecha nac.", "fechanac", "f. nacimiento", "f.nacimiento", "nacimiento"]
      .map(h => headers.indexOf(h))
      .find(i => i >= 0);

    const vistos = new Set();
    const out = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.every(c => !String(c || "").trim())) continue;

      const tipoDoc = iTipoDoc >= 0 ? String(row[iTipoDoc] || "").trim().toUpperCase() : "";
      const ciRaw = iDoc >= 0 ? String(row[iDoc] || "").trim() : "";
      // Sólo dígitos; si hay letra (ej. pasaporte) lo dejamos tal cual limpio.
      const ci = /^\d/.test(ciRaw) ? ciRaw.replace(/\D/g, "") : ciRaw.replace(/\s+/g, "");
      if (!ci) continue;
      if (vistos.has(ci)) continue;
      vistos.add(ci);

      let nombre = "";
      if (iPrimerNombre >= 0 && iPrimerApellido >= 0) {
        const pn = titleCase(row[iPrimerNombre]);
        const sn = iSegundoNombre >= 0 ? titleCase(row[iSegundoNombre]) : "";
        const pa = titleCase(row[iPrimerApellido]);
        const sa = iSegundoApellido >= 0 ? titleCase(row[iSegundoApellido]) : "";
        nombre = [pn, sn, pa, sa].filter(Boolean).join(" ");
      }
      if (!nombre && iNombre >= 0) {
        // Fallback: "APELLIDO APELLIDO Nombre Nombre" → reordenar a "Nombre Apellido".
        nombre = normalizarNombreApellidosCapsPrimero(String(row[iNombre] || "").trim());
      }
      if (!nombre) continue;

      const conPase = iConPase >= 0 ? String(row[iConPase] || "").trim().toUpperCase() : "";
      const fechaNac = (iFechaNac != null && iFechaNac >= 0)
        ? normalizarFechaNac(row[iFechaNac])
        : "";
      out.push({
        codigo: ci,
        nombre,
        curso: iCurso >= 0 ? String(row[iCurso] || "").trim() : "",
        grupo: iGrupo >= 0 ? String(row[iGrupo] || "").trim() : "",
        tipoDoc,
        conPase,
        fechaNac,
        activo: conPase !== "SI",
      });
    }
    return { headerIdx, rows: out };
  }

  // Parser de un CSV "simple" cargado por el docente. Acepta las tres
  // columnas Nombre / Cédula / Fecha de Nacimiento (con varios alias)
  // y devuelve filas listas para `importarEstudiantes`. La detección de
  // encabezados es flexible: encontramos la primera fila que contenga al
  // menos un alias de "nombre" y uno de "cédula".
  function parseRosterSimple(csvText) {
    const rows = parseCSV(csvText);
    if (!rows.length) return { headerIdx: -1, rows: [], error: "csv_vacio" };

    const ALIAS_NOMBRE = ["nombre completo", "nombre y apellido", "nombre", "alumno", "estudiante", "apellido y nombre", "apellidos y nombre"];
    const ALIAS_CEDULA = ["cédula", "cedula", "ci", "dni", "documento", "número de documento", "numero de documento", "documento de identidad", "doc"];
    const ALIAS_FECHA  = ["fecha de nacimiento", "fecha nacimiento", "fecha de nac.", "fecha nac.", "f. nacimiento", "f.nacimiento", "nacimiento", "fnac"];

    let headerIdx = -1, headers = [], iN = -1, iC = -1, iF = -1;
    for (let h = 0; h < Math.min(10, rows.length); h++) {
      const r = rows[h].map(c => (c || "").trim().toLowerCase());
      const findAlias = (alias) => {
        for (const a of alias) { const i = r.indexOf(a); if (i >= 0) return i; }
        return -1;
      };
      const _iN = findAlias(ALIAS_NOMBRE);
      const _iC = findAlias(ALIAS_CEDULA);
      if (_iN >= 0 && _iC >= 0) {
        headerIdx = h; headers = r;
        iN = _iN; iC = _iC; iF = findAlias(ALIAS_FECHA);
        break;
      }
    }
    if (headerIdx < 0) {
      return { headerIdx: -1, rows: [], error: "Necesito encabezados con al menos 'Nombre' y 'Cédula'." };
    }

    const out = [];
    const vistos = new Set();
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.every(c => !String(c || "").trim())) continue;
      const nombre = String(row[iN] || "").trim();
      const cedRaw = String(row[iC] || "").trim();
      const codigo = /^\d/.test(cedRaw) ? cedRaw.replace(/\D/g, "") : cedRaw.replace(/\s+/g, "");
      if (!nombre || !codigo) continue;
      if (vistos.has(codigo)) continue;
      vistos.add(codigo);
      const fechaNac = iF >= 0 ? normalizarFechaNac(row[iF]) : "";
      out.push({ codigo, nombre, fechaNac });
    }
    return { headerIdx, rows: out };
  }

  // Normaliza una fecha de nacimiento al formato DD/MM/AAAA. Acepta entradas
  // como "2010-03-21", "21/3/2010", "21-03-10", etc. Si no parsea, devuelve
  // el string limpio para no perder el dato.
  function normalizarFechaNac(v) {
    const raw = String(v == null ? "" : v).trim();
    if (!raw) return "";
    const isoMatch = raw.match(/^(\d{4})[\-\/.](\d{1,2})[\-\/.](\d{1,2})/);
    if (isoMatch) {
      const [, y, m, d] = isoMatch;
      return `${d.padStart(2, "0")}/${m.padStart(2, "0")}/${y}`;
    }
    const dmyMatch = raw.match(/^(\d{1,2})[\-\/.](\d{1,2})[\-\/.](\d{2,4})/);
    if (dmyMatch) {
      let [, d, m, y] = dmyMatch;
      if (y.length === 2) y = (parseInt(y, 10) > 30 ? "19" : "20") + y;
      return `${d.padStart(2, "0")}/${m.padStart(2, "0")}/${y}`;
    }
    return raw;
  }

  function titleCase(s) {
    const str = String(s == null ? "" : s).trim();
    if (!str) return "";
    return str.toLowerCase().replace(/(^|\s|-|')(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
  }

  // "ADINOLFI LLACH Ignacio Tomás" → "Ignacio Tomás Adinolfi Llach".
  function normalizarNombreApellidosCapsPrimero(s) {
    const tokens = String(s).trim().split(/\s+/);
    const apellidos = [], nombres = [];
    for (const t of tokens) {
      if (!t) continue;
      if (/^[\p{Lu}'\-]+$/u.test(t)) apellidos.push(titleCase(t));
      else nombres.push(titleCase(t));
    }
    return [...nombres, ...apellidos].join(" ").trim();
  }

  window.U = {
    toast, lsGet, lsSet, lsDel,
    $, $$, el,
    parseCSV, csvToObjects, objectsToCSV, downloadFile,
    getQueryParam, escapeHtml, colorOpcionAfinidad,
    parseRosterEscolar, parseRosterSimple, titleCase, normalizarFechaNac,
  };
})();
