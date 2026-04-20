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
    if (!ests || ests.ok === false || !resp || resp.ok === false) {
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
    return h;
  }

  function renderSelectorClase() {
    const c = el("div", { class: "panel-container" });
    c.appendChild(el("h3", null, "Seleccioná una clase"));
    if (!clases.length) {
      c.appendChild(el("p", { class: "muted mt-16" }, "No hay clases todavía. Creá una hoja por clase en la planilla, o usá el botón de abajo."));
    } else {
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

    const wrap = el("div", { class: "mt-16 flex-row", style: "gap:8px" });
    wrap.appendChild(el("button", { class: "btn", onclick: nuevaClasePrompt }, "+ Nueva clase"));
    c.appendChild(wrap);
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
          <h4 style="margin-bottom:8px">Elegí qué grupos importar y el nombre del tab destino:</h4>
          <div class="import-combos">
            ${combos.map((combo, i) => {
              const activos = combo.rows.filter(r => r.activo).length;
              const inactivos = combo.rows.length - activos;
              const etiqueta = combo.curso || combo.grupo
                ? `${U.escapeHtml(combo.curso || "—")} · ${U.escapeHtml(combo.grupo || "—")}`
                : "(sin curso/grupo en el archivo)";
              return `
                <div class="import-combo" data-idx="${i}">
                  <label class="import-combo-check">
                    <input type="checkbox" class="combo-sel" data-idx="${i}" ${combo.curso || combo.grupo ? "checked" : ""} />
                    <div>
                      <div class="import-combo-title">${etiqueta}</div>
                      <div class="muted">${activos} activo(s)${inactivos ? ` · ${inactivos} inactivos` : ""}</div>
                    </div>
                  </label>
                  <div class="import-combo-tab">
                    <span class="muted">→ Tab:</span>
                    <input type="text" class="combo-tab" data-idx="${i}" value="${U.escapeHtml(combo.tab)}" />
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        ` : `
          <div class="flex-row" style="gap:8px;margin-bottom:12px">
            <label style="color:#333;margin:0"><b>Tab destino:</b></label>
            <input type="text" id="tab-destino-unico" value="${U.escapeHtml(claseSel || "")}" style="max-width:220px" />
          </div>
        `}

        <h4 style="margin:14px 0 8px">Vista previa (primeros 200)</h4>
        <div class="roster-preview">
          <div class="roster-preview-head">
            <div>Nombre</div><div>Código (CI)</div><div>Curso/Grupo</div><div>Estado</div>
          </div>
          <div class="roster-preview-body">
            ${filasParseadas.slice(0, 200).map(f => {
              const estadoLbl = !f.activo
                ? '<span class="badge badge-closed">con pase</span>'
                : codigosClaseActual.has(f.codigo)
                  ? '<span class="badge badge-done">ya en clase</span>'
                  : '<span class="badge badge-pending">nuevo</span>';
              const cg = (f.curso || f.grupo) ? `${U.escapeHtml(f.curso || "—")} · ${U.escapeHtml(f.grupo || "—")}` : '<span class="muted">—</span>';
              return `
                <div class="roster-preview-row">
                  <div>${U.escapeHtml(f.nombre)}</div>
                  <div><code>${U.escapeHtml(f.codigo)}</code></div>
                  <div>${cg}</div>
                  <div>${estadoLbl}</div>
                </div>
              `;
            }).join("")}
            ${filasParseadas.length > 200 ? `<div class="muted mt-16">(mostrando los primeros 200 de ${filasParseadas.length})</div>` : ""}
          </div>
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

    function actualizarResumen() {
      const planes = construirPlanesImport();
      const total = planes.reduce((a, p) => a + p.rows.length, 0);
      summary.textContent = planes.length
        ? `${total} alumno(s) en ${planes.length} tab(s)`
        : "Nada seleccionado";
      btnOk.disabled = !planes.length;
    }
    modal.addEventListener("input", actualizarResumen);
    modal.addEventListener("change", actualizarResumen);

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

    actualizarResumen();

    btnOk.addEventListener("click", async () => {
      const modo = modal.querySelector("#modo-reemplazar").checked ? "reemplazar" : "merge";
      const planes = construirPlanesImport();
      if (!planes.length) return;
      cerrar();
      U.toast(`Importando ${planes.length} tab(s)…`, "info");
      try {
        const resultados = [];
        for (const plan of planes) {
          const r = await API.importarEstudiantes(pw, plan.tab, plan.rows, modo);
          resultados.push({ tab: plan.tab, r });
          if (!r || !r.ok) console.error(`importar_estudiantes "${plan.tab}" falló:`, r);
        }
        const sumar = (key) => resultados.reduce((a, x) => a + (x.r && x.r[key] ? x.r[key] : 0), 0);
        const partes = [];
        const ag = sumar("agregados"), ac = sumar("actualizados"),
              co = sumar("conflictos_total"), inv = sumar("invalidos");
        if (ag) partes.push(`${ag} nuevos`);
        if (ac) partes.push(`${ac} actualizados`);
        if (co) partes.push(`${co} con conflicto`);
        if (inv) partes.push(`${inv} inválidos`);
        const fallos = resultados.filter(x => !x.r || !x.r.ok).length;
        if (fallos) U.toast(`${fallos} tab(s) con error · mirá la consola`, "error");
        else U.toast("Import OK · " + (partes.join(" · ") || "sin cambios"), "success");
        await refrescar();
      } catch (err) {
        console.error("importar_estudiantes error de red:", err);
        U.toast("Error de conexión: " + (err.message || err), "error");
      }
    });
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

  // ---------- Sociograma ----------
  function renderSociograma(ests, resp) {
    const c = el("div", { class: "panel-container" });
    c.innerHTML = `<h3>Sociograma</h3>
      <div class="sociograma-legend">
        <span><span class="swatch" style="background:#2e7d32"></span>Verde (afinidad)</span>
        <span><span class="swatch" style="background:#f9a825"></span>Amarillo (a veces)</span>
        <span><span class="swatch" style="background:#c62828"></span>Rojo (dificultad)</span>
        <span class="muted">⚪ Blanco no se muestra</span>
      </div>
      <div class="muted mb-12">Las flechas salen del evaluador hacia el evaluado.</div>`;

    if (!ests.length) { c.appendChild(el("p", { class: "muted" }, "Sin estudiantes.")); return c; }

    const w = 900, h = 600, cx = w/2, cy = h/2, R = Math.min(cx, cy) - 60;
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
        <marker id="arr-v" markerWidth="6" markerHeight="6" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#2e7d32"/></marker>
        <marker id="arr-a" markerWidth="6" markerHeight="6" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#f9a825"/></marker>
        <marker id="arr-r" markerWidth="6" markerHeight="6" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#c62828"/></marker>
      </defs>`;

    resp.forEach(r => {
      if (Number(r.numero_pregunta) !== 1) return;
      const k = U.colorOpcionAfinidad(r.opcion_texto).key;
      if (!k || k === "blanco") return;
      const p1 = pos[String(r.codigo).trim()], p2 = pos[String(r.evaluado_codigo).trim()];
      if (!p1 || !p2) return;
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      const len = Math.sqrt(dx*dx + dy*dy) || 1;
      const x2 = p2.x - (dx/len)*22, y2 = p2.y - (dy/len)*22;
      const color = k === "verde" ? "#2e7d32" : k === "amarillo" ? "#f9a825" : "#c62828";
      const m = k === "verde" ? "arr-v" : k === "amarillo" ? "arr-a" : "arr-r";
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", p1.x); line.setAttribute("y1", p1.y);
      line.setAttribute("x2", x2);   line.setAttribute("y2", y2);
      line.setAttribute("stroke", color);
      line.setAttribute("stroke-opacity", "0.55");
      line.setAttribute("stroke-width", k === "rojo" ? 1.6 : 1.2);
      line.setAttribute("marker-end", `url(#${m})`);
      svg.appendChild(line);
    });

    const codigosCompl = new Set(completados.map(c => String(c.codigo).trim()));
    ests.forEach(e => {
      const p = pos[e.codigo];
      const g = document.createElementNS(svgNS, "g");
      g.setAttribute("transform", `translate(${p.x},${p.y})`);
      const circle = document.createElementNS(svgNS, "circle");
      circle.setAttribute("r", "18");
      circle.setAttribute("fill", codigosCompl.has(e.codigo) ? "#4CAF50" : "#bdbdbd");
      circle.setAttribute("stroke", "#fff");
      circle.setAttribute("stroke-width", "2");
      g.appendChild(circle);
      const txt = document.createElementNS(svgNS, "text");
      txt.setAttribute("y", "34");
      txt.setAttribute("text-anchor", "middle");
      txt.setAttribute("font-size", "12");
      txt.setAttribute("fill", "#222");
      txt.textContent = (e.nombre || "").split(" ")[0];
      g.appendChild(txt);
      const title = document.createElementNS(svgNS, "title");
      title.textContent = e.nombre + (codigosCompl.has(e.codigo) ? " (completado)" : " (pendiente)");
      g.appendChild(title);
      svg.appendChild(g);
    });

    c.appendChild(svg);
    return c;
  }

  // ---------- Detalle por estudiante ----------
  function renderDetalle(ests, resp) {
    const c = el("div", { class: "panel-container" });
    c.innerHTML = `<h3>Respuestas recibidas por cada estudiante</h3>`;
    if (!ests.length) { c.appendChild(el("p", { class: "muted" }, "Sin estudiantes.")); return c; }

    const recibidasPorEvaluado = {};
    resp.forEach(r => {
      const ev = String(r.evaluado_codigo || "").trim();
      if (!ev) return;
      (recibidasPorEvaluado[ev] = recibidasPorEvaluado[ev] || []).push(r);
    });

    const ul = el("div", { class: "list-card mt-16" });
    ests.forEach(e => {
      const item = el("div", { class: "item", style: "flex-direction:column;align-items:flex-start" });
      item.appendChild(el("div", { style: "font-weight:600;font-size:1.05em" }, e.nombre));
      item.appendChild(el("div", { class: "muted" }, `Código: ${e.codigo}`));

      const recibidas = recibidasPorEvaluado[e.codigo] || [];
      if (!recibidas.length) {
        item.appendChild(el("div", { class: "muted mt-16" }, "Aún sin respuestas recibidas."));
      } else {
        const byQ = {};
        recibidas.forEach(r => (byQ[r.numero_pregunta] = byQ[r.numero_pregunta] || []).push(r));
        const wrap = el("div", { class: "mt-16", style: "width:100%" });
        Object.keys(byQ).sort((a,b) => Number(a) - Number(b)).forEach(numStr => {
          const preg = preguntas.find(p => p.numero === Number(numStr));
          const linea = el("div", { class: "mb-12" });
          linea.appendChild(el("div", { style: "font-weight:600;color:#1976d2;margin-bottom:4px" },
            preg ? `${preg.numero}. ${preg.texto}` : `Pregunta ${numStr}`));
          const contRow = el("div", { class: "flex-row", style: "flex-wrap:wrap" });
          if (Number(numStr) === 1) {
            const counts = { verde:0, amarillo:0, rojo:0, blanco:0 };
            byQ[numStr].forEach(r => {
              const k = U.colorOpcionAfinidad(r.opcion_texto).key;
              if (k) counts[k]++;
            });
            ["verde","amarillo","rojo","blanco"].forEach(k => {
              if (!counts[k]) return;
              contRow.appendChild(el("span", { class: "opcion-" + k, style: "margin-right:6px" }, `${k}: ${counts[k]}`));
            });
          } else {
            byQ[numStr].forEach(r => {
              const label = r.opcion_texto ? `${r.nombre} · ${r.opcion_texto}` : r.nombre;
              contRow.appendChild(el("span", { class: "badge badge-done", style: "margin:2px" }, label));
            });
          }
          linea.appendChild(contRow);
          wrap.appendChild(linea);
        });
        item.appendChild(wrap);
      }
      ul.appendChild(item);
    });
    c.appendChild(ul);
    return c;
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
      const warn = resultadoAlgoritmo && resultadoAlgoritmo.grupos[i] ? resultadoAlgoritmo.grupos[i].warnings : [];
      tablero.appendChild(makeGrupoCard(g, estIdx, i, warn));
    });

    return c;
  }

  function makeGrupoCard(g, estIdx, gruposIndex, warnings) {
    const tieneRojoMutuo = (warnings || []).some(w => w.startsWith("Rojo mutuo"));
    const tieneWarn = !!(warnings && warnings.length) && !tieneRojoMutuo;
    let statusCls = "";
    let statusLabel = "";
    if (!g.isPool) {
      if (tieneRojoMutuo)      { statusCls = "status-err";  statusLabel = "❌ Con incompatibilidades"; }
      else if (tieneWarn)      { statusCls = "status-warn"; statusLabel = "⚠️ Con advertencias"; }
      else if (g.codigos.length) { statusCls = "status-ok";   statusLabel = "✅ Compatible"; }
    }
    const card = el("div", { class: "grupo-card " + statusCls });
    const head = el("div", { class: "flex-row", style: "justify-content:space-between;align-items:flex-start" });
    const title = el("div", null, [
      el("h4", null, `${g.nombre}${g.isPool ? "" : ` (${g.codigos.length})`}`),
      statusLabel ? el("div", { class: "grupo-status " + statusCls }, statusLabel) : null,
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

    const body = el("div", { class: "mt-16" });
    g.codigos.forEach(co => {
      const est = estIdx[co]; if (!est) return;
      const chip = el("span", { class: "grupo-estudiante", draggable: "true" }, est.nombre);
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

    if (warnings && warnings.length) {
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
