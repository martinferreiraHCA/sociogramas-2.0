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

  init().catch(err => {
    console.error(err);
    root.innerHTML = `<div class="panel-container"><p class="cuestionario-error">Error cargando el dashboard. Revisá la consola.</p></div>`;
  });

  async function init() {
    root.innerHTML = `<div class="panel-container"><p>Cargando…</p></div>`;
    const [csvs, resp, compl, grp] = await Promise.all([
      API.loadAll(),
      API.fetchRespuestas(pw),
      API.fetchCompletados(pw),
      API.fetchGrupos(pw),
    ]);
    if (!resp || resp.ok === false) {
      sessionStorage.removeItem("admin_pw");
      window.location.href = "./admin-login.html";
      return;
    }
    estudiantes = csvs.estudiantes;
    preguntas   = csvs.preguntas;
    opciones    = csvs.opciones;
    respuestas  = resp.data || [];
    completados = (compl && compl.data) || [];
    const grupos = (grp && grp.data) || [];
    clases = Array.from(new Set(estudiantes.map(e => e.clase))).sort();

    if (!claseSel && clases.length === 1) claseSel = clases[0];
    if (claseSel) {
      gruposLocal = gruposParaClase(grupos, claseSel);
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
    root.appendChild(renderResumen(esClase, resp, completadosClase));
    root.appendChild(renderSociograma(esClase, resp));
    root.appendChild(renderDetalle(esClase, resp));
    root.appendChild(renderGrupos(esClase, resp));
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
    if (selNode) selNode.addEventListener("change", () => {
      claseSel = selNode.value || "";
      gruposLocal = null; resultadoAlgoritmo = null;
      const url = new URL(window.location.href);
      if (claseSel) url.searchParams.set("clase", claseSel);
      else url.searchParams.delete("clase");
      history.replaceState(null, "", url);
      render();
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
      c.appendChild(el("p", { class: "muted mt-16" }, "No hay clases en data/estudiantes.csv."));
      return c;
    }
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
    return c;
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
        <h3>Armado de grupos</h3>
        <div class="flex-row" style="gap:8px;flex-wrap:wrap">
          <label class="muted" style="display:flex;align-items:center;gap:6px">
            Tamaño
            <input id="tam-grupo" type="number" min="2" max="8" value="4" style="width:60px" />
          </label>
          <label class="muted" style="display:flex;align-items:center;gap:6px">
            <input id="permitir-rojo" type="checkbox" /> Permitir rojos mutuos
          </label>
          <button class="btn btn-blue btn-sm" id="btn-auto">Generar automático</button>
          <button class="btn btn-gray btn-sm" id="btn-add-grupo">+ Grupo</button>
          <button class="btn btn-orange btn-sm" id="btn-reset">Reiniciar</button>
          <button class="btn" id="btn-save">Guardar</button>
        </div>
      </div>
      <p class="muted mt-16">El botón <b>Generar automático</b> arma grupos ponderando afinidades, reciprocidades y criterios de distribución (líderes, alumnos que necesitan más apoyo, aislados). Podés ajustar a mano con drag&amp;drop.</p>
      <div id="algo-resumen"></div>
      <div id="grupos-tablero" class="grupos-tablero mt-16"></div>
    `;

    const tamInp = c.querySelector("#tam-grupo");
    const rojoInp = c.querySelector("#permitir-rojo");

    c.querySelector("#btn-auto").addEventListener("click", () => {
      const tamGrupo = parseInt(tamInp.value, 10) || 4;
      resultadoAlgoritmo = GROUPS.formarGrupos(ests, resp, opciones, {
        tamGrupo,
        permitirRojoMutuo: rojoInp.checked,
      });
      gruposLocal = resultadoAlgoritmo.grupos.map(g => ({ nombre: g.nombre, codigos: [...g.codigos] }));
      render();
      U.toast("Grupos generados", "success");
    });
    c.querySelector("#btn-add-grupo").addEventListener("click", () => {
      const n = prompt("Nombre del grupo", `Grupo ${(gruposLocal?.length || 0) + 1}`);
      if (!n) return;
      gruposLocal = gruposLocal || [];
      gruposLocal.push({ nombre: n, codigos: [] });
      render();
    });
    c.querySelector("#btn-reset").addEventListener("click", () => {
      if (!confirm("Borrar la composición de grupos en pantalla?")) return;
      gruposLocal = []; resultadoAlgoritmo = null;
      render();
    });
    c.querySelector("#btn-save").addEventListener("click", guardarGrupos);

    if (resultadoAlgoritmo) {
      const res = resultadoAlgoritmo.resumen;
      const resumen = c.querySelector("#algo-resumen");
      resumen.innerHTML = `
        <div class="panel-container" style="padding:12px;background:#f4f9f4;margin-top:12px">
          <b>Score total de cohesión:</b> ${res.scoreTotal.toFixed(1)} ·
          <b>Rojos mutuos internos:</b> ${res.rojosMutuosInternos} ·
          <b>Tamaños:</b> ${res.tamanos.join(", ")}
          ${res.aislados.length ? `<br><span class="muted">Alumnos marcados como aislados (pregunta 8): ${res.aislados.map(U.escapeHtml).join(", ")}</span>` : ""}
        </div>`;
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
    const card = el("div", { class: "grupo-card" });
    const head = el("div", { class: "flex-row", style: "justify-content:space-between" });
    head.appendChild(el("h4", null, g.nombre));
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

  function moverEstudiante(codigo, destinoIndex) {
    gruposLocal.forEach(g => { g.codigos = g.codigos.filter(x => x !== codigo); });
    if (destinoIndex !== null && destinoIndex >= 0 && gruposLocal[destinoIndex]) {
      gruposLocal[destinoIndex].codigos.push(codigo);
    }
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
      if (r && r.ok) U.toast("Grupos guardados en Google Sheets", "success");
      else U.toast("Error al guardar: " + (r && r.error || "desconocido"), "error");
    } catch (err) {
      console.error(err);
      U.toast("Error de conexión", "error");
    }
  }
})();
