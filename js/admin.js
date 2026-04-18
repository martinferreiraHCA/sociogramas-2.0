// Panel admin: gestión de clases, alumnos (CSV) y cuestionarios.
// Reusa la contraseña guardada en sessionStorage tras admin-login.html.

(function () {
  const $ = U.$, $$ = U.$$, el = U.el;
  const root = $("#admin-root");

  // Si no hay password, mandar a login
  let pw = sessionStorage.getItem("admin_pw");
  if (!pw) { window.location.href = "./admin-login.html"; return; }

  let clases = [];
  let claseSeleccionada = null;  // {id, identificador, ...}
  let dashboard = null;          // {cuestionario, estudiantes, respuestas, grupos}

  init().catch(err => {
    console.error(err);
    U.toast("Error inicial", "error");
  });

  async function init() {
    await cargarClases();
    render();
  }

  async function cargarClases() {
    const r = await SB.rpc("admin_listar_clases", { p_password: pw });
    if (!r || !r.ok) {
      sessionStorage.removeItem("admin_pw");
      window.location.href = "./admin-login.html";
      return;
    }
    clases = r.data || [];
  }

  function render() {
    root.innerHTML = "";
    root.appendChild(renderHeader());
    if (!claseSeleccionada) {
      root.appendChild(renderListadoClases());
    } else {
      root.appendChild(renderDetalleClase());
    }
  }

  function renderHeader() {
    const h = el("div", { class: "panel-container" });
    h.innerHTML = `
      <div class="flex-row" style="justify-content:space-between">
        <h2 style="color:#4CAF50">Panel del docente</h2>
        <div class="flex-row">
          <a class="btn btn-blue btn-sm" href="./dashboard.html">Dashboard / sociograma</a>
          <button class="btn btn-gray btn-sm" id="btn-logout">Salir</button>
        </div>
      </div>
    `;
    h.querySelector("#btn-logout").addEventListener("click", () => {
      sessionStorage.removeItem("admin_pw");
      window.location.href = "./admin-login.html";
    });
    return h;
  }

  // ---------- Listado de clases ----------
  function renderListadoClases() {
    const c = el("div", { class: "panel-container" });
    c.innerHTML = `<h3 class="mb-16">Clases</h3>`;

    // Crear nueva
    const form = el("form", { class: "flex-row mb-16" });
    const inp = el("input", { type: "text", placeholder: "Nombre de la nueva clase", required: "true", style: "max-width:300px" });
    form.appendChild(inp);
    const btn = el("button", { class: "btn", type: "submit" }, "Crear clase");
    form.appendChild(btn);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      btn.disabled = true;
      try {
        const r = await SB.rpc("admin_crear_clase", { p_password: pw, p_identificador: inp.value.trim() });
        if (r && r.ok) {
          U.toast("Clase creada", "success");
          await cargarClases();
          render();
        } else U.toast("No se pudo crear", "error");
      } finally { btn.disabled = false; }
    });
    c.appendChild(form);

    // Listado
    if (!clases.length) {
      c.appendChild(el("p", { class: "muted" }, "Todavía no hay clases."));
      return c;
    }
    const lista = el("div", { class: "list-card" });
    clases.forEach(cl => {
      const item = el("div", { class: "item" });
      item.appendChild(el("div", null, [
        el("div", { style: "font-weight:600" }, cl.identificador),
        el("div", { class: "muted" },
          `${cl.estudiantes} estudiante(s) · ${cl.cuestionario_activo_id ? "cuestionario ACTIVO" : "sin cuestionario activo"}`)
      ]));
      const acc = el("div", { class: "flex-row" });
      acc.appendChild(el("button", { class: "btn btn-blue btn-sm", onclick: () => abrirClase(cl) }, "Abrir"));
      acc.appendChild(el("button", { class: "btn btn-red btn-sm", onclick: () => eliminarClase(cl) }, "Eliminar"));
      item.appendChild(acc);
      lista.appendChild(item);
    });
    c.appendChild(lista);
    return c;
  }

  async function abrirClase(cl) {
    claseSeleccionada = cl;
    await cargarDashboard();
    render();
  }

  async function eliminarClase(cl) {
    if (!confirm(`Eliminar la clase "${cl.identificador}" y todos sus datos?`)) return;
    const r = await SB.rpc("admin_eliminar_clase", { p_password: pw, p_clase_id: cl.id });
    if (r && r.ok) { U.toast("Clase eliminada", "success"); await cargarClases(); render(); }
    else U.toast("No se pudo eliminar", "error");
  }

  async function cargarDashboard() {
    const r = await SB.rpc("admin_dashboard", { p_password: pw, p_clase_id: claseSeleccionada.id });
    if (r && r.ok) dashboard = r;
    else { dashboard = null; U.toast("No se pudo cargar la clase", "error"); }
  }

  // ---------- Detalle de una clase ----------
  function renderDetalleClase() {
    const c = el("div", { class: "panel-container" });
    const cuest = dashboard?.cuestionario;
    const estudiantes = dashboard?.estudiantes || [];
    const completados = estudiantes.filter(e => e.completado).length;

    c.innerHTML = `
      <div class="flex-row" style="justify-content:space-between">
        <h3>Clase: ${U.escapeHtml(claseSeleccionada.identificador)}</h3>
        <button class="btn btn-gray btn-sm" id="btn-volver">← Volver</button>
      </div>
    `;
    c.querySelector("#btn-volver").addEventListener("click", () => {
      claseSeleccionada = null; dashboard = null; render();
    });

    // ---- Bloque cuestionario ----
    const blkCuest = el("div", { class: "list-card mt-16" });
    const it = el("div", { class: "item" });
    if (cuest) {
      it.appendChild(el("div", null, [
        el("div", { style: "font-weight:600" }, "Cuestionario"),
        el("div", { class: "muted" },
          `Estado: ${cuest.estado} · Creado: ${new Date(cuest.created_at).toLocaleString()} · ` +
          `Completados: ${completados}/${estudiantes.length}`)
      ]));
      const acc = el("div", { class: "flex-row" });
      if (cuest.estado === "ACTIVA") {
        acc.appendChild(el("button", { class: "btn btn-orange btn-sm", onclick: () => cerrarCuestionario(cuest) }, "Cerrar"));
      } else {
        acc.appendChild(el("button", { class: "btn btn-blue btn-sm", onclick: () => reabrirCuestionario(cuest) }, "Reabrir"));
      }
      acc.appendChild(el("a", { class: "btn btn-blue btn-sm", href: `./dashboard.html?clase=${claseSeleccionada.id}` }, "Ver dashboard"));
      acc.appendChild(el("button", { class: "btn btn-red btn-sm", onclick: () => crearCuestionario(true) },
        "Reiniciar cuestionario"));
      it.appendChild(acc);
    } else {
      it.appendChild(el("div", null, [
        el("div", { style: "font-weight:600" }, "Sin cuestionario"),
        el("div", { class: "muted" }, "Creá un cuestionario para que los alumnos puedan responder.")
      ]));
      it.appendChild(el("button", { class: "btn", onclick: () => crearCuestionario(false) }, "Crear cuestionario"));
    }
    blkCuest.appendChild(it);
    c.appendChild(blkCuest);

    // ---- Bloque carga CSV ----
    const blkCSV = el("div", { class: "mt-24" });
    blkCSV.innerHTML = `
      <h4 class="mb-12">Cargar estudiantes desde CSV</h4>
      <div class="upload-section" id="drop-zone">
        <p class="mb-12">Arrastrá un CSV o seleccionalo. Columnas requeridas: <b>nombre, codigo_estudiante</b>.</p>
        <label class="btn">
          <input type="file" accept=".csv" id="csv-file" />
          Seleccionar archivo CSV
        </label>
        <div class="mt-16 muted">
          <a href="#" id="ejemplo-csv">Descargar CSV de ejemplo</a>
        </div>
        <div class="mt-16 flex-row" style="justify-content:center">
          <label style="display:inline-flex;align-items:center;gap:6px;color:#333;font-weight:500">
            <input type="checkbox" id="reset-est" /> Reemplazar todos los estudiantes existentes
          </label>
        </div>
      </div>`;
    c.appendChild(blkCSV);

    blkCSV.querySelector("#ejemplo-csv").addEventListener("click", (e) => {
      e.preventDefault();
      const ejemplo =
        "nombre,codigo_estudiante\n" +
        "Juan Pérez,JUAN001\n" +
        "María García,MARIA002\n";
      U.downloadFile("estudiantes_ejemplo.csv", ejemplo, "text/csv");
    });

    const file = blkCSV.querySelector("#csv-file");
    const drop = blkCSV.querySelector("#drop-zone");
    file.addEventListener("change", () => importarCSV(file.files[0], blkCSV.querySelector("#reset-est").checked));
    ["dragenter","dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("dragover"); }));
    ["dragleave","drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("dragover"); }));
    drop.addEventListener("drop", e => {
      const f = e.dataTransfer.files[0];
      if (f) importarCSV(f, blkCSV.querySelector("#reset-est").checked);
    });

    // ---- Listado de estudiantes ----
    const blkEst = el("div", { class: "mt-24" });
    blkEst.innerHTML = `
      <div class="flex-row" style="justify-content:space-between">
        <h4>Estudiantes (${estudiantes.length})</h4>
        <div class="flex-row">
          <button class="btn btn-blue btn-sm" id="btn-export-csv">Exportar CSV</button>
          <button class="btn btn-blue btn-sm" id="btn-export-resp">Exportar respuestas CSV</button>
        </div>
      </div>`;
    if (!estudiantes.length) {
      blkEst.appendChild(el("p", { class: "muted mt-16" }, "Cargá un CSV para empezar."));
    } else {
      const tabla = el("table", { class: "data-table mt-16" });
      tabla.innerHTML = `
        <thead><tr>
          <th>Nombre</th>
          <th>Código</th>
          <th>Estado</th>
          <th>Acciones</th>
        </tr></thead>`;
      const tbody = el("tbody");
      estudiantes.forEach(e => {
        const tr = el("tr");
        tr.innerHTML = `
          <td>${U.escapeHtml(e.nombre)}</td>
          <td><code>${U.escapeHtml(e.codigo_estudiante)}</code></td>
          <td>${e.completado
            ? `<span class="badge badge-done">completado</span>`
            : `<span class="badge badge-pending">pendiente</span>`}</td>
          <td></td>`;
        const td = tr.lastElementChild;
        if (e.completado) {
          const b = el("button", { class: "btn btn-orange btn-sm", onclick: () => resetear(e) }, "Reabrir");
          td.appendChild(b);
        }
        const del = el("button", { class: "btn btn-red btn-sm", style: "margin-left:6px", onclick: () => eliminarEst(e) }, "Eliminar");
        td.appendChild(del);
        tbody.appendChild(tr);
      });
      tabla.appendChild(tbody);
      blkEst.appendChild(tabla);
    }
    c.appendChild(blkEst);

    blkEst.querySelector("#btn-export-csv")?.addEventListener("click", () => {
      const csv = U.objectsToCSV(estudiantes.map(e => ({
        nombre: e.nombre, codigo_estudiante: e.codigo_estudiante,
        completado: e.completado, completado_at: e.completado_at || ""
      })));
      U.downloadFile(`estudiantes_${claseSeleccionada.identificador}.csv`, csv, "text/csv");
    });
    blkEst.querySelector("#btn-export-resp")?.addEventListener("click", exportarRespuestas);

    return c;
  }

  // ---------- Acciones ----------
  async function crearCuestionario(reset) {
    if (reset && !confirm("Reiniciar el cuestionario borrará todas las respuestas y desbloqueará a los alumnos. ¿Continuar?")) return;
    const r = await SB.rpc("admin_crear_cuestionario", { p_password: pw, p_clase_id: claseSeleccionada.id });
    if (r && r.ok) { U.toast("Cuestionario creado", "success"); await cargarDashboard(); render(); }
    else U.toast("No se pudo crear el cuestionario", "error");
  }
  async function cerrarCuestionario(c) {
    if (!confirm("Cerrar el cuestionario impedirá nuevas respuestas. ¿Continuar?")) return;
    const r = await SB.rpc("admin_cerrar_cuestionario", { p_password: pw, p_id: c.id });
    if (r && r.ok) { U.toast("Cerrado", "success"); await cargarDashboard(); render(); }
    else U.toast("Error", "error");
  }
  async function reabrirCuestionario(c) {
    const r = await SB.rpc("admin_reabrir_cuestionario", { p_password: pw, p_id: c.id });
    if (r && r.ok) { U.toast("Reabierto", "success"); await cargarDashboard(); render(); }
    else U.toast("Error", "error");
  }
  async function resetear(e) {
    if (!confirm(`Reabrir el cuestionario para ${e.nombre}? Se borrarán sus respuestas.`)) return;
    const r = await SB.rpc("admin_resetear_estudiante", { p_password: pw, p_id: e.id });
    if (r && r.ok) { U.toast("Estudiante reabierto", "success"); await cargarDashboard(); render(); }
    else U.toast("Error", "error");
  }
  async function eliminarEst(e) {
    if (!confirm(`Eliminar a ${e.nombre} y todas sus respuestas?`)) return;
    const r = await SB.rpc("admin_eliminar_estudiante", { p_password: pw, p_id: e.id });
    if (r && r.ok) { U.toast("Eliminado", "success"); await cargarDashboard(); render(); }
    else U.toast("Error", "error");
  }

  async function importarCSV(file, reset) {
    if (!file) return;
    try {
      const text = await file.text();
      const objs = U.csvToObjects(text);
      // Aceptar variantes de nombres
      const norm = objs.map(o => ({
        nombre: o.nombre || o.Nombre || o.NOMBRE || "",
        codigo_estudiante: o.codigo_estudiante || o.codigo || o["código"] || o["Código"] || ""
      })).filter(o => o.nombre && o.codigo_estudiante);
      if (!norm.length) {
        U.toast("CSV vacío o sin columnas válidas", "error");
        return;
      }
      const r = await SB.rpc("admin_importar_estudiantes", {
        p_password: pw, p_clase_id: claseSeleccionada.id,
        p_estudiantes: norm, p_reset: !!reset
      });
      if (r && r.ok) {
        U.toast(`Importados ${r.creados} (omitidos ${r.omitidos})`, "success");
        await cargarDashboard();
        render();
      } else {
        U.toast("No se pudo importar", "error");
      }
    } catch (err) {
      console.error(err);
      U.toast("Error leyendo el archivo", "error");
    }
  }

  function exportarRespuestas() {
    const respuestas = dashboard?.respuestas || [];
    if (!respuestas.length) { U.toast("No hay respuestas todavía", "warn"); return; }
    const estIdx = {};
    (dashboard.estudiantes || []).forEach(e => estIdx[e.id] = e);
    const flat = respuestas.map(r => ({
      estudiante: estIdx[r.estudiante_id]?.nombre || r.estudiante_id,
      evaluado: estIdx[r.estudiante_evaluado_id]?.nombre || "",
      pregunta_id: r.pregunta_id,
      opcion_pregunta_id: r.opcion_pregunta_id || "",
      otro_texto: r.otro_texto || ""
    }));
    U.downloadFile(`respuestas_${claseSeleccionada.identificador}.csv`, U.objectsToCSV(flat), "text/csv");
  }
})();
