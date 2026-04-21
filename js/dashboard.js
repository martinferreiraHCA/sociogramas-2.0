// Dashboard del docente sobre CSVs + Google Sheet.
// Requiere admin_pw en sessionStorage (lo setea admin-login.html).

(function () {
  const $ = U.$, el = U.el;
  const root = $("#dashboard-root");

  const pw = sessionStorage.getItem("admin_pw");
  if (!pw) { window.location.href = "./admin-login.html"; return; }

  // Datos cargados una vez al inicio.
  let estudiantes = [];      // [{codigo, nombre, clase}]
  let preguntas = [];        // [{numero, texto, tipo}]
  let opciones = [];         // [{numero_pregunta, orden, texto}]
  let respuestas = [];       // del Sheet: [{timestamp, codigo, nombre, clase, numero_pregunta, texto_pregunta, evaluado_codigo, evaluado_nombre, opcion_texto, otro_texto}]
  let completados = [];
  let clases = [];           // [clase identifier, ...]
  let claseSel = U.getQueryParam("clase") || "";

  // Estado del armado de grupos.
  let gruposLocal = null;    // [{ nombre, codigos: [] }]
  let resultadoAlgoritmo = null;
  let gruposConfig = {
    tamGrupo: 4,
    permitirRojoMutuo: false,
    estrategia: "automatico",
    prioridad: "evitar_conflictos",
  };
  // Indica si `gruposLocal` viene de un borrador local (no guardado en la
  // planilla). Se muestra como badge y se limpia al hacer Guardar.
  let draftActivo = false;

  // ---- Borrador local por clase (sobrevive a refrescos) ----
  const DRAFT_PREFIX = "sociogramas-draft:";
  const draftKey = (cl) => DRAFT_PREFIX + cl;
  function cargarBorrador(cl) {
    const raw = U.lsGet(draftKey(cl), null);
    return raw && raw.version === 1 ? raw : null;
  }
  function guardarBorrador() {
    if (!claseSel) return;
    U.lsSet(draftKey(claseSel), {
      version: 1,
      gruposLocal: gruposLocal || [],
      gruposConfig,
      savedAt: new Date().toISOString(),
    });
    draftActivo = true;
  }
  function limpiarBorrador(cl) {
    U.lsDel(draftKey(cl || claseSel));
    draftActivo = false;
  }

  init().catch(err => {
    console.error(err);
    root.innerHTML = `<div class="panel-container"><p class="cuestionario-error">Error cargando el dashboard. Revisá la consola.</p></div>`;
  });

  async function init() {
    root.innerHTML = `<div class="panel-container"><p>Cargando…</p></div>`;
    const [csvs, ests, resp, compl, grp] = await Promise.all([
      API.loadAll(),
      API.fetchEstudiantes(pw),
      API.fetchRespuestas(pw),
      API.fetchCompletados(pw),
      API.fetchGrupos(pw),
    ]);
    if (!ests || !ests.ok || !resp || !resp.ok) {
      console.error("init: respuesta inválida de Apps Script", { ests, resp });
      sessionStorage.removeItem("admin_pw");
      window.location.href = "./admin-login.html";
      return;
    }
    estudiantes = ests.data || [];
    preguntas   = csvs.preguntas;
    opciones    = csvs.opciones;
    respuestas  = resp.data || [];
    completados = (compl && compl.data) || [];
    const grupos = (grp && grp.data) || [];
    clases = Array.from(new Set(estudiantes.map(e => e.clase))).sort();

    if (!claseSel && clases.length === 1) claseSel = clases[0];
    if (claseSel) {
      const servidor = gruposParaClase(grupos, claseSel);
      if (servidor && servidor.length) {
        gruposLocal = servidor;
        draftActivo = false;
      } else {
        const bor = cargarBorrador(claseSel);
        if (bor && Array.isArray(bor.gruposLocal) && bor.gruposLocal.length) {
          gruposLocal = bor.gruposLocal;
          if (bor.gruposConfig) gruposConfig = Object.assign({}, gruposConfig, bor.gruposConfig);
          draftActivo = true;
          console.info(`[draft] Recuperado borrador de "${claseSel}" (${bor.savedAt})`);
        } else {
          gruposLocal = null;
          draftActivo = false;
        }
      }
    }
    render();
  }

  function gruposParaClase(grupos, clase) {
    const mios = grupos.filter(g => String(g.clase).trim() === clase);
    if (!mios.length) return null;
    return mios.map(g => ({
      nombre: g.nombre_grupo,
      codigos: String(g.codigos || "").split(",").map(s => s.trim()).filter(Boolean),
    }));
  }

  // ---------- Render raíz ----------
  function render() {
    root.innerHTML = "";
    root.appendChild(headerBar());
    if (!claseSel) {
      root.appendChild(renderSelectorClase());
      return;
    }
    const esClase = estudiantes.filter(e => e.clase === claseSel);
    const resp = respuestas.filter(r => String(r.clase).trim() === claseSel);
    const completadosClase = completados.filter(c => String(c.clase).trim() === claseSel);
    root.appendChild(renderStepper(esClase, completadosClase));
    root.appendChild(renderResumen(esClase, resp, completadosClase));
    root.appendChild(wrapId("paso-roster", renderRoster(esClase, completadosClase)));
    instalarHookDetalleEst(esClase, resp);
    root.appendChild(wrapId("paso-sociograma", renderSociograma(esClase, resp)));
    root.appendChild(wrapId("paso-respuestas", renderDetalle(esClase, resp)));
    root.appendChild(wrapId("paso-grupos", renderGrupos(esClase, resp)));
  }

  function wrapId(id, node) {
    node.id = id;
    return node;
  }

  function renderStepper(ests, compl) {
    const c = el("div", { class: "panel-container workflow-panel" });
    const totalEst = ests.length;
    const totalCompl = compl.length;
    const gruposLen = (gruposLocal && gruposLocal.length) || 0;
    const pct = totalEst ? Math.round((totalCompl / totalEst) * 100) : 0;

    const estRoster = totalEst === 0 ? "pending" : "done";
    const estResp = totalEst === 0 ? "locked" : (totalCompl >= totalEst ? "done" : (totalCompl > 0 ? "progress" : "pending"));
    const estGrup = totalEst === 0 ? "locked" : (gruposLen > 0 ? (draftActivo ? "progress" : "done") : "pending");

    c.innerHTML = `
      <div class="workflow">
        <a class="workflow-step ${estRoster}" href="#paso-roster">
          <div class="workflow-num">1</div>
          <div>
            <div class="workflow-title">Alumnos y códigos</div>
            <div class="workflow-meta">${totalEst ? `${totalEst} en la clase` : "Importá el CSV del colegio"}</div>
          </div>
          <div class="workflow-icon">${estRoster === "done" ? "✓" : "•"}</div>
        </a>
        <a class="workflow-step ${estResp}" href="#paso-respuestas">
          <div class="workflow-num">2</div>
          <div>
            <div class="workflow-title">Respuestas</div>
            <div class="workflow-meta">${totalEst ? `${totalCompl}/${totalEst} (${pct}%)` : "—"}</div>
          </div>
          <div class="workflow-icon">${estResp === "done" ? "✓" : estResp === "progress" ? "…" : "•"}</div>
        </a>
        <a class="workflow-step ${estGrup}" href="#paso-grupos">
          <div class="workflow-num">3</div>
          <div>
            <div class="workflow-title">Armado de grupos</div>
            <div class="workflow-meta">${gruposLen ? `${gruposLen} grupo(s)${draftActivo ? " · borrador" : ""}` : "Generá los grupos"}</div>
          </div>
          <div class="workflow-icon">${estGrup === "done" ? "✓" : estGrup === "progress" ? "📝" : "•"}</div>
        </a>
      </div>`;
    return c;
  }

  function headerBar() {
    const h = el("div", { class: "panel-container" });
    const sel = `
      <div class="flex-row" style="justify-content:space-between;gap:12px;flex-wrap:wrap">
        <h2 style="color:#4CAF50;margin:0">Dashboard ${claseSel ? "· " + U.escapeHtml(claseSel) : ""}</h2>
        <div class="flex-row" style="gap:8px">
          ${clases.length ? `<select id="sel-clase" class="cuestionario-select" style="max-width:180px">
              <option value="">— Cambiar clase —</option>
              ${clases.map(c => `<option value="${U.escapeHtml(c)}" ${c===claseSel?"selected":""}>${U.escapeHtml(c)}</option>`).join("")}
            </select>` : ""}
          <button class="btn btn-gray btn-sm" id="btn-diag" title="Verificar la password contra el Apps Script">🔐 Diagnóstico</button>
          <button class="btn btn-gray btn-sm" id="btn-refrescar">Actualizar</button>
          <button class="btn btn-gray btn-sm" id="btn-logout">Salir</button>
        </div>
      </div>`;
    h.innerHTML = sel;
    const selNode = h.querySelector("#sel-clase");
    if (selNode) selNode.addEventListener("change", async () => {
      claseSel = selNode.value || "";
      gruposLocal = null; resultadoAlgoritmo = null;
      gruposConfig = { tamGrupo: 4, permitirRojoMutuo: false, estrategia: "automatico", prioridad: "evitar_conflictos" };
      draftActivo = false;
      const url = new URL(window.location.href);
      if (claseSel) url.searchParams.set("clase", claseSel);
      else url.searchParams.delete("clase");
      history.replaceState(null, "", url);
      // Re-correr init() para aplicar la lógica de borrador/servidor sobre la
      // clase recién seleccionada.
      if (claseSel) await init(); else render();
    });
    h.querySelector("#btn-logout").addEventListener("click", () => {
      sessionStorage.removeItem("admin_pw");
      window.location.href = "./admin-login.html";
    });
    h.querySelector("#btn-refrescar").addEventListener("click", async () => {
      U.toast("Actualizando…", "info");
      API.clearCache();
      await init();
    });
    h.querySelector("#btn-diag").addEventListener("click", ejecutarDiagnosticoAuth);
    return h;
  }

  function renderSelectorClase() {
    const c = el("div", { class: "panel-container" });
    if (!clases.length) {
      // Primera visita: todo arranca importando el CSV.
      c.innerHTML = `
        <div class="empty-hero">
          <div class="empty-hero-emoji">📥</div>
          <h3>Empezá subiendo el CSV del colegio</h3>
          <p class="muted">El sistema detecta cada curso y grupo (ej. <b>8°1</b>, <b>8°2</b>), crea un tab por cada uno en la planilla y usa las cédulas como código. No hace falta crear clases a mano.</p>
          <div class="flex-row" style="justify-content:center;gap:10px;margin-top:18px;flex-wrap:wrap">
            <button class="btn btn-green" id="btn-landing-importar">📥 Subir CSV del colegio</button>
            <button class="btn btn-gray" id="btn-landing-manual">o crear una clase vacía a mano</button>
          </div>
          <input type="file" id="file-landing" accept=".csv,text/csv" style="display:none" />
        </div>`;
    } else {
      // Hay clases: mostrar listado + opción de subir otro CSV.
      c.innerHTML = `
        <div class="flex-row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
          <h3>Seleccioná una clase</h3>
          <div class="flex-row" style="gap:8px;flex-wrap:wrap">
            <button class="btn btn-green btn-sm" id="btn-landing-importar">📥 Importar otro CSV</button>
            <button class="btn btn-gray btn-sm" id="btn-landing-manual">+ Nueva clase vacía</button>
            <input type="file" id="file-landing" accept=".csv,text/csv" style="display:none" />
          </div>
        </div>`;
      const list = el("div", { class: "list-card mt-16" });
      clases.forEach(cl => {
        const count = estudiantes.filter(e => e.clase === cl).length;
        const compl = completados.filter(c => String(c.clase).trim() === cl).length;
        const it = el("div", { class: "item" });
        it.appendChild(el("div", null, [
          el("div", { style: "font-weight:600" }, cl),
          el("div", { class: "muted" }, `${count} estudiante(s) · ${compl} completaron`),
        ]));
        it.appendChild(el("a", { class: "btn btn-blue btn-sm", href: `./dashboard.html?clase=${encodeURIComponent(cl)}` }, "Ver"));
        list.appendChild(it);
      });
      c.appendChild(list);
    }

    // Wiring común (existe en ambos modos).
    const fi = c.querySelector("#file-landing");
    const btnImportar = c.querySelector("#btn-landing-importar");
    const btnManual = c.querySelector("#btn-landing-manual");
    if (btnImportar && fi) btnImportar.addEventListener("click", () => fi.click());
    if (btnManual) btnManual.addEventListener("click", nuevaClasePrompt);
    if (fi) fi.addEventListener("change", (ev) => {
      const f = ev.target.files && ev.target.files[0];
      ev.target.value = "";
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = U.parseRosterEscolar(String(reader.result || ""));
          if (!parsed.rows.length) {
            U.toast("No se encontraron estudiantes válidos (¿CSV sin columnas Documento/Nombre?)", "error");
            console.warn("parseRosterEscolar:", parsed);
            return;
          }
          abrirModalImportar(parsed.rows, []);
        } catch (err) {
          console.error("parseRosterEscolar error", err);
          U.toast("No se pudo leer el CSV: " + err.message, "error");
        }
      };
      reader.readAsText(f, "utf-8");
    });

    return c;
  }

  async function nuevaClasePrompt() {
    const nombre = prompt("Nombre de la nueva clase (será el nombre del tab en la planilla)");
    if (!nombre || !nombre.trim()) return;
    U.toast("Creando clase…", "info");
    try {
      const r = await API.crearClase(pw, nombre.trim(), []);
      if (!r || !r.ok) {
        console.error("crear_clase falló:", r);
        U.toast("Error: " + ((r && r.error) || "desconocido") + " · mirá la consola", "error");
        return;
      }
      U.toast("Clase creada", "success");
      API.clearCache();
      claseSel = nombre.trim();
      const url = new URL(window.location.href);
      url.searchParams.set("clase", claseSel);
      history.replaceState(null, "", url);
      await init();
    } catch (err) {
      console.error("crear_clase error de red:", err);
      U.toast("Error de conexión: " + (err.message || err), "error");
    }
  }

  // ---------- Resumen ----------
  function renderResumen(ests, resp, compl) {
    const c = el("div", { class: "panel-container" });
    const counts = { verde: 0, amarillo: 0, rojo: 0, blanco: 0 };
    resp.forEach(r => {
      if (Number(r.numero_pregunta) !== 1) return;
      const k = U.colorOpcionAfinidad(r.opcion_texto).key;
      if (k) counts[k]++;
    });

    c.innerHTML = `
      <h3>Resumen</h3>
      <p class="muted">${compl.length}/${ests.length} estudiantes completaron</p>`;
    const grid = el("div", { class: "stats-grid" });
    grid.appendChild(statBox("👥", ests.length, "estudiantes", ""));
    grid.appendChild(statBox("📈", `${ests.length ? Math.round((compl.length/ests.length)*100) : 0}%`, "completaron", ""));
    grid.appendChild(statBox("🟩", counts.verde, "verde", "stat-verde"));
    grid.appendChild(statBox("🟨", counts.amarillo, "amarillo", "stat-amarillo"));
    grid.appendChild(statBox("🟥", counts.rojo, "rojo", "stat-rojo"));
    grid.appendChild(statBox("⚪", counts.blanco, "blanco", "stat-blanco"));
    c.appendChild(grid);
    return c;
  }
  function statBox(icon, num, lbl, cls) {
    return el("div", { class: "stat-box " + (cls||"") }, [
      el("div", { class: "num" }, [icon, " ", String(num)]),
      el("div", { class: "lbl" }, lbl),
    ]);
  }

  // ---------- Roster (Nombre / Código) ----------
  function renderRoster(ests, compl) {
    const c = el("div", { class: "panel-container" });
    const sinCodigo = ests.filter(e => !e.codigo).length;
    const codigosCompl = new Set((compl || []).map(x => String(x.codigo).trim()));

    if (!ests.length) {
      // Empty state: CTA grande para importar el CSV.
      c.innerHTML = `
        <div class="flex-row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
          <h3>1 · Alumnos y códigos</h3>
          <span class="badge badge-pending">vacío</span>
        </div>
        <div class="empty-hero mt-16">
          <div class="empty-hero-emoji">📥</div>
          <h3>La clase <b>${U.escapeHtml(claseSel)}</b> todavía no tiene alumnos</h3>
          <p class="muted">Subí el CSV del colegio y el sistema usa las cédulas como código, separando por curso y grupo (8°1, 8°2, ...).</p>
          <div class="flex-row" style="justify-content:center;gap:10px;margin-top:18px;flex-wrap:wrap">
            <button class="btn btn-green" id="btn-importar-csv">📥 Importar CSV del colegio</button>
            <button class="btn btn-gray" id="btn-add-est">+ Agregar manualmente</button>
          </div>
          <input type="file" id="file-roster" accept=".csv,text/csv" style="display:none" />
        </div>`;
    } else {
      c.innerHTML = `
        <div class="flex-row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
          <h3>1 · Alumnos y códigos <span class="muted" style="font-weight:400">· ${ests.length}</span></h3>
          <div class="flex-row" style="gap:8px;flex-wrap:wrap">
            <button class="btn btn-green btn-sm" id="btn-importar-csv">📥 Importar CSV</button>
            <button class="btn btn-blue btn-sm" id="btn-gen-codigos" ${sinCodigo ? "" : "disabled"}>
              🔑 Generar códigos${sinCodigo ? ` (${sinCodigo})` : ""}
            </button>
            <button class="btn btn-gray btn-sm" id="btn-add-est">+ Agregar</button>
            <button class="btn btn-gray btn-sm" id="btn-copy-codigos">📋 Copiar CSV</button>
            <input type="file" id="file-roster" accept=".csv,text/csv" style="display:none" />
          </div>
        </div>
        <p class="muted mt-16">Planilla · tab <b>${U.escapeHtml(claseSel)}</b>. Las cédulas se usan como código. Podés importar el CSV institucional o generar códigos random para los alumnos que no tengan.</p>
        <div class="roster-table mt-16">
          <div class="roster-thead">
            <div>Nombre</div>
            <div>Código</div>
            <div>Estado</div>
            <div></div>
          </div>
          <div class="roster-tbody" id="roster-list"></div>
        </div>`;

      const list = c.querySelector("#roster-list");
      const ordenados = ests.slice().sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
      ordenados.forEach(e => {
        const row = el("div", { class: "roster-tr" });
        row.appendChild(el("div", { class: "roster-nombre" }, e.nombre));
        if (e.codigo) {
          row.appendChild(el("div", null, [el("code", { class: "roster-codigo" }, e.codigo)]));
        } else {
          row.appendChild(el("div", null, [el("span", { class: "badge badge-pending" }, "— sin código —")]));
        }
        const estado = !e.codigo
          ? el("span", { class: "badge badge-pending" }, "sin código")
          : codigosCompl.has(e.codigo)
            ? el("span", { class: "badge badge-active" }, "✓ completó")
            : el("span", { class: "badge badge-done" }, "pendiente");
        row.appendChild(el("div", null, [estado]));

        const acts = el("div", { class: "roster-actions" });
        if (e.codigo) {
          acts.appendChild(el("button", {
            class: "btn btn-gray btn-sm",
            title: "Copiar código",
            onclick: () => navigator.clipboard.writeText(e.codigo).then(() => U.toast("Código copiado", "success")),
          }, "📋"));
        }
        acts.appendChild(el("button", {
          class: "btn btn-red btn-sm",
          title: "Eliminar",
          onclick: () => eliminarAlumno(e),
        }, "✕"));
        row.appendChild(acts);
        list.appendChild(row);
      });
    }

    const on = (sel, ev, fn) => { const n = c.querySelector(sel); if (n) n.addEventListener(ev, fn); };

    on("#btn-gen-codigos", "click", async () => {
      U.toast("Generando códigos…", "info");
      try {
        const r = await API.generarCodigos(pw, claseSel);
        if (!r || !r.ok) {
          console.error("generar_codigos falló:", r);
          U.toast("Error: " + ((r && r.error) || "desconocido") + " · mirá la consola", "error");
          return;
        }
        U.toast(`Listo. ${r.generados} código(s) generado(s)`, "success");
        await refrescar();
      } catch (err) {
        console.error("generar_codigos error de red:", err);
        U.toast("Error de conexión: " + (err.message || err), "error");
      }
    });

    on("#btn-add-est", "click", async () => {
      const nombre = prompt(`Nombre del nuevo estudiante en ${claseSel}:`);
      if (!nombre || !nombre.trim()) return;
      try {
        const r = await API.agregarEstudiante(pw, claseSel, nombre.trim());
        if (!r || !r.ok) {
          console.error("agregar_estudiante falló:", r);
          U.toast("Error: " + ((r && r.error) || "desconocido") + " · mirá la consola", "error");
          return;
        }
        U.toast("Estudiante agregado", "success");
        await refrescar();
      } catch (err) {
        console.error("agregar_estudiante error de red:", err);
        U.toast("Error de conexión: " + (err.message || err), "error");
      }
    });

    on("#btn-copy-codigos", "click", () => {
      const csv = "Nombre,Código\n" + ests
        .slice()
        .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"))
        .map(e => `"${e.nombre.replace(/"/g, '""')}",${e.codigo || ""}`)
        .join("\n");
      navigator.clipboard.writeText(csv).then(() => U.toast("Copiado al portapapeles", "success"));
    });

    const fileInput = c.querySelector("#file-roster");
    on("#btn-importar-csv", "click", () => fileInput && fileInput.click());
    if (fileInput) fileInput.addEventListener("change", (ev) => {
      const f = ev.target.files && ev.target.files[0];
      ev.target.value = "";
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = U.parseRosterEscolar(String(reader.result || ""));
          if (!parsed.rows.length) {
            U.toast("No se encontraron estudiantes válidos (¿CSV sin columna Documento/Nombre?)", "error");
            console.warn("parseRosterEscolar:", parsed);
            return;
          }
          abrirModalImportar(parsed.rows, ests);
        } catch (err) {
          console.error("parseRosterEscolar error", err);
          U.toast("No se pudo leer el CSV: " + err.message, "error");
        }
      };
      reader.readAsText(f, "utf-8");
    });

    return c;
  }

  function abrirModalImportar(filasParseadas, estsActuales) {
    const codigosClaseActual = new Set(estsActuales.filter(e => e.codigo).map(e => e.codigo));

    // Agrupar por (curso, grupo). Si no hay curso+grupo, todo cae en un pseudo-grupo "(sin curso)".
    const combos = [];                 // [{ key, curso, grupo, tab, rows: [...] }]
    const comboIndex = {};
    filasParseadas.forEach(f => {
      const curso = (f.curso || "").trim();
      const grupo = (f.grupo || "").trim();
      const key = curso + "¦" + grupo;
      if (!comboIndex[key]) {
        comboIndex[key] = combos.length;
        const tabDefault = (curso && grupo) ? `${curso}°${grupo}` : (claseSel || "(sin clase)");
        combos.push({ key, curso, grupo, tab: tabDefault, rows: [] });
      }
      combos[comboIndex[key]].rows.push(f);
    });
    // Orden: grupos reales primero, luego los sin clasificar.
    combos.sort((a, b) => {
      if (!!a.curso !== !!b.curso) return a.curso ? -1 : 1;
      return a.tab.localeCompare(b.tab, "es", { numeric: true });
    });

    const tieneGrupos = combos.some(c => c.curso || c.grupo);
    const totalActivos = filasParseadas.filter(f => f.activo).length;
    const totalInactivos = filasParseadas.length - totalActivos;

    const overlay = el("div", { class: "modal-overlay", id: "modal-importar" });
    const modal = el("div", { class: "modal-card" });
    modal.innerHTML = `
      <div class="modal-head">
        <h3>Importar CSV del colegio</h3>
        <button class="modal-close" id="modal-cerrar">×</button>
      </div>
      <div class="modal-body">
        <div class="grupos-stats-grid" style="margin-bottom:14px">
          <div class="grupos-stat grupos-stat-ok">
            <div class="num">${totalActivos}</div><div class="lbl">activos</div>
          </div>
          <div class="grupos-stat grupos-stat-warn">
            <div class="num">${totalInactivos}</div><div class="lbl">con pase / inactivos</div>
          </div>
          <div class="grupos-stat">
            <div class="num">${filasParseadas.length}</div><div class="lbl">total del archivo</div>
          </div>
          <div class="grupos-stat grupos-stat-unknown">
            <div class="num">${combos.length}</div><div class="lbl">grupo(s) detectado(s)</div>
          </div>
        </div>

        <div class="flex-row" style="gap:14px;flex-wrap:wrap;margin-bottom:12px">
          <label class="flex-row" style="gap:6px;margin:0">
            <input type="checkbox" id="solo-activos" checked />
            <span>Sólo alumnos activos (ignorar <b>Con Pase = Si</b>)</span>
          </label>
          <label class="flex-row" style="gap:6px;margin:0">
            <input type="checkbox" id="modo-reemplazar" />
            <span class="muted">Reemplazar roster de cada tab destino</span>
          </label>
        </div>

        ${tieneGrupos ? `
          <div class="flex-row" style="justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">
            <h4 style="margin:0">Grupos detectados <span class="muted" style="font-weight:400">(click en la tarjeta para seleccionar)</span></h4>
            <div class="flex-row" style="gap:6px">
              <button type="button" class="btn btn-gray btn-sm" id="sel-todos">✓ Todos</button>
              <button type="button" class="btn btn-gray btn-sm" id="sel-ninguno">○ Ninguno</button>
              <button type="button" class="btn btn-gray btn-sm" id="sel-invertir">⇄ Invertir</button>
            </div>
          </div>
          <div class="import-combos">
            ${combos.map((combo, i) => {
              const activos = combo.rows.filter(r => r.activo).length;
              const total = combo.rows.length;
              const nuevos = combo.rows.filter(r => !codigosClaseActual.has(r.codigo)).length;
              const yaEnClase = total - nuevos;
              const etiqueta = combo.curso || combo.grupo
                ? `${U.escapeHtml(combo.curso || "—")}°${U.escapeHtml(combo.grupo || "—")}`
                : "sin clasificar";
              const subtitulo = combo.curso || combo.grupo
                ? `Curso ${U.escapeHtml(combo.curso || "—")} · Grupo ${U.escapeHtml(combo.grupo || "—")}`
                : "(sin curso/grupo en el archivo)";
              const pctActivos = total ? Math.round((activos / total) * 100) : 0;
              const checked = (combo.curso || combo.grupo) ? "checked" : "";
              return `
                <div class="import-combo ${checked ? "selected" : ""}" data-idx="${i}">
                  <div class="import-combo-top">
                    <div class="import-combo-check">
                      <input type="checkbox" class="combo-sel" data-idx="${i}" ${checked} />
                      <div class="import-combo-badge">${etiqueta}</div>
                    </div>
                    <div class="import-combo-count">${total}</div>
                  </div>
                  <div class="import-combo-sub">${subtitulo}</div>
                  <div class="import-combo-bar" title="Activos vs inactivos">
                    <div class="import-combo-bar-fill" style="width:${pctActivos}%"></div>
                  </div>
                  <div class="import-combo-chips">
                    <span class="chip chip-ok">✓ ${activos} activos</span>
                    ${total - activos ? `<span class="chip chip-warn">⏸ ${total - activos} con pase</span>` : ""}
                    ${yaEnClase ? `<span class="chip chip-info">↻ ${yaEnClase} ya en clase</span>` : ""}
                    ${nuevos && yaEnClase ? `<span class="chip chip-new">＋ ${nuevos} nuevos</span>` : ""}
                  </div>
                  <div class="import-combo-tab">
                    <span class="muted">→ Tab destino:</span>
                    <input type="text" class="combo-tab" data-idx="${i}" value="${U.escapeHtml(combo.tab)}" />
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        ` : `
          <div class="flex-row" style="gap:8px;margin-bottom:12px;align-items:center">
            <label style="color:#333;margin:0"><b>Nombre del tab destino:</b></label>
            <input type="text" id="tab-destino-unico" value="${U.escapeHtml(claseSel || "")}" placeholder="ej. 8°1" style="max-width:220px" />
          </div>
          <div class="muted mb-12">El CSV no trae columnas Curso/Grupo. Escribí a mano cómo se va a llamar el tab en la planilla.</div>
        `}

        <div class="flex-row" style="justify-content:space-between;align-items:flex-end;margin:14px 0 8px;flex-wrap:wrap;gap:8px">
          <h4 style="margin:0">Vista previa</h4>
          <div class="muted" id="preview-count"></div>
        </div>
        <div class="roster-preview">
          <div class="roster-preview-head">
            <div>Nombre</div><div>Código (CI)</div><div>Curso/Grupo</div><div>Estado</div>
          </div>
          <div class="roster-preview-body" id="preview-body"></div>
        </div>
      </div>
      <div class="modal-foot">
        <div class="muted" id="import-summary"></div>
        <div class="flex-row" style="gap:8px">
          <button class="btn btn-gray" id="modal-cancel">Cancelar</button>
          <button class="btn btn-blue" id="modal-ok">Importar</button>
        </div>
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const cerrar = () => overlay.remove();
    modal.querySelector("#modal-cerrar").addEventListener("click", cerrar);
    modal.querySelector("#modal-cancel").addEventListener("click", cerrar);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) cerrar(); });

    const summary = modal.querySelector("#import-summary");
    const btnOk = modal.querySelector("#modal-ok");
    const soloActivos = () => modal.querySelector("#solo-activos").checked;

    // Interacciones del selector de combos.
    function setCombo(idx, on) {
      const chk = modal.querySelector(`.combo-sel[data-idx="${idx}"]`);
      if (!chk) return;
      chk.checked = on;
      const card = modal.querySelector(`.import-combo[data-idx="${idx}"]`);
      if (card) card.classList.toggle("selected", on);
    }
    modal.querySelectorAll(".import-combo").forEach(card => {
      const idx = Number(card.dataset.idx);
      const chk = card.querySelector(".combo-sel");
      const tabInput = card.querySelector(".combo-tab");
      // Click en cualquier parte de la card toggle-a (excepto el input del tab).
      card.addEventListener("click", (e) => {
        if (e.target === tabInput || e.target === chk) return;
        setCombo(idx, !chk.checked);
        actualizar();
      });
      chk.addEventListener("change", () => {
        card.classList.toggle("selected", chk.checked);
        actualizar();
      });
    });
    const btnTodos = modal.querySelector("#sel-todos");
    const btnNinguno = modal.querySelector("#sel-ninguno");
    const btnInvertir = modal.querySelector("#sel-invertir");
    if (btnTodos) btnTodos.addEventListener("click", () => { combos.forEach((_, i) => setCombo(i, true)); actualizar(); });
    if (btnNinguno) btnNinguno.addEventListener("click", () => { combos.forEach((_, i) => setCombo(i, false)); actualizar(); });
    if (btnInvertir) btnInvertir.addEventListener("click", () => {
      combos.forEach((_, i) => {
        const chk = modal.querySelector(`.combo-sel[data-idx="${i}"]`);
        setCombo(i, !chk.checked);
      });
      actualizar();
    });

    function actualizar() {
      const planes = construirPlanesImport();
      const total = planes.reduce((a, p) => a + p.rows.length, 0);
      summary.textContent = planes.length
        ? `${total} alumno(s) en ${planes.length} tab(s)`
        : "Seleccioná al menos un grupo";
      btnOk.disabled = !planes.length;
      renderPreview();
    }

    function renderPreview() {
      const body = modal.querySelector("#preview-body");
      const cnt = modal.querySelector("#preview-count");
      if (!body) return;
      // Armar el set de combos seleccionados.
      let filasVisibles = filasParseadas;
      if (tieneGrupos) {
        const sel = new Set();
        modal.querySelectorAll(".combo-sel").forEach(chk => {
          if (chk.checked) sel.add(Number(chk.dataset.idx));
        });
        const rowsDeCombos = new Set();
        sel.forEach(i => combos[i].rows.forEach(r => rowsDeCombos.add(r)));
        filasVisibles = filasParseadas.filter(f => rowsDeCombos.has(f));
      }
      const soloAct = soloActivos();
      if (soloAct) filasVisibles = filasVisibles.filter(f => f.activo);

      const mostradas = filasVisibles.slice(0, 200);
      body.innerHTML = mostradas.length ? mostradas.map(f => {
        const estadoLbl = !f.activo
          ? '<span class="badge badge-closed">con pase</span>'
          : codigosClaseActual.has(f.codigo)
            ? '<span class="badge badge-done">ya en clase</span>'
            : '<span class="badge badge-pending">nuevo</span>';
        const cg = (f.curso || f.grupo) ? `${U.escapeHtml(f.curso || "—")}°${U.escapeHtml(f.grupo || "—")}` : '<span class="muted">—</span>';
        return `
          <div class="roster-preview-row">
            <div>${U.escapeHtml(f.nombre)}</div>
            <div><code>${U.escapeHtml(f.codigo)}</code></div>
            <div>${cg}</div>
            <div>${estadoLbl}</div>
          </div>`;
      }).join("") : `<div class="muted" style="padding:20px;text-align:center">Nada para mostrar con los filtros actuales.</div>`;
      if (cnt) {
        cnt.textContent = filasVisibles.length > 200
          ? `mostrando 200 de ${filasVisibles.length}`
          : `${filasVisibles.length} alumno(s)`;
      }
    }
    modal.addEventListener("input", actualizar);
    modal.addEventListener("change", actualizar);

    function construirPlanesImport() {
      const planes = [];
      const soloAct = soloActivos();
      if (tieneGrupos) {
        modal.querySelectorAll(".combo-sel").forEach(chk => {
          if (!chk.checked) return;
          const idx = Number(chk.dataset.idx);
          const combo = combos[idx];
          const tabInput = modal.querySelector(`.combo-tab[data-idx="${idx}"]`);
          const tab = (tabInput.value || "").trim();
          if (!tab) return;
          const rows = combo.rows
            .filter(r => !soloAct || r.activo)
            .map(r => ({ codigo: r.codigo, nombre: r.nombre }));
          if (rows.length) planes.push({ tab, rows });
        });
      } else {
        const tab = (modal.querySelector("#tab-destino-unico").value || "").trim();
        if (tab) {
          const rows = filasParseadas
            .filter(r => !soloAct || r.activo)
            .map(r => ({ codigo: r.codigo, nombre: r.nombre }));
          if (rows.length) planes.push({ tab, rows });
        }
      }
      return planes;
    }

    actualizar();

    btnOk.addEventListener("click", async () => {
      const modo = modal.querySelector("#modo-reemplazar").checked ? "reemplazar" : "merge";
      const planes = construirPlanesImport();
      if (!planes.length) return;
      const totalAlumnos = planes.reduce((a, p) => a + p.rows.length, 0);
      await ejecutarImportacionConProgreso(modal, planes, modo, totalAlumnos);
    });
  }

  // Traduce errores del backend a mensajes amigables.
  const ERRORES_HUMANOS = {
    forbidden: "Contraseña rechazada por el Apps Script. ¿La admin password del Code.gs coincide con la que usaste al entrar?",
    accion_desconocida: "El Apps Script todavía corre el código viejo. Hay que redeployar una Versión nueva desde 'Administrar implementaciones'.",
    nombre_reservado: "El nombre del tab no puede ser 'respuestas', 'completados' ni 'grupos'.",
    clase_existe: "Ya existe un tab con ese nombre en la planilla.",
    clase_no_existe: "No existe el tab en la planilla.",
    clase_vacia: "El nombre del tab está vacío.",
    datos_incompletos: "Faltan datos requeridos (nombre o código).",
    empty_body: "El Apps Script no recibió datos (posible corte de red).",
    invalid_json: "El cuerpo enviado no era JSON válido.",
    lock_timeout: "El Apps Script está procesando otra operación. Probá de nuevo en unos segundos.",
    server_error: "El Apps Script tiró una excepción (mirá el log del script).",
    respuesta_no_json: "El Apps Script devolvió HTML en vez de JSON — suele ser señal de que la URL del deploy es inválida.",
  };
  function explicarError(r, errNet) {
    if (errNet) return `Red: ${errNet.message || errNet}`;
    if (!r) return "Sin respuesta del servidor.";
    const base = r.error ? (ERRORES_HUMANOS[r.error] || r.error) : "Error desconocido";
    const extra = r.detail ? ` · detalle: ${String(r.detail).slice(0, 160)}` : "";
    return base + extra;
  }

  // Reemplaza el cuerpo del modal por un stream de pasos (una fila por
  // operación). Cada paso inicia con spinner, al terminar pasa a ✔ o ✖.
  async function ejecutarImportacionConProgreso(modal, planes, modo, totalAlumnos) {
    modal.querySelector(".modal-head h3").textContent = "Importando…";
    const closeBtn = modal.querySelector("#modal-cerrar");
    if (closeBtn) closeBtn.disabled = true;
    modal.querySelector(".modal-body").innerHTML = `
      <div class="muted mb-12">Modo: <b>${modo === "reemplazar" ? "reemplazar roster" : "agregar / actualizar"}</b> · ${planes.length} tab(s) · ${totalAlumnos} alumno(s)</div>
      <div class="import-progress" id="progress-list"></div>
    `;
    modal.querySelector(".modal-foot").innerHTML = `
      <div class="muted" id="progress-summary">Procesando…</div>
      <button class="btn btn-gray" id="progress-close" disabled>Cerrar</button>
    `;
    const pl = modal.querySelector("#progress-list");
    const summary = modal.querySelector("#progress-summary");
    const btnClose = modal.querySelector("#progress-close");
    btnClose.addEventListener("click", () => modal.closest(".modal-overlay").remove());

    function nuevoPaso(titulo, sub) {
      const row = document.createElement("div");
      row.className = "progress-row running";
      row.innerHTML = `
        <div class="progress-icon"><span class="spinner-sm"></span></div>
        <div class="progress-body">
          <div class="progress-title"></div>
          <div class="progress-detail"></div>
        </div>
      `;
      row.querySelector(".progress-title").textContent = titulo;
      if (sub) row.querySelector(".progress-detail").textContent = sub;
      pl.appendChild(row);
      pl.scrollTop = pl.scrollHeight;
      return {
        ok: (detail) => {
          row.classList.remove("running"); row.classList.add("done");
          row.querySelector(".progress-icon").innerHTML = "✅";
          if (detail) row.querySelector(".progress-detail").textContent = detail;
        },
        err: (detail) => {
          row.classList.remove("running"); row.classList.add("error");
          row.querySelector(".progress-icon").innerHTML = "❌";
          if (detail) row.querySelector(".progress-detail").textContent = detail;
        },
        info: (detail) => {
          if (detail) row.querySelector(".progress-detail").textContent = detail;
        },
      };
    }

    const resultados = [];
    let diagEjecutado = false;
    // Paso 0: preparación
    const s0 = nuevoPaso(`Preparando ${planes.length} tab(s) a procesar`, `Total ${totalAlumnos} alumno(s) · modo ${modo}`);
    s0.ok();

    for (const plan of planes) {
      const s = nuevoPaso(`Importando "${plan.tab}"`, `${plan.rows.length} alumno(s) → planilla`);
      try {
        const r = await API.importarEstudiantes(pw, plan.tab, plan.rows, modo);
        resultados.push({ tab: plan.tab, r });
        if (!r || !r.ok) {
          s.err(explicarError(r));
          console.error(`importar_estudiantes "${plan.tab}" falló:`, r);
          // Si es un forbidden, tiramos el diagnóstico de auth una sola vez.
          if (r && r.error === "forbidden" && !diagEjecutado) {
            diagEjecutado = true;
            const sDiag = nuevoPaso("Diagnosticando la password", "comparando browser ↔ Apps Script");
            try {
              const d = await API.debugAuth(pw);
              if (d && d.match) {
                sDiag.ok("las passwords SÍ coinciden — revisá que el admin password del Code.gs esté redeployado en una Versión nueva");
              } else if (d) {
                const detalle = d.sent_length !== d.expected_length
                  ? `distinta longitud (browser=${d.sent_length}, Code.gs=${d.expected_length})`
                  : `mismo largo, difieren en el índice ${d.first_diff_index}`;
                sDiag.err(`passwords diferentes: ${detalle} · hacé Salir y volvé a entrar`);
                console.group("🔐 Diagnóstico de autenticación");
                console.log("browser preview:", d.sent_preview, "char-codes:", d.sent_charcodes);
                console.log("Code.gs preview:", d.expected_preview, "char-codes:", d.expected_charcodes);
                console.groupEnd();
              }
            } catch (derr) { sDiag.err(String(derr.message || derr)); }
          }
        } else {
          const partes = [];
          if (r.agregados) partes.push(`${r.agregados} nuevos`);
          if (r.actualizados) partes.push(`${r.actualizados} actualizados`);
          if (r.conflictos_total) partes.push(`${r.conflictos_total} con conflicto`);
          if (r.invalidos) partes.push(`${r.invalidos} inválidos`);
          s.ok(partes.join(" · ") || "sin cambios en esta clase");
        }
      } catch (err) {
        resultados.push({ tab: plan.tab, r: null, errNet: err });
        s.err(explicarError(null, err));
        console.error(`importar_estudiantes "${plan.tab}" error de red:`, err);
      }
    }

    // Paso final: refrescar
    const sR = nuevoPaso("Releyendo la planilla", "descargando roster actualizado");
    try {
      // Si la importación se disparó desde la landing (sin clase seleccionada)
      // y al menos una clase se creó con éxito, posicionarse en la primera.
      const primerPlanOk = planes.find((p, i) => {
        const r = resultados[i] && resultados[i].r;
        return r && r.ok;
      });
      if (!claseSel && primerPlanOk) {
        claseSel = primerPlanOk.tab;
        const url = new URL(window.location.href);
        url.searchParams.set("clase", claseSel);
        history.replaceState(null, "", url);
      }
      await refrescar();
      sR.ok(claseSel ? `abriendo "${claseSel}"` : "listo");
    } catch (err) {
      sR.err(explicarError(null, err));
      console.error("refrescar falló:", err);
    }

    // Resumen
    const sum = (key) => resultados.reduce((a, x) => a + (x.r && x.r[key] ? x.r[key] : 0), 0);
    const ag = sum("agregados"), ac = sum("actualizados"),
          co = sum("conflictos_total"), inv = sum("invalidos");
    const fallos = resultados.filter(x => !x.r || !x.r.ok).length;
    const partes = [];
    if (ag) partes.push(`${ag} nuevos`);
    if (ac) partes.push(`${ac} actualizados`);
    if (co) partes.push(`${co} conflictos`);
    if (inv) partes.push(`${inv} inválidos`);
    const resumenTxt = partes.join(" · ") || "sin cambios";
    if (fallos) {
      summary.innerHTML = `<span class="text-error">❌ ${fallos} tab(s) con error</span> · ${resumenTxt}`;
      modal.querySelector(".modal-head h3").textContent = "Importación incompleta";
      U.toast(`Import con ${fallos} error(es) · mirá el detalle`, "error");
    } else {
      summary.innerHTML = `✅ ${resumenTxt}`;
      modal.querySelector(".modal-head h3").textContent = "Importación completada";
      U.toast("Import OK · " + resumenTxt, "success");
    }
    btnClose.disabled = false;
    if (closeBtn) closeBtn.disabled = false;
  }

  async function eliminarAlumno(est) {
    if (!est.codigo) {
      alert("El estudiante no tiene código asignado. Eliminalo directamente desde la planilla.");
      return;
    }
    if (!confirm(`¿Eliminar a ${est.nombre} (${est.codigo}) de la clase ${claseSel}?`)) return;
    try {
      const r = await API.eliminarEstudiante(pw, claseSel, est.codigo);
      if (!r || !r.ok) {
        console.error("eliminar_estudiante falló:", r);
        U.toast("Error: " + ((r && r.error) || "desconocido") + " · mirá la consola", "error");
        return;
      }
      U.toast("Eliminado", "success");
      await refrescar();
    } catch (err) {
      console.error("eliminar_estudiante error de red:", err);
      U.toast("Error de conexión: " + (err.message || err), "error");
    }
  }

  async function refrescar() {
    API.clearCache();
    await init();
  }

  // Pregunta al Apps Script cómo se compara la password que tiene el browser
  // con la que tiene el Code.gs. No la expone: sólo devuelve longitudes,
  // primera diferencia y char-codes para detectar espacios/caracteres raros.
  async function ejecutarDiagnosticoAuth() {
    U.toast("Verificando permisos…", "info");
    try {
      const r = await API.debugAuth(pw);
      console.group("🔐 Diagnóstico de autenticación");
      console.log("match:", r.match);
      console.log("browser (sessionStorage) length:", r.sent_length, "preview:", r.sent_preview);
      console.log("Apps Script CONFIG.ADMIN_PASSWORD length:", r.expected_length, "preview:", r.expected_preview);
      console.log("Primer índice donde difieren:", r.first_diff_index);
      console.log("char-codes browser:", r.sent_charcodes);
      console.log("char-codes Code.gs :", r.expected_charcodes);
      console.groupEnd();
      if (r.match) {
        U.toast("✅ Las passwords coinciden. El problema no es de auth.", "success");
      } else {
        const diagnostico = r.sent_length !== r.expected_length
          ? `Distinta longitud (browser=${r.sent_length}, Code.gs=${r.expected_length}) · probablemente hay un espacio o salto de línea al final de alguna`
          : `Mismo largo pero difieren en el índice ${r.first_diff_index} · mirá los char-codes en la consola`;
        alert(
          "❌ Las passwords NO coinciden.\n\n" + diagnostico +
          "\n\nSolución habitual:\n" +
          "  1. Cerrá sesión (botón Salir) y volvé a entrar escribiendo la password de nuevo.\n" +
          "  2. Abrí el Apps Script y verificá CONFIG.ADMIN_PASSWORD (que no haya espacios/tabs al final).\n" +
          "  3. Redeployá una versión nueva.\n\n" +
          "El detalle técnico está en la consola."
        );
      }
    } catch (err) {
      console.error("debug_auth red:", err);
      U.toast("No se pudo contactar al Apps Script: " + (err.message || err), "error");
    }
  }

  // ---------- Sociograma ----------
  function renderSociograma(ests, resp) {
    const c = el("div", { class: "panel-container" });
    c.innerHTML = `
      <div class="flex-row" style="justify-content:space-between;flex-wrap:wrap;gap:10px">
        <h3>Sociograma</h3>
        <div class="sociograma-filters">
          <label class="chip chip-filter"><input type="checkbox" class="f-color" data-c="verde" checked> 🟢 Verde</label>
          <label class="chip chip-filter"><input type="checkbox" class="f-color" data-c="amarillo" checked> 🟡 Amarillo</label>
          <label class="chip chip-filter"><input type="checkbox" class="f-color" data-c="rojo" checked> 🔴 Rojo</label>
          <label class="chip chip-filter"><input type="checkbox" id="f-reciprocos"> ⇄ Sólo recíprocos</label>
          <label class="chip chip-filter"><input type="checkbox" id="f-focus"> 🎯 Sólo del seleccionado</label>
        </div>
      </div>
      <div class="muted mt-16" style="margin-bottom:10px">Pasá el mouse sobre un alumno para ver su resumen · click para fijarlo · click fuera para soltar.</div>`;

    if (!ests.length) { c.appendChild(el("p", { class: "muted" }, "Sin estudiantes.")); return c; }

    const stats = calcularStatsSociograma(ests, resp);

    const layout = el("div", { class: "sociograma-layout" });
    const svgWrap = el("div", { class: "sociograma-svg-wrap" });
    const panel = el("div", { class: "sociograma-panel", id: "sociograma-panel" });
    layout.appendChild(svgWrap);
    layout.appendChild(panel);
    c.appendChild(layout);

    panel.innerHTML = panelGlobalHTML(ests, resp, stats);

    const w = 900, h = 600, cx = w/2, cy = h/2, R = Math.min(cx, cy) - 70;
    const pos = {};
    ests.forEach((e, i) => {
      const a = -Math.PI/2 + (2*Math.PI*i)/ests.length;
      pos[e.codigo] = { x: cx + R*Math.cos(a), y: cy + R*Math.sin(a) };
    });

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("class", "sociograma-svg");
    svg.innerHTML = `
      <defs>
        <marker id="arr-v" markerWidth="7" markerHeight="7" refX="7" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="#2e7d32"/></marker>
        <marker id="arr-a" markerWidth="7" markerHeight="7" refX="7" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="#f9a825"/></marker>
        <marker id="arr-r" markerWidth="7" markerHeight="7" refX="7" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="#c62828"/></marker>
      </defs>`;

    // Radio por popularidad (verdes recibidos).
    const maxVerdes = Math.max(1, ...ests.map(e => stats[e.codigo].in.verde));
    const radio = (codigo) => {
      const v = stats[codigo].in.verde;
      return 14 + Math.round((v / maxVerdes) * 14); // 14..28
    };

    // Agrupar evaluaciones por par (i→j) para poder detectar recíprocas
    // y dibujar las flechas ligeramente separadas.
    const byPair = {};
    resp.forEach(r => {
      if (Number(r.numero_pregunta) !== 1) return;
      const k = U.colorOpcionAfinidad(r.opcion_texto).key;
      if (!k || k === "blanco") return;
      const from = String(r.codigo).trim();
      const to = String(r.evaluado_codigo).trim();
      if (!pos[from] || !pos[to]) return;
      const key = `${from}|${to}`;
      if (!byPair[key]) byPair[key] = [];
      byPair[key].push(k);
    });

    const arrows = [];
    Object.keys(byPair).forEach(key => {
      const [from, to] = key.split("|");
      const reciprocal = !!byPair[`${to}|${from}`];
      // Usamos el peor color (rojo > amarillo > verde) como dominante por dirección.
      const colores = byPair[key];
      const k = colores.includes("rojo") ? "rojo" : colores.includes("amarillo") ? "amarillo" : "verde";
      arrows.push({ from, to, k, reciprocal, count: colores.length });
    });

    arrows.forEach(a => {
      const p1 = pos[a.from], p2 = pos[a.to];
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      const len = Math.sqrt(dx*dx + dy*dy) || 1;
      const ux = dx/len, uy = dy/len;
      // Offset perpendicular si hay recíproca, para que se vean ambas flechas.
      const off = a.reciprocal ? 4 : 0;
      const px = -uy * off, py = ux * off;
      const x1 = p1.x + ux * (radio(a.from) + 2) + px;
      const y1 = p1.y + uy * (radio(a.from) + 2) + py;
      const x2 = p2.x - ux * (radio(a.to) + 6) + px;
      const y2 = p2.y - uy * (radio(a.to) + 6) + py;
      const color = a.k === "verde" ? "#2e7d32" : a.k === "amarillo" ? "#f9a825" : "#c62828";
      const m = a.k === "verde" ? "arr-v" : a.k === "amarillo" ? "arr-a" : "arr-r";
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", x1); line.setAttribute("y1", y1);
      line.setAttribute("x2", x2); line.setAttribute("y2", y2);
      line.setAttribute("stroke", color);
      line.setAttribute("stroke-width", a.k === "rojo" ? 2.2 : (a.k === "verde" ? 1.8 : 1.4));
      line.setAttribute("marker-end", `url(#${m})`);
      line.setAttribute("class", `socio-arrow socio-arrow-${a.k} ${a.reciprocal ? "socio-arrow-mutuo" : ""}`);
      line.setAttribute("data-from", a.from);
      line.setAttribute("data-to", a.to);
      svg.appendChild(line);
    });

    const codigosCompl = new Set(completados.map(c => String(c.codigo).trim()));
    ests.forEach(e => {
      const p = pos[e.codigo];
      const g = document.createElementNS(svgNS, "g");
      g.setAttribute("transform", `translate(${p.x},${p.y})`);
      g.setAttribute("class", "socio-node");
      g.setAttribute("data-codigo", e.codigo);

      // Halo (aparece en hover/selección via CSS)
      const halo = document.createElementNS(svgNS, "circle");
      halo.setAttribute("r", radio(e.codigo) + 6);
      halo.setAttribute("class", "socio-halo");
      halo.setAttribute("fill", "none");
      g.appendChild(halo);

      const circle = document.createElementNS(svgNS, "circle");
      circle.setAttribute("r", radio(e.codigo));
      circle.setAttribute("fill", codigosCompl.has(e.codigo) ? "url(#node-grad)" : "#bdbdbd");
      circle.setAttribute("stroke", "#fff");
      circle.setAttribute("stroke-width", "2.5");
      g.appendChild(circle);

      const txt = document.createElementNS(svgNS, "text");
      txt.setAttribute("y", radio(e.codigo) + 16);
      txt.setAttribute("text-anchor", "middle");
      txt.setAttribute("font-size", "12");
      txt.setAttribute("font-weight", "500");
      txt.setAttribute("fill", "#222");
      txt.textContent = primerNombre(e.nombre);
      g.appendChild(txt);

      const countVerdes = stats[e.codigo].in.verde;
      if (countVerdes > 0) {
        const badge = document.createElementNS(svgNS, "text");
        badge.setAttribute("text-anchor", "middle");
        badge.setAttribute("font-size", "11");
        badge.setAttribute("font-weight", "700");
        badge.setAttribute("fill", "#fff");
        badge.setAttribute("y", "4");
        badge.textContent = String(countVerdes);
        g.appendChild(badge);
      }

      svg.appendChild(g);
    });

    // Gradiente para nodos completados.
    const defs = svg.querySelector("defs");
    defs.insertAdjacentHTML("beforeend", `
      <radialGradient id="node-grad" cx="40%" cy="40%" r="60%">
        <stop offset="0%" stop-color="#66bb6a"/>
        <stop offset="100%" stop-color="#2e7d32"/>
      </radialGradient>
    `);

    svgWrap.appendChild(svg);

    // ---------- Interacciones ----------
    let seleccionado = null; // codigo pinned
    let hovered = null;

    function aplicarEstado() {
      const activo = seleccionado || hovered;
      const filtros = {
        verde: c.querySelector('.f-color[data-c="verde"]').checked,
        amarillo: c.querySelector('.f-color[data-c="amarillo"]').checked,
        rojo: c.querySelector('.f-color[data-c="rojo"]').checked,
        soloReciprocos: c.querySelector("#f-reciprocos").checked,
        soloDelActivo: c.querySelector("#f-focus").checked && !!activo,
      };
      svg.querySelectorAll(".socio-arrow").forEach(ln => {
        const k = ln.classList.contains("socio-arrow-verde") ? "verde"
               : ln.classList.contains("socio-arrow-amarillo") ? "amarillo" : "rojo";
        const from = ln.getAttribute("data-from");
        const to = ln.getAttribute("data-to");
        const mutuo = ln.classList.contains("socio-arrow-mutuo");
        const tocadoXActivo = activo && (from === activo || to === activo);
        const pasaFiltro =
          filtros[k] &&
          (!filtros.soloReciprocos || mutuo) &&
          (!filtros.soloDelActivo || tocadoXActivo);
        ln.classList.toggle("hidden-arrow", !pasaFiltro);
        ln.classList.toggle("dim", !!activo && !tocadoXActivo);
        ln.classList.toggle("hl-in",  !!activo && to === activo);
        ln.classList.toggle("hl-out", !!activo && from === activo);
      });
      svg.querySelectorAll(".socio-node").forEach(n => {
        const cod = n.getAttribute("data-codigo");
        n.classList.toggle("dim", !!activo && cod !== activo && !isNeighbor(cod, activo));
        n.classList.toggle("sel", seleccionado === cod);
        n.classList.toggle("hover", hovered === cod && !seleccionado);
      });
      if (activo) panel.innerHTML = panelEstudianteHTML(activo, ests, resp, stats);
      else panel.innerHTML = panelGlobalHTML(ests, resp, stats);
    }

    function isNeighbor(a, b) {
      if (!a || !b) return false;
      return !!byPair[`${a}|${b}`] || !!byPair[`${b}|${a}`];
    }

    svg.querySelectorAll(".socio-node").forEach(n => {
      const cod = n.getAttribute("data-codigo");
      n.addEventListener("mouseenter", () => { if (!seleccionado) { hovered = cod; aplicarEstado(); } });
      n.addEventListener("mouseleave", () => { if (!seleccionado) { hovered = null; aplicarEstado(); } });
      n.addEventListener("click", (e) => {
        e.stopPropagation();
        seleccionado = seleccionado === cod ? null : cod;
        aplicarEstado();
      });
    });
    svg.addEventListener("click", (e) => {
      if (e.target === svg) { seleccionado = null; aplicarEstado(); }
    });
    c.querySelectorAll(".f-color, #f-reciprocos, #f-focus").forEach(inp => {
      inp.addEventListener("change", aplicarEstado);
    });

    aplicarEstado();
    return c;
  }

  function primerNombre(s) {
    const tokens = String(s || "").split(/\s+/).filter(Boolean);
    // "Felipe Darío Álvarez Bidegain" → "Felipe"
    return tokens[0] || "";
  }

  function calcularStatsSociograma(ests, resp) {
    const base = () => ({ verde: 0, amarillo: 0, rojo: 0, blanco: 0 });
    const stats = {};
    ests.forEach(e => { stats[e.codigo] = { in: base(), out: base() }; });
    resp.forEach(r => {
      if (Number(r.numero_pregunta) !== 1) return;
      const k = U.colorOpcionAfinidad(r.opcion_texto).key;
      if (!k) return;
      const from = String(r.codigo).trim();
      const to = String(r.evaluado_codigo).trim();
      if (stats[from]) stats[from].out[k]++;
      if (stats[to])   stats[to].in[k]++;
    });
    return stats;
  }

  function statChipsHTML(obj) {
    return [
      ["verde", "🟢", obj.verde, "chip-ok"],
      ["amarillo", "🟡", obj.amarillo, "chip-warn"],
      ["rojo", "🔴", obj.rojo, "chip-err"],
      ["blanco", "⚪", obj.blanco, "chip-gray"],
    ].filter(x => x[2] > 0).map(([_,icon,n,cls]) => `<span class="chip ${cls}">${icon} ${n}</span>`).join("");
  }

  function panelGlobalHTML(ests, resp, stats) {
    const totIn = { verde: 0, amarillo: 0, rojo: 0, blanco: 0 };
    ests.forEach(e => { for (const k in totIn) totIn[k] += stats[e.codigo].in[k]; });
    // Top 3 populares.
    const tops = ests.slice().sort((a, b) => stats[b.codigo].in.verde - stats[a.codigo].in.verde).slice(0, 3);
    const conflictivos = ests.slice().sort((a, b) => stats[b.codigo].in.rojo - stats[a.codigo].in.rojo).filter(e => stats[e.codigo].in.rojo > 0).slice(0, 3);
    return `
      <div class="socio-panel-head">Resumen de la clase</div>
      <div class="chip-row">${statChipsHTML(totIn)}</div>
      <div class="muted mt-16" style="margin-top:10px">Evaluaciones totales recibidas en la pregunta de afinidad.</div>
      <h5 class="socio-panel-title">🌟 Más elegidos</h5>
      ${tops.length ? `<ul class="socio-panel-list">${tops.map(e => `<li><b>${U.escapeHtml(e.nombre)}</b> · 🟢 ${stats[e.codigo].in.verde}</li>`).join("")}</ul>` : '<div class="muted">Todavía no hay respuestas.</div>'}
      ${conflictivos.length ? `
        <h5 class="socio-panel-title">⚠️ Con más rojos recibidos</h5>
        <ul class="socio-panel-list">${conflictivos.map(e => `<li><b>${U.escapeHtml(e.nombre)}</b> · 🔴 ${stats[e.codigo].in.rojo}</li>`).join("")}</ul>
      ` : ""}`;
  }

  function panelEstudianteHTML(codigo, ests, resp, stats) {
    const e = ests.find(x => x.codigo === codigo);
    if (!e) return "";
    const st = stats[codigo];
    const quienes = reunirAfinidadesHaciaEstudiante(codigo, ests, resp);
    const recibeDe = (k) => quienes.filter(q => q.k === k).map(q => q.nombre);
    return `
      <div class="socio-panel-head">
        <div class="socio-panel-nombre">${U.escapeHtml(e.nombre)}</div>
        <div class="muted">Código: <code>${U.escapeHtml(e.codigo)}</code></div>
      </div>
      <h5 class="socio-panel-title">📥 Lo que recibe</h5>
      <div class="chip-row">${statChipsHTML(st.in) || '<span class="muted">aún sin datos</span>'}</div>
      ${recibeDe("verde").length ? `<div class="socio-recibido"><span class="chip chip-ok">🟢</span> ${recibeDe("verde").slice(0,6).map(n => U.escapeHtml(n)).join(", ")}${recibeDe("verde").length > 6 ? " +" + (recibeDe("verde").length - 6) : ""}</div>` : ""}
      ${recibeDe("amarillo").length ? `<div class="socio-recibido"><span class="chip chip-warn">🟡</span> ${recibeDe("amarillo").slice(0,6).map(n => U.escapeHtml(n)).join(", ")}${recibeDe("amarillo").length > 6 ? " +" + (recibeDe("amarillo").length - 6) : ""}</div>` : ""}
      ${recibeDe("rojo").length ? `<div class="socio-recibido"><span class="chip chip-err">🔴</span> ${recibeDe("rojo").slice(0,6).map(n => U.escapeHtml(n)).join(", ")}${recibeDe("rojo").length > 6 ? " +" + (recibeDe("rojo").length - 6) : ""}</div>` : ""}
      <h5 class="socio-panel-title">📤 Lo que dio</h5>
      <div class="chip-row">${statChipsHTML(st.out) || '<span class="muted">aún sin datos</span>'}</div>
      <div class="mt-16" style="margin-top:14px">
        <button class="btn btn-blue btn-sm" onclick='window.__abrirDetalleEst && window.__abrirDetalleEst("${U.escapeHtml(codigo)}")'>Ver detalle completo →</button>
      </div>`;
  }

  function reunirAfinidadesHaciaEstudiante(codigo, ests, resp) {
    const nomIdx = {}; ests.forEach(e => nomIdx[e.codigo] = e.nombre);
    const out = [];
    resp.forEach(r => {
      if (Number(r.numero_pregunta) !== 1) return;
      const to = String(r.evaluado_codigo).trim();
      if (to !== codigo) return;
      const k = U.colorOpcionAfinidad(r.opcion_texto).key;
      if (!k) return;
      out.push({ k, codigo: r.codigo, nombre: nomIdx[r.codigo] || r.nombre || r.codigo });
    });
    return out;
  }

  // ---------- Detalle por estudiante ----------
  function renderDetalle(ests, resp) {
    const c = el("div", { class: "panel-container" });
    c.innerHTML = `
      <div class="flex-row" style="justify-content:space-between;flex-wrap:wrap;gap:10px">
        <h3>Respuestas por estudiante</h3>
        <input type="text" id="filtro-estudiantes" placeholder="🔎 Buscar por nombre…" style="max-width:260px" />
      </div>
      <div class="muted mt-16" style="margin-bottom:10px">Click en una tarjeta para ver el detalle completo de lo que recibió y lo que dio.</div>
      <div id="detalle-grid" class="detalle-grid"></div>
    `;

    if (!ests.length) { c.appendChild(el("p", { class: "muted" }, "Sin estudiantes.")); return c; }

    const stats = calcularStatsSociograma(ests, resp);
    const codigosCompl = new Set(completados.map(x => String(x.codigo).trim()));
    const grid = c.querySelector("#detalle-grid");

    const ordenados = ests.slice().sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    ordenados.forEach(e => {
      const st = stats[e.codigo];
      const totalIn = st.in.verde + st.in.amarillo + st.in.rojo + st.in.blanco;
      const card = el("div", { class: "detalle-card" });
      card.dataset.nombre = e.nombre.toLowerCase();
      const completo = codigosCompl.has(e.codigo);
      card.innerHTML = `
        <div class="detalle-card-head">
          <div>
            <div class="detalle-card-nombre">${U.escapeHtml(e.nombre)}</div>
            <div class="muted">${U.escapeHtml(e.codigo)} · ${completo ? '✓ completó' : 'pendiente'}</div>
          </div>
          <span class="detalle-card-score">${st.in.verde}</span>
        </div>
        <div class="detalle-card-bars">
          ${barHTML("verde",    st.in.verde,    totalIn)}
          ${barHTML("amarillo", st.in.amarillo, totalIn)}
          ${barHTML("rojo",     st.in.rojo,     totalIn)}
          ${barHTML("blanco",   st.in.blanco,   totalIn)}
        </div>
        <div class="chip-row">${statChipsHTML(st.in) || '<span class="muted">sin respuestas recibidas</span>'}</div>
      `;
      card.addEventListener("click", () => abrirDetalleEstudiante(e.codigo, ests, resp));
      grid.appendChild(card);
    });

    const filtro = c.querySelector("#filtro-estudiantes");
    filtro.addEventListener("input", () => {
      const q = filtro.value.toLowerCase().trim();
      c.querySelectorAll(".detalle-card").forEach(card => {
        card.style.display = !q || card.dataset.nombre.includes(q) ? "" : "none";
      });
    });

    return c;
  }

  function barHTML(k, n, total) {
    const pct = total ? Math.round((n / total) * 100) : 0;
    const colors = { verde: "#2e7d32", amarillo: "#f9a825", rojo: "#c62828", blanco: "#9e9e9e" };
    return `<div class="detalle-bar" title="${k}: ${n}"><div style="width:${pct}%;background:${colors[k]}"></div></div>`;
  }

  // Modal con el detalle completo de respuestas recibidas y dadas por un
  // estudiante. Se abre desde el sociograma o desde la grilla de detalle.
  function abrirDetalleEstudiante(codigo, ests, resp) {
    const e = ests.find(x => x.codigo === codigo);
    if (!e) return;
    const nomIdx = {}; ests.forEach(x => nomIdx[x.codigo] = x.nombre);
    const recibidas = resp.filter(r => String(r.evaluado_codigo).trim() === codigo);
    const dadas = resp.filter(r => String(r.codigo).trim() === codigo);
    const stats = calcularStatsSociograma(ests, resp);
    const st = stats[codigo];

    const overlay = el("div", { class: "modal-overlay" });
    const modal = el("div", { class: "modal-card" });
    modal.innerHTML = `
      <div class="modal-head">
        <h3>${U.escapeHtml(e.nombre)}</h3>
        <button class="modal-close" id="m-cerrar">×</button>
      </div>
      <div class="modal-body">
        <div class="est-resumen">
          <div>
            <div class="muted">Código</div>
            <div class="est-resumen-val"><code>${U.escapeHtml(e.codigo)}</code></div>
          </div>
          <div>
            <div class="muted">Recibidos (🟢)</div>
            <div class="est-resumen-val est-resumen-verde">${st.in.verde}</div>
          </div>
          <div>
            <div class="muted">Rojos recibidos</div>
            <div class="est-resumen-val est-resumen-rojo">${st.in.rojo}</div>
          </div>
          <div>
            <div class="muted">Completó</div>
            <div class="est-resumen-val">${dadas.length ? "✅" : "⏳"}</div>
          </div>
        </div>

        <div class="est-tabs">
          <button class="est-tab active" data-tab="recibidas">📥 Lo que recibió (${recibidas.length})</button>
          <button class="est-tab" data-tab="dadas">📤 Lo que dio (${dadas.length})</button>
        </div>

        <div id="tab-recibidas" class="est-tab-pane active">
          ${renderPreguntaPane(recibidas, nomIdx, "recibidas")}
        </div>
        <div id="tab-dadas" class="est-tab-pane">
          ${renderPreguntaPane(dadas, nomIdx, "dadas")}
        </div>
      </div>
      <div class="modal-foot">
        <div class="muted">Click fuera del modal para cerrar.</div>
        <button class="btn btn-gray" id="m-cerrar2">Cerrar</button>
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const cerrar = () => overlay.remove();
    modal.querySelector("#m-cerrar").addEventListener("click", cerrar);
    modal.querySelector("#m-cerrar2").addEventListener("click", cerrar);
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) cerrar(); });

    modal.querySelectorAll(".est-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        modal.querySelectorAll(".est-tab").forEach(b => b.classList.remove("active"));
        modal.querySelectorAll(".est-tab-pane").forEach(p => p.classList.remove("active"));
        btn.classList.add("active");
        modal.querySelector(`#tab-${btn.dataset.tab}`).classList.add("active");
      });
    });
  }

  // Hook global para poder llamar abrirDetalleEstudiante desde el HTML del
  // panel del sociograma (onclick inline).
  function instalarHookDetalleEst(ests, resp) {
    window.__abrirDetalleEst = (codigo) => abrirDetalleEstudiante(codigo, ests, resp);
  }

  function renderPreguntaPane(items, nomIdx, modo) {
    if (!items.length) return '<div class="muted" style="padding:20px;text-align:center">Sin datos todavía.</div>';
    const byQ = {};
    items.forEach(r => (byQ[r.numero_pregunta] = byQ[r.numero_pregunta] || []).push(r));
    return Object.keys(byQ).sort((a, b) => Number(a) - Number(b)).map(numStr => {
      const preg = preguntas.find(p => p.numero === Number(numStr));
      const n = Number(numStr);
      // Nombre de compañero relevante (el evaluado si estamos mostrando "dadas",
      // el evaluador si estamos mostrando "recibidas").
      const nombreDe = (r) => modo === "recibidas"
        ? (nomIdx[String(r.codigo).trim()] || r.nombre || r.codigo)
        : (nomIdx[String(r.evaluado_codigo).trim()] || r.evaluado_nombre || r.evaluado_codigo);

      if (n === 1) {
        // Agrupar por compañero con su color.
        const porCompa = {};
        byQ[numStr].forEach(r => {
          const nombre = nombreDe(r);
          const k = U.colorOpcionAfinidad(r.opcion_texto).key;
          if (!porCompa[nombre]) porCompa[nombre] = { nombre, colores: [] };
          if (k) porCompa[nombre].colores.push(k);
        });
        const orden = ["verde", "amarillo", "rojo", "blanco"];
        const filas = Object.values(porCompa).sort((a, b) => {
          const ka = a.colores[0] || "zzz", kb = b.colores[0] || "zzz";
          const ia = orden.indexOf(ka), ib = orden.indexOf(kb);
          return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib);
        });
        return `
          <div class="est-preg">
            <div class="est-preg-title">${preg ? preg.numero + ". " + U.escapeHtml(preg.texto) : "Pregunta " + numStr}</div>
            <div class="est-preg-grid">
              ${filas.map(row => `<div class="est-preg-row">
                <div>${U.escapeHtml(row.nombre)}</div>
                <div>${row.colores.map(k => `<span class="opcion-${k}">${k}</span>`).join(" ")}</div>
              </div>`).join("")}
            </div>
          </div>`;
      }
      return `
        <div class="est-preg">
          <div class="est-preg-title">${preg ? preg.numero + ". " + U.escapeHtml(preg.texto) : "Pregunta " + numStr}</div>
          <div class="chip-row">
            ${byQ[numStr].map(r => {
              const nm = nombreDe(r);
              const opc = r.opcion_texto ? ` · ${U.escapeHtml(r.opcion_texto)}` : "";
              return `<span class="chip chip-info">${U.escapeHtml(nm)}${opc}</span>`;
            }).join("")}
          </div>
        </div>`;
    }).join("");
  }

  // ---------- Armado de grupos ----------
  function renderGrupos(ests, resp) {
    const c = el("div", { class: "panel-container" });
    c.innerHTML = `
      <div class="flex-row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
        <h3>3 · Armado de grupos ${draftActivo ? '<span class="badge badge-pending" title="Hay cambios en local que todavía no están en la planilla">📝 borrador no guardado</span>' : ''}</h3>
        <div class="flex-row" style="gap:8px;flex-wrap:wrap">
          <button class="btn btn-gray btn-sm" id="btn-add-grupo">+ Grupo</button>
          <button class="btn btn-orange btn-sm" id="btn-reset">Reiniciar</button>
          <button class="btn" id="btn-save">💾 Guardar en planilla</button>
        </div>
      </div>
      <p class="muted mt-16">Configurá los parámetros y presioná <b>Generar grupos</b>. El algoritmo arma grupos ponderando afinidades, reciprocidades y criterios de distribución (líderes, alumnos que necesitan más apoyo, aislados). Podés ajustar a mano con drag&amp;drop.</p>
      <div class="grupos-config mt-16">
        <div class="grupos-config-row">
          <label>
            <span>👥 Tamaño de grupo</span>
            <select id="tam-grupo" class="cuestionario-select">
              ${[3,4,5,6].map(n => `<option value="${n}" ${gruposConfig.tamGrupo===n?"selected":""}>${n} estudiantes</option>`).join("")}
            </select>
          </label>
          <label>
            <span>🎯 Estrategia</span>
            <select id="estrategia" class="cuestionario-select">
              ${[
                ["automatico","Automático (evita rojos)"],
                ["balanceado","Balanceado (mix de perfiles)"],
                ["homogeneo","Homogéneo (niveles similares)"],
                ["inclusion","Inclusión (distribuir aislados)"],
                ["liderazgo","Liderazgo (un referente por grupo)"],
              ].map(([v,l]) => `<option value="${v}" ${gruposConfig.estrategia===v?"selected":""}>${l}</option>`).join("")}
            </select>
          </label>
          <label>
            <span>⚖️ Prioridad</span>
            <select id="prioridad" class="cuestionario-select">
              ${[
                ["evitar_conflictos","Evitar conflictos"],
                ["maximizar_colaboracion","Maximizar colaboración"],
                ["desarrollar_liderazgo","Desarrollar liderazgo"],
                ["integrar_aislados","Integrar aislados"],
              ].map(([v,l]) => `<option value="${v}" ${gruposConfig.prioridad===v?"selected":""}>${l}</option>`).join("")}
            </select>
          </label>
          <label class="grupos-config-check">
            <input id="permitir-rojo" type="checkbox" ${gruposConfig.permitirRojoMutuo?"checked":""} />
            <span>Permitir rojos mutuos</span>
          </label>
        </div>
        <div class="grupos-config-actions">
          <button class="btn btn-blue" id="btn-auto">🎯 Generar grupos</button>
          <button class="btn btn-gray btn-sm" id="btn-regenerar" title="Vuelve a correr con los mismos parámetros">🔄 Regenerar</button>
          <button class="btn btn-green btn-sm" id="btn-alternativas" title="Corre el algoritmo con varias estrategias y compará los resultados">🔬 Explorar alternativas</button>
        </div>
      </div>

      <div id="grupos-compat-stats" class="grupos-compat-stats mt-16"></div>
      <div id="algo-resumen"></div>
      <div id="grupos-tablero" class="grupos-tablero mt-16"></div>
    `;

    const tamInp = c.querySelector("#tam-grupo");
    const rojoInp = c.querySelector("#permitir-rojo");
    const estrInp = c.querySelector("#estrategia");
    const prioInp = c.querySelector("#prioridad");

    // Stats de compatibilidad del curso (independientes de los grupos).
    renderCompatStats(c.querySelector("#grupos-compat-stats"), ests, resp);

    const generar = () => {
      gruposConfig = {
        tamGrupo: parseInt(tamInp.value, 10) || 4,
        permitirRojoMutuo: rojoInp.checked,
        estrategia: estrInp.value,
        prioridad: prioInp.value,
      };
      resultadoAlgoritmo = GROUPS.formarGrupos(ests, resp, opciones, gruposConfig);
      gruposLocal = resultadoAlgoritmo.grupos.map(g => ({ nombre: g.nombre, codigos: [...g.codigos] }));
      guardarBorrador();
      render();
      U.toast("Grupos generados (borrador local guardado)", "success");
    };
    c.querySelector("#btn-auto").addEventListener("click", generar);
    c.querySelector("#btn-regenerar").addEventListener("click", generar);
    c.querySelector("#btn-alternativas").addEventListener("click", () => abrirModalAlternativas(ests, resp));
    c.querySelector("#btn-add-grupo").addEventListener("click", () => {
      const n = prompt("Nombre del grupo", `Grupo ${(gruposLocal?.length || 0) + 1}`);
      if (!n) return;
      gruposLocal = gruposLocal || [];
      gruposLocal.push({ nombre: n, codigos: [] });
      guardarBorrador();
      render();
    });
    c.querySelector("#btn-reset").addEventListener("click", () => {
      if (!confirm("Borrar la composición de grupos en pantalla?")) return;
      gruposLocal = []; resultadoAlgoritmo = null;
      limpiarBorrador();
      render();
    });
    c.querySelector("#btn-save").addEventListener("click", guardarGrupos);

    if (resultadoAlgoritmo) {
      const res = resultadoAlgoritmo.resumen;
      const okGrupos = resultadoAlgoritmo.grupos.filter(g => !g.warnings.length).length;
      const warnGrupos = resultadoAlgoritmo.grupos.length - okGrupos;
      const resumen = c.querySelector("#algo-resumen");
      resumen.innerHTML = `
        <div class="grupos-algo-resumen">
          <div class="grupos-algo-tile grupos-algo-ok">
            <div class="num">${okGrupos}</div>
            <div class="lbl">grupos sin advertencias</div>
          </div>
          <div class="grupos-algo-tile grupos-algo-warn">
            <div class="num">${warnGrupos}</div>
            <div class="lbl">con advertencias</div>
          </div>
          <div class="grupos-algo-tile grupos-algo-err">
            <div class="num">${res.rojosMutuosInternos}</div>
            <div class="lbl">rojos mutuos internos</div>
          </div>
          <div class="grupos-algo-tile">
            <div class="num">${res.scoreTotal.toFixed(1)}</div>
            <div class="lbl">score total de cohesión</div>
          </div>
          <div class="grupos-algo-tile">
            <div class="num">${res.tamanos.join("·")}</div>
            <div class="lbl">tamaños</div>
          </div>
        </div>
        ${res.aislados.length ? `<div class="muted mt-16">Alumnos marcados como aislados (pregunta 8): ${res.aislados.map(U.escapeHtml).join(", ")}</div>` : ""}`;
    }

    const tablero = c.querySelector("#grupos-tablero");
    const estIdx = {}; ests.forEach(e => estIdx[e.codigo] = e);

    gruposLocal = gruposLocal || [];
    const asignados = new Set();
    gruposLocal.forEach(g => g.codigos.forEach(co => asignados.add(co)));
    const sinAsignar = ests.filter(e => !asignados.has(e.codigo)).map(e => e.codigo);

    tablero.appendChild(makeGrupoCard({ nombre: "Sin asignar", codigos: sinAsignar, isPool: true }, estIdx, -1));
    gruposLocal.forEach((g, i) => {
      // El análisis (líder, relaciones internas, fit) se sincroniza por posición
      // con `resultadoAlgoritmo.grupos[i]`. Si el usuario editó a mano, el análisis
      // puede quedar desactualizado hasta la próxima regeneración.
      const analisis = resultadoAlgoritmo && resultadoAlgoritmo.grupos[i] ? resultadoAlgoritmo.grupos[i] : null;
      tablero.appendChild(makeGrupoCard(g, estIdx, i, analisis));
    });

    return c;
  }

  // Ejecuta formarGrupos con varias combinaciones estrategia × prioridad
  // y muestra los resultados side-by-side para comparar y elegir uno.
  function abrirModalAlternativas(ests, resp) {
    const tamGrupo = parseInt(document.querySelector("#tam-grupo")?.value, 10) || 4;
    const permitir = document.querySelector("#permitir-rojo")?.checked;
    const base = { tamGrupo, permitirRojoMutuo: permitir };

    const COMBOS = [
      { label: "Balanceado · evitar conflictos", estrategia: "automatico", prioridad: "evitar_conflictos", hint: "Default robusto" },
      { label: "Balanceado · maximizar colaboración", estrategia: "balanceado", prioridad: "maximizar_colaboracion", hint: "Privilegia verdes mutuos" },
      { label: "Liderazgo · desarrollar líderes", estrategia: "liderazgo", prioridad: "desarrollar_liderazgo", hint: "Un referente por grupo" },
      { label: "Inclusión · integrar aislados", estrategia: "inclusion", prioridad: "integrar_aislados", hint: "Separa vulnerables entre grupos" },
      { label: "Homogéneo · niveles parejos", estrategia: "homogeneo", prioridad: "evitar_conflictos", hint: "Grupos con perfiles similares" },
      { label: "Colaboración intensa", estrategia: "automatico", prioridad: "maximizar_colaboracion", hint: "Arranca seguro, premia verdes" },
    ];

    const overlay = el("div", { class: "modal-overlay" });
    const modal = el("div", { class: "modal-card", style: "max-width:1100px" });
    modal.innerHTML = `
      <div class="modal-head">
        <h3>🔬 Explorar alternativas</h3>
        <button class="modal-close" id="m-cerrar">×</button>
      </div>
      <div class="modal-body">
        <p class="muted mb-12">Se corrieron ${COMBOS.length} combinaciones. Cada card resume cohesión, conflictos y balance. Click en <b>Aplicar</b> para usar esa composición.</p>
        <div class="alt-grid" id="alt-grid"></div>
      </div>
      <div class="modal-foot">
        <div class="muted" id="alt-info">Pasá el mouse sobre una card para ver detalle.</div>
        <button class="btn btn-gray" id="m-cerrar2">Cerrar</button>
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const cerrar = () => overlay.remove();
    modal.querySelector("#m-cerrar").addEventListener("click", cerrar);
    modal.querySelector("#m-cerrar2").addEventListener("click", cerrar);
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) cerrar(); });

    const grid = modal.querySelector("#alt-grid");
    const info = modal.querySelector("#alt-info");

    // Corremos cada combo. Es sync (la JS corre en el mismo tick) pero
    // generamos cards progresivamente con un pequeño yield visual.
    const resultados = [];
    COMBOS.forEach((c, idx) => {
      const placeholder = el("div", { class: "alt-card loading" });
      placeholder.innerHTML = `<div class="alt-card-head"><b>${U.escapeHtml(c.label)}</b></div><div class="muted">Calculando…</div>`;
      grid.appendChild(placeholder);
      setTimeout(() => {
        try {
          const r = GROUPS.formarGrupos(ests, resp, opciones, Object.assign({}, base, { estrategia: c.estrategia, prioridad: c.prioridad }));
          resultados[idx] = r;
          grid.replaceChild(renderAltCard(c, r, () => aplicarAlternativa(r, cerrar), info), placeholder);
        } catch (err) {
          console.error("alternativa falló:", err);
          placeholder.innerHTML = `<div class="alt-card-head"><b>${U.escapeHtml(c.label)}</b></div><div class="text-error">Error: ${U.escapeHtml(err.message || String(err))}</div>`;
        }
      }, idx * 30);
    });
  }

  function renderAltCard(combo, r, onAplicar, info) {
    const card = el("div", { class: "alt-card" });
    const rm = r.resumen.rojosMutuosInternos;
    const score = r.resumen.scoreTotal;
    const tamanos = r.resumen.tamanos;
    const aislados = r.resumen.aislados || [];
    // Agregar rel interna total para calcular indicadores generales.
    let verdeMutuo = 0, verdeUni = 0, amarillo = 0, rojo = 0, blanco = 0;
    r.grupos.forEach((g) => {
      const rel = g.relacionesInternas;
      if (!rel) return;
      verdeMutuo += rel.verdeMutuo; verdeUni += rel.verdeUnilateral;
      amarillo += rel.amarillo; rojo += rel.rojo; blanco += rel.blanco;
    });
    const totalRel = verdeMutuo + verdeUni + amarillo + rojo + blanco;
    const statusCls = rojo > 0 ? "alt-err" : (score > 0 ? "alt-ok" : "alt-neu");

    const lideres = r.grupos.filter(g => !!g.lider).length;
    card.className = "alt-card " + statusCls;
    card.innerHTML = `
      <div class="alt-card-head">
        <div>
          <div class="alt-card-title">${U.escapeHtml(combo.label)}</div>
          <div class="muted">${U.escapeHtml(combo.hint)}</div>
        </div>
        <div class="alt-card-score">${score.toFixed(0)}</div>
      </div>
      <div class="alt-stats">
        <div><span class="muted">Rojos</span><span class="${rojo>0?'text-error':''}"> ${rojo}</span></div>
        <div><span class="muted">Verdes mutuos</span><span style="color:#2e7d32"> ${verdeMutuo}</span></div>
        <div><span class="muted">Verdes unilat.</span><span> ${verdeUni}</span></div>
        <div><span class="muted">Con líder</span><span> ${lideres}/${r.grupos.length}</span></div>
      </div>
      ${totalRel > 0 ? `
        <div class="grupo-rel-bar" style="margin-top:10px">
          ${verdeMutuo ? `<div class="rel-seg rel-vm" style="flex:${verdeMutuo}">${verdeMutuo}</div>` : ""}
          ${verdeUni ? `<div class="rel-seg rel-vu" style="flex:${verdeUni}">${verdeUni}</div>` : ""}
          ${amarillo ? `<div class="rel-seg rel-am" style="flex:${amarillo}">${amarillo}</div>` : ""}
          ${rojo ? `<div class="rel-seg rel-ro" style="flex:${rojo}">${rojo}</div>` : ""}
          ${blanco ? `<div class="rel-seg rel-bl" style="flex:${blanco}">${blanco}</div>` : ""}
        </div>` : ""}
      <div class="alt-tamanos">Tamaños: ${tamanos.join(" · ")}${aislados.length ? ` · ${aislados.length} aislados` : ""}</div>
      <div class="alt-actions">
        <button class="btn btn-blue btn-sm">Aplicar esta composición</button>
      </div>
    `;
    card.querySelector(".alt-actions button").addEventListener("click", onAplicar);
    card.addEventListener("mouseenter", () => {
      info.innerHTML = `Estrategia <b>${U.escapeHtml(combo.estrategia)}</b> · prioridad <b>${U.escapeHtml(combo.prioridad)}</b> · score ${score.toFixed(1)}`;
    });
    return card;
  }

  function aplicarAlternativa(r, cerrar) {
    resultadoAlgoritmo = r;
    gruposLocal = r.grupos.map(g => ({ nombre: g.nombre, codigos: [...g.codigos] }));
    guardarBorrador();
    cerrar();
    U.toast("Alternativa aplicada (borrador local guardado)", "success");
    render();
    // Scroll suave al panel de grupos.
    const target = document.getElementById("paso-grupos");
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function makeGrupoCard(g, estIdx, gruposIndex, analisis) {
    const warnings = (analisis && analisis.warnings) || [];
    const tieneRojoMutuo = warnings.some(w => w.startsWith("Rojo mutuo"));
    const tieneWarn = warnings.length > 0 && !tieneRojoMutuo;
    let statusCls = "";
    let statusLabel = "";
    if (!g.isPool) {
      if (tieneRojoMutuo)      { statusCls = "status-err";  statusLabel = "❌ Con incompatibilidades"; }
      else if (tieneWarn)      { statusCls = "status-warn"; statusLabel = "⚠️ Con advertencias"; }
      else if (g.codigos.length) { statusCls = "status-ok";   statusLabel = "✅ Compatible"; }
    }
    const card = el("div", { class: "grupo-card " + statusCls });
    const head = el("div", { class: "flex-row", style: "justify-content:space-between;align-items:flex-start" });
    const lider = analisis && analisis.lider;
    const title = el("div", null, [
      el("h4", null, `${g.nombre}${g.isPool ? "" : ` (${g.codigos.length})`}`),
      statusLabel ? el("div", { class: "grupo-status " + statusCls }, statusLabel) : null,
      lider ? el("div", { class: "grupo-lider", html: `👑 <b>${U.escapeHtml(lider.nombre)}</b> · referente` }) : null,
    ]);
    head.appendChild(title);
    if (!g.isPool) {
      const acts = el("div", { class: "flex-row" });
      acts.appendChild(el("button", { class: "btn btn-gray btn-sm", onclick: () => {
        const nn = prompt("Renombrar grupo", g.nombre);
        if (nn) { gruposLocal[gruposIndex].nombre = nn; render(); }
      }}, "✎"));
      acts.appendChild(el("button", { class: "btn btn-red btn-sm", onclick: () => {
        if (!confirm("Eliminar este grupo? Sus integrantes vuelven a 'Sin asignar'.")) return;
        gruposLocal.splice(gruposIndex, 1); render();
      }}, "✕"));
      head.appendChild(acts);
    }
    card.appendChild(head);

    // Barra horizontal apilada con las relaciones internas.
    const rel = analisis && analisis.relacionesInternas;
    if (rel && rel.total > 0) {
      const seg = (n, cls, lbl) => n > 0
        ? `<div class="rel-seg rel-${cls}" style="flex:${n}" title="${lbl}: ${n}">${n}</div>`
        : "";
      const bar = el("div", { class: "grupo-rel-bar mt-16", html: `
        ${seg(rel.verdeMutuo, "vm", "Verde mutuo")}
        ${seg(rel.verdeUnilateral, "vu", "Verde unilateral")}
        ${seg(rel.amarillo, "am", "Amarillo")}
        ${seg(rel.rojo, "ro", "Rojo")}
        ${seg(rel.blanco, "bl", "Sin evaluar")}
      `});
      card.appendChild(bar);
      const leyenda = el("div", { class: "grupo-rel-leyenda" });
      [
        ["vm", `${rel.verdeMutuo} 🟢↔`],
        ["vu", `${rel.verdeUnilateral} 🟢→`],
        ["am", `${rel.amarillo} 🟡`],
        ["ro", `${rel.rojo} 🔴`],
        ["bl", `${rel.blanco} ⚪`],
      ].forEach(([c, t]) => {
        leyenda.appendChild(el("span", { class: `rel-tag rel-${c}` }, t));
      });
      card.appendChild(leyenda);
    }

    // Miembros con fit chip.
    const fitIdx = {};
    if (analisis && analisis.fitPorMiembro) {
      analisis.fitPorMiembro.forEach((m) => { fitIdx[m.codigo] = m; });
    }
    const body = el("div", { class: "mt-16" });
    g.codigos.forEach(co => {
      const est = estIdx[co]; if (!est) return;
      const m = fitIdx[co];
      const fitCls = !m ? "" : (m.fit > 0.5 ? "fit-ok" : (m.fit < -0.5 ? "fit-bad" : "fit-neutro"));
      const tags = [];
      if (m && m.lider) tags.push(`<span class="mini-tag tag-lider" title="Referente declarado">👑</span>`);
      if (m && m.apoyo) tags.push(`<span class="mini-tag tag-apoyo" title="Necesita apoyo">🤝</span>`);
      if (m && m.aislado) tags.push(`<span class="mini-tag tag-aislado" title="Aislado">🫥</span>`);
      const chip = el("span", { class: "grupo-estudiante " + fitCls, draggable: "true", title: m ? `Fit en el grupo: ${m.fit.toFixed(1)}` : "", html: `${U.escapeHtml(est.nombre)}${tags.length ? " " + tags.join("") : ""}` });
      chip.dataset.codigo = co;
      chip.addEventListener("dragstart", (e) => {
        chip.classList.add("dragging");
        e.dataTransfer.setData("text/plain", co);
      });
      chip.addEventListener("dragend", () => chip.classList.remove("dragging"));
      chip.addEventListener("dblclick", () => moverEstudiante(co, null));
      body.appendChild(chip);
    });
    card.appendChild(body);

    if (warnings.length) {
      const w = el("div", { class: "muted mt-16", style: "font-size:0.85em;color:#b26a00" });
      warnings.forEach(t => w.appendChild(el("div", null, "⚠ " + t)));
      card.appendChild(w);
    }

    card.addEventListener("dragover", (e) => { e.preventDefault(); card.classList.add("drop-target"); });
    card.addEventListener("dragleave", () => card.classList.remove("drop-target"));
    card.addEventListener("drop", (e) => {
      e.preventDefault(); card.classList.remove("drop-target");
      const co = e.dataTransfer.getData("text/plain");
      moverEstudiante(co, g.isPool ? null : gruposIndex);
    });
    return card;
  }

  function renderCompatStats(host, ests, resp) {
    if (!host) return;
    const codigos = ests.map(e => String(e.codigo).trim());
    const enClase = new Set(codigos);
    // Para cada par (a,b), clasificar: si alguno evaluó rojo → problemática;
    // si no y alguno verde → compatible; si no y alguno amarillo → neutra;
    // si no, todo blanco/sin respuesta → desconocida.
    const color = {};  // color[a][b] → key de pregunta 1.
    codigos.forEach(a => color[a] = {});
    resp.forEach(r => {
      if (Number(r.numero_pregunta) !== 1) return;
      const a = String(r.codigo).trim(), b = String(r.evaluado_codigo).trim();
      if (!enClase.has(a) || !enClase.has(b)) return;
      const k = U.colorOpcionAfinidad(r.opcion_texto).key;
      if (!k) return;
      color[a][b] = k;
    });

    let comp = 0, neu = 0, prob = 0, desc = 0;
    for (let i = 0; i < codigos.length; i++) {
      for (let j = i + 1; j < codigos.length; j++) {
        const a = codigos[i], b = codigos[j];
        const ab = color[a][b], ba = color[b][a];
        if (ab === "rojo" || ba === "rojo") prob++;
        else if (ab === "verde" || ba === "verde") comp++;
        else if (ab === "amarillo" || ba === "amarillo") neu++;
        else desc++;
      }
    }

    host.innerHTML = `
      <h4 class="grupos-stats-title">📊 Compatibilidad del curso (por pares)</h4>
      <div class="grupos-stats-grid">
        <div class="grupos-stat grupos-stat-ok">
          <div class="num">${comp}</div><div class="lbl">Compatibles</div>
        </div>
        <div class="grupos-stat grupos-stat-warn">
          <div class="num">${neu}</div><div class="lbl">Neutras</div>
        </div>
        <div class="grupos-stat grupos-stat-err">
          <div class="num">${prob}</div><div class="lbl">Incompatibilidades</div>
        </div>
        <div class="grupos-stat grupos-stat-unknown">
          <div class="num">${desc}</div><div class="lbl">Sin experiencia</div>
        </div>
      </div>`;
  }

  function moverEstudiante(codigo, destinoIndex) {
    gruposLocal.forEach(g => { g.codigos = g.codigos.filter(x => x !== codigo); });
    if (destinoIndex !== null && destinoIndex >= 0 && gruposLocal[destinoIndex]) {
      gruposLocal[destinoIndex].codigos.push(codigo);
    }
    guardarBorrador();
    render();
  }

  async function guardarGrupos() {
    if (!claseSel || !gruposLocal) return;
    const estIdx = {}; estudiantes.forEach(e => estIdx[e.codigo] = e);
    const payload = gruposLocal.map(g => ({
      nombre: g.nombre,
      codigos: g.codigos,
      nombres: g.codigos.map(c => (estIdx[c] || { nombre: c }).nombre),
    }));
    try {
      const r = await API.saveGrupos(pw, claseSel, payload);
      if (r && r.ok) {
        U.toast("Grupos guardados en Google Sheets", "success");
        limpiarBorrador();
        render();
      } else {
        console.error("saveGrupos falló:", r);
        U.toast("Error al guardar: " + (r && r.error || "desconocido"), "error");
      }
    } catch (err) {
      console.error("saveGrupos error de red:", err);
      U.toast("Error de conexión: " + (err.message || err), "error");
    }
  }
})();
