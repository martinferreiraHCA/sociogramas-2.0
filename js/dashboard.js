// Dashboard del docente: estadísticas, sociograma y armado de grupos.
// Requiere admin_pw en sessionStorage.

(function () {
  const $ = U.$, $$ = U.$$, el = U.el;
  const root = $("#dashboard-root");

  let pw = sessionStorage.getItem("admin_pw");
  if (!pw) { window.location.href = "./admin-login.html"; return; }

  let clases = [];
  let claseId = U.getQueryParam("clase");
  let claseSel = null;
  let dashboard = null;
  let preguntas = [], opciones = [];
  let opcionesPorPregunta = {}, preguntaPorNumero = {};

  init().catch(err => { console.error(err); U.toast("Error", "error"); });

  async function init() {
    // Cargar clases + preguntas en paralelo
    const [clRes, prRes] = await Promise.all([
      SB.rpc("admin_listar_clases", { p_password: pw }),
      SB.loadPreguntas()
    ]);
    if (!clRes || !clRes.ok) {
      sessionStorage.removeItem("admin_pw");
      window.location.href = "./admin-login.html";
      return;
    }
    clases = clRes.data || [];
    preguntas = prRes.preguntas;
    opciones = prRes.opciones;
    preguntas.forEach(p => preguntaPorNumero[p.numero_pregunta] = p);
    opciones.forEach(op => (opcionesPorPregunta[op.pregunta_id] = opcionesPorPregunta[op.pregunta_id] || []).push(op));

    if (claseId) await cargarDashboard();
    render();
  }

  async function cargarDashboard() {
    const r = await SB.rpc("admin_dashboard", { p_password: pw, p_clase_id: claseId });
    if (r && r.ok) {
      dashboard = r;
      claseSel = clases.find(c => c.id === claseId) || { id: claseId, identificador: "—" };
    } else {
      U.toast("Error cargando dashboard", "error");
      dashboard = null;
    }
  }

  // ---------- Render ----------
  function render() {
    root.innerHTML = "";
    root.appendChild(headerBar());
    if (!claseId) {
      root.appendChild(renderSelectorClase());
      return;
    }
    if (!dashboard) {
      root.appendChild(el("div", { class: "panel-container" }, "Cargando…"));
      return;
    }
    root.appendChild(renderResumen());
    root.appendChild(renderSociograma());
    root.appendChild(renderDetalleEstudiantes());
    root.appendChild(renderGrupos());
  }

  function headerBar() {
    const h = el("div", { class: "panel-container" });
    h.innerHTML = `
      <div class="flex-row" style="justify-content:space-between">
        <h2 style="color:#4CAF50">Dashboard ${claseSel ? "· " + U.escapeHtml(claseSel.identificador) : ""}</h2>
        <div class="flex-row">
          <a class="btn btn-gray btn-sm" href="./admin.html">← Panel</a>
          <button class="btn btn-gray btn-sm" id="btn-logout">Salir</button>
        </div>
      </div>`;
    h.querySelector("#btn-logout").addEventListener("click", () => {
      sessionStorage.removeItem("admin_pw");
      window.location.href = "./admin-login.html";
    });
    return h;
  }

  function renderSelectorClase() {
    const c = el("div", { class: "panel-container" });
    c.appendChild(el("h3", null, "Seleccioná una clase"));
    if (!clases.length) {
      c.appendChild(el("p", { class: "muted mt-16" }, "No hay clases creadas. Volvé al panel para crear una."));
      return c;
    }
    const list = el("div", { class: "list-card mt-16" });
    clases.forEach(cl => {
      const it = el("div", { class: "item" });
      it.appendChild(el("div", null, [
        el("div", { style: "font-weight:600" }, cl.identificador),
        el("div", { class: "muted" }, `${cl.estudiantes} estudiante(s)`)
      ]));
      it.appendChild(el("a", { class: "btn btn-blue btn-sm", href: `./dashboard.html?clase=${cl.id}` }, "Ver dashboard"));
      list.appendChild(it);
    });
    c.appendChild(list);
    return c;
  }

  // ---------- Resumen ----------
  function contarAfinidad() {
    const preg1 = preguntaPorNumero[1];
    if (!preg1) return { verde: 0, amarillo: 0, rojo: 0, blanco: 0, total: 0 };
    const opIdx = {};
    (opcionesPorPregunta[preg1.id] || []).forEach(o => opIdx[o.id] = o);
    const counts = { verde: 0, amarillo: 0, rojo: 0, blanco: 0, total: 0 };
    (dashboard.respuestas || []).forEach(r => {
      if (r.pregunta_id !== preg1.id || !r.opcion_pregunta_id) return;
      const op = opIdx[r.opcion_pregunta_id];
      if (!op) return;
      const k = U.colorOpcionAfinidad(op.texto_opcion).key;
      if (k) { counts[k]++; counts.total++; }
    });
    return counts;
  }

  function renderResumen() {
    const c = el("div", { class: "panel-container" });
    const cuest = dashboard.cuestionario;
    const ests = dashboard.estudiantes;
    const completados = ests.filter(e => e.completado).length;

    c.innerHTML = `
      <h3>Resumen</h3>
      <p class="muted">${cuest ? `Cuestionario ${cuest.estado}` : "Sin cuestionario"} · ${completados}/${ests.length} estudiantes completaron</p>`;
    const counts = contarAfinidad();
    const grid = el("div", { class: "stats-grid" });
    grid.appendChild(statBox("👥", ests.length, "estudiantes", ""));
    grid.appendChild(statBox("📈", `${ests.length ? Math.round((completados/ests.length)*100) : 0}%`, "completaron", ""));
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
      el("div", { class: "lbl" }, lbl)
    ]);
  }

  // ---------- Sociograma ----------
  // Layout circular simple: cada estudiante en un círculo,
  // aristas coloreadas según afinidad declarada por el evaluador (estudiante_id)
  // hacia el evaluado (estudiante_evaluado_id). Una arista por color por par.
  function renderSociograma() {
    const c = el("div", { class: "panel-container" });
    c.innerHTML = `<h3>Sociograma</h3>
      <div class="sociograma-legend">
        <span><span class="swatch" style="background:#2e7d32"></span>Verde (afinidad)</span>
        <span><span class="swatch" style="background:#f9a825"></span>Amarillo (a veces)</span>
        <span><span class="swatch" style="background:#c62828"></span>Rojo (dificultad)</span>
        <span class="muted">⚪ Blanco no se muestra</span>
      </div>
      <div class="muted mb-12">Las flechas salen del evaluador hacia el evaluado.</div>`;

    const ests = dashboard.estudiantes;
    if (!ests.length) {
      c.appendChild(el("p", { class: "muted" }, "Sin estudiantes."));
      return c;
    }

    const preg1 = preguntaPorNumero[1];
    const opIdx = {};
    if (preg1) (opcionesPorPregunta[preg1.id] || []).forEach(o => opIdx[o.id] = o);

    // Layout circular
    const w = 900, h = 600, cx = w/2, cy = h/2, R = Math.min(cx, cy) - 60;
    const positions = {};
    ests.forEach((e, i) => {
      const a = -Math.PI/2 + (2*Math.PI*i)/ests.length;
      positions[e.id] = { x: cx + R*Math.cos(a), y: cy + R*Math.sin(a) };
    });

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("class", "sociograma-svg");

    // defs marker arrowhead
    svg.innerHTML = `
      <defs>
        <marker id="arr-v" markerWidth="6" markerHeight="6" refX="6" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 z" fill="#2e7d32"/>
        </marker>
        <marker id="arr-a" markerWidth="6" markerHeight="6" refX="6" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 z" fill="#f9a825"/>
        </marker>
        <marker id="arr-r" markerWidth="6" markerHeight="6" refX="6" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 z" fill="#c62828"/>
        </marker>
      </defs>`;

    // Aristas
    (dashboard.respuestas || []).forEach(r => {
      if (!preg1 || r.pregunta_id !== preg1.id) return;
      if (!r.opcion_pregunta_id || !r.estudiante_evaluado_id) return;
      const op = opIdx[r.opcion_pregunta_id];
      if (!op) return;
      const k = U.colorOpcionAfinidad(op.texto_opcion).key;
      if (!k || k === "blanco") return;
      const p1 = positions[r.estudiante_id], p2 = positions[r.estudiante_evaluado_id];
      if (!p1 || !p2) return;
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      const len = Math.sqrt(dx*dx + dy*dy) || 1;
      const off = 22;
      const x2 = p2.x - (dx/len)*off, y2 = p2.y - (dy/len)*off;
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

    // Nodos
    ests.forEach(e => {
      const p = positions[e.id];
      const g = document.createElementNS(svgNS, "g");
      g.setAttribute("transform", `translate(${p.x},${p.y})`);
      const circle = document.createElementNS(svgNS, "circle");
      circle.setAttribute("r", "18");
      circle.setAttribute("fill", e.completado ? "#4CAF50" : "#bdbdbd");
      circle.setAttribute("stroke", "#fff");
      circle.setAttribute("stroke-width", "2");
      g.appendChild(circle);
      const txt = document.createElementNS(svgNS, "text");
      txt.setAttribute("y", "34");
      txt.setAttribute("text-anchor", "middle");
      txt.setAttribute("font-size", "12");
      txt.setAttribute("fill", "#222");
      txt.textContent = e.nombre.split(" ")[0];
      g.appendChild(txt);
      g.appendChild(document.createElementNS(svgNS, "title"))
        .textContent = e.nombre + (e.completado ? " (completado)" : " (pendiente)");
      svg.appendChild(g);
    });

    c.appendChild(svg);
    return c;
  }

  // ---------- Detalle por estudiante ----------
  function renderDetalleEstudiantes() {
    const c = el("div", { class: "panel-container" });
    c.innerHTML = `<h3>Respuestas recibidas por cada estudiante</h3>`;
    const ests = dashboard.estudiantes;
    const estIdx = {}; ests.forEach(e => estIdx[e.id] = e);
    const opIdx = {}; opciones.forEach(o => opIdx[o.id] = o);
    const pregIdx = {}; preguntas.forEach(p => pregIdx[p.id] = p);

    const detallePorEval = {};
    (dashboard.respuestas || []).forEach(r => {
      if (!r.estudiante_evaluado_id) return;
      (detallePorEval[r.estudiante_evaluado_id] = detallePorEval[r.estudiante_evaluado_id] || []).push(r);
    });

    if (!ests.length) {
      c.appendChild(el("p", { class: "muted" }, "Sin estudiantes."));
      return c;
    }

    const ul = el("div", { class: "list-card mt-16" });
    ests.forEach(e => {
      const item = el("div", { class: "item", style: "flex-direction:column;align-items:flex-start" });
      item.appendChild(el("div", { style: "font-weight:600;font-size:1.05em" }, e.nombre));
      item.appendChild(el("div", { class: "muted" },
        `Código: ${e.codigo_estudiante} · ${e.completado ? "completó" : "pendiente"}`));

      const recibidas = detallePorEval[e.id] || [];
      if (!recibidas.length) {
        item.appendChild(el("div", { class: "muted mt-16" }, "Aún sin respuestas recibidas."));
      } else {
        // Agrupar por pregunta
        const byQ = {};
        recibidas.forEach(r => (byQ[r.pregunta_id] = byQ[r.pregunta_id] || []).push(r));
        const wrap = el("div", { class: "mt-16", style: "width:100%" });
        Object.keys(byQ).forEach(qid => {
          const preg = pregIdx[qid];
          const linea = el("div", { class: "mb-12" });
          linea.appendChild(el("div", { style: "font-weight:600;color:#1976d2;margin-bottom:4px" },
            preg ? `${preg.numero_pregunta}. ${preg.texto}` : "Pregunta"));
          const contRow = el("div", { class: "flex-row" });
          if (preg && preg.numero_pregunta === 1) {
            // Conteos por color
            const counts = { verde:0, amarillo:0, rojo:0, blanco:0 };
            byQ[qid].forEach(r => {
              const op = opIdx[r.opcion_pregunta_id];
              if (!op) return;
              const k = U.colorOpcionAfinidad(op.texto_opcion).key;
              if (k) counts[k]++;
            });
            ["verde","amarillo","rojo","blanco"].forEach(k => {
              if (!counts[k]) return;
              contRow.appendChild(el("span", { class: "opcion-" + k }, `${k}: ${counts[k]}`));
            });
          } else {
            // Para 5..10 + 2/3/4: mostrar quién lo eligió
            byQ[qid].forEach(r => {
              const evaluador = estIdx[r.estudiante_id];
              const op = opIdx[r.opcion_pregunta_id];
              const txt = op ? op.texto_opcion : "✓";
              contRow.appendChild(el("span", {
                class: "badge badge-done",
                style: "margin:2px"
              }, `${evaluador ? evaluador.nombre : "?"}${op ? " · " + txt : ""}`));
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

  // ---------- Grupos armados (drag and drop simple) ----------
  // Estado local del editor de grupos
  let gruposLocal = null;

  function renderGrupos() {
    const c = el("div", { class: "panel-container" });
    c.innerHTML = `
      <div class="flex-row" style="justify-content:space-between">
        <h3>Armado de grupos</h3>
        <div class="flex-row">
          <button class="btn btn-blue btn-sm" id="btn-add-grupo">+ Grupo</button>
          <button class="btn btn-orange btn-sm" id="btn-reset-grupos">Reiniciar</button>
          <button class="btn" id="btn-save-grupos">Guardar</button>
        </div>
      </div>
      <p class="muted mt-16">Arrastrá los nombres entre tarjetas o usá los botones para mover. Se guardan asociados al cuestionario actual.</p>`;

    if (!dashboard.cuestionario) {
      c.appendChild(el("p", { class: "muted mt-16" }, "Necesitás un cuestionario activo para armar grupos."));
      return c;
    }

    if (!gruposLocal) {
      // Cargar desde dashboard.grupos o crear "Sin asignar" vacío
      gruposLocal = (dashboard.grupos && dashboard.grupos.length)
        ? dashboard.grupos.map(g => ({ nombre: g.nombre, ids: [...(g.estudiantes_ids||[])] }))
        : [];
    }
    const ests = dashboard.estudiantes;
    const estIdx = {}; ests.forEach(e => estIdx[e.id] = e);
    const asignados = new Set();
    gruposLocal.forEach(g => g.ids.forEach(id => asignados.add(id)));
    const sinAsignar = ests.filter(e => !asignados.has(e.id)).map(e => e.id);

    const tablero = el("div", { class: "grupos-tablero mt-16" });
    // Card "sin asignar"
    tablero.appendChild(makeGrupoCard({ nombre: "Sin asignar", ids: sinAsignar, isPool: true }, estIdx));
    gruposLocal.forEach((g, i) => tablero.appendChild(makeGrupoCard(g, estIdx, i)));
    c.appendChild(tablero);

    c.querySelector("#btn-add-grupo").addEventListener("click", () => {
      const n = prompt("Nombre del grupo", `Grupo ${gruposLocal.length + 1}`);
      if (!n) return;
      gruposLocal.push({ nombre: n, ids: [] });
      render();
    });
    c.querySelector("#btn-reset-grupos").addEventListener("click", () => {
      if (!confirm("Borrar la composición de grupos en pantalla?")) return;
      gruposLocal = [];
      render();
    });
    c.querySelector("#btn-save-grupos").addEventListener("click", guardarGrupos);

    return c;
  }

  function makeGrupoCard(g, estIdx, gruposIndex) {
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
    g.ids.forEach(id => {
      const est = estIdx[id]; if (!est) return;
      const chip = el("span", { class: "grupo-estudiante", draggable: "true" }, est.nombre);
      chip.dataset.id = id;
      chip.addEventListener("dragstart", (e) => {
        chip.classList.add("dragging");
        e.dataTransfer.setData("text/plain", id);
      });
      chip.addEventListener("dragend", () => chip.classList.remove("dragging"));
      // doble-click → mover a "sin asignar"
      chip.addEventListener("dblclick", () => moverEstudiante(id, null));
      body.appendChild(chip);
    });
    card.appendChild(body);

    card.addEventListener("dragover", (e) => { e.preventDefault(); card.classList.add("drop-target"); });
    card.addEventListener("dragleave", () => card.classList.remove("drop-target"));
    card.addEventListener("drop", (e) => {
      e.preventDefault(); card.classList.remove("drop-target");
      const id = e.dataTransfer.getData("text/plain");
      moverEstudiante(id, g.isPool ? null : gruposIndex);
    });
    return card;
  }

  function moverEstudiante(estId, destinoIndex) {
    gruposLocal.forEach(g => { g.ids = g.ids.filter(x => x !== estId); });
    if (destinoIndex !== null && gruposLocal[destinoIndex]) {
      gruposLocal[destinoIndex].ids.push(estId);
    }
    render();
  }

  async function guardarGrupos() {
    if (!dashboard.cuestionario) return;
    const payload = gruposLocal.map(g => ({ nombre: g.nombre, estudiantes_ids: g.ids }));
    const r = await SB.rpc("admin_guardar_grupos", {
      p_password: pw,
      p_cuestionario_id: dashboard.cuestionario.id,
      p_grupos: payload
    });
    if (r && r.ok) U.toast("Grupos guardados", "success");
    else U.toast("Error al guardar", "error");
  }
})();
