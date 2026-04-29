// Cuestionario del estudiante (versión CSV + Google Apps Script).
//
// Flujo:
//   1. Login por código (se valida contra el roster de la Google Sheet
//      vía Apps Script) → compañeros de la misma clase.
//   2. Pantalla de instrucciones.
//   3. Pregunta de afinidad (tipo AFINIDAD) por cada compañero, con
//      sub-pregunta MULTIPLE según lo que diga data/flujos.csv.
//   4. Preguntas de tipo SELECCION_COMPANEROS, una a una (checkboxes).
//   5. Submit al Apps Script → escribe filas en la Google Sheet.
//
// Las respuestas parciales se guardan en localStorage con la clave
// "cuest:" + codigo por si se corta el navegador.

(function () {
  const codigo = U.getQueryParam("codigo");
  const $ = U.$, el = U.el;
  const STATE_KEY = codigo ? `cuest:${codigo}` : null;
  const QUEUE_KEY = "cuest-queue";
  const root = $("#cuestionario-root");

  if (!codigo) {
    root.innerHTML = '<div class="panel-container"><p>Falta el código del estudiante. <a href="./index.html">Volver al inicio</a>.</p></div>';
    return;
  }

  // Descripciones que se muestran sobre cada card de afinidad. Igualan la
  // explicación que el alumno vio en la pantalla de instrucciones.
  const AFINIDAD_DESC = {
    verde: {
      short: "Se trabaja muy bien con este/a compañero/a",
      long: "Esta persona participa, escucha, propone ideas, cumple con las tareas, ayuda a otros y respeta los tiempos y espacios del grupo. Con ella el trabajo fluye, se avanza y es más fácil ponerse de acuerdo. Te sentís cómodo/a, incluido/a y hay respeto.",
    },
    amarillo: {
      short: "A veces se trabaja bien, otras no",
      long: "Hay días o tareas en las que trabajar con esta persona funciona bien, pero otras veces se distrae, interrumpe o no cumple. Tal vez se pone las pilas si el grupo lo motiva, pero también puede hablar más de lo que trabaja, o dejar las cosas a medias. A veces te resulta fácil, otras veces, frustrante.",
    },
    rojo: {
      short: "Me resulta muy difícil trabajar con este/a compañero/a",
      long: "Esta persona interrumpe, se queja sin ayudar, no cumple con las tareas, o incluso maltrata, critica sin aportar o ignora al grupo. Puede generar conflictos, desconcentración o tensión. Sentís que trabajar con ella te hace más difícil aprender o avanzar.",
    },
    blanco: {
      short: "No tengo suficiente experiencia trabajando juntos/as",
      long: "No trabajaste con esta persona en ningún grupo, o fue tan poco que no podés opinar con certeza. Tal vez te llevás bien o mal, pero no tuviste experiencia real trabajando juntos/as.",
    },
  };

  // Estado cargado desde los CSVs.
  let estudiante = null;
  let companeros = [];
  let preguntas = [];
  let opcionesPorNumero = {};         // { 1: [ {orden, texto}, ... ] }
  let flujoPorPreguntaYOrden = {};    // { "1|1": 2, "1|2": 3, ... }
  let preguntaPorNumero = {};

  // Estado persistido en localStorage:
  // {
  //   step: "instrucciones" | "afinidad" | "adicionales" | "finalizado",
  //   indiceCompanero: 0,
  //   indiceAdicional: 0,
  //   afinidad: { [codigoCompa]: { opcionOrden, sub: { [ordenSub]: true }, otroTexto } },
  //   adicionales: { [numeroPregunta]: [codigoCompa, ...] }
  // }
  let estado = U.lsGet(STATE_KEY, null) || {
    step: "instrucciones",
    indiceCompanero: 0,
    indiceAdicional: 0,
    afinidad: {},
    adicionales: {},
  };

  function persist() { U.lsSet(STATE_KEY, estado); }

  // Si el alumno ya envió las respuestas pero el submit quedó en cola
  // (offline), mostramos directamente el panel de pendiente y NO arrancamos
  // de cero el cuestionario. Las funciones que se usan acá están hoisteadas
  // (declaraciones), pero accedemos a QUEUE_KEY que ya está definida arriba.
  const pendOnLoad = pendienteParaCodigo(codigo);
  if (pendOnLoad) {
    // Reconstruir lo mínimo que necesita header() / submit retry sin pasar
    // por init() (que requiere conexión).
    if (pendOnLoad.payload && pendOnLoad.payload.estudiante) {
      estudiante = pendOnLoad.payload.estudiante;
    } else {
      estudiante = { codigo: pendOnLoad.codigo, nombre: pendOnLoad.nombre || pendOnLoad.codigo, clase: "" };
    }
    renderPendiente("Tus respuestas estaban pendientes de envío en este dispositivo.");
    flushQueue();
    programarReintento();
  } else {
    init().catch(err => {
      console.error(err);
      root.innerHTML = '<div class="panel-container"><p>Error cargando el cuestionario. Revisá la consola.</p></div>';
    });
  }

  async function init() {
    root.innerHTML = '<div class="panel-container"><p>Cargando…</p></div>';
    let r;
    try { r = await API.login(codigo); }
    catch (err) {
      console.error("login red:", err);
      root.innerHTML = '<div class="panel-container"><p class="cuestionario-error">No se pudo conectar con el servidor. Revisá tu conexión y reintentá.</p></div>';
      return;
    }
    if (!r || !r.ok) {
      const detalle = r && r.error ? ` <small>(${U.escapeHtml(r.error)})</small>` : "";
      root.innerHTML = `<div class="panel-container"><p>Estudiante no encontrado.${detalle} <a href="./index.html">Volver al inicio</a>.</p></div>`;
      return;
    }
    if (!Array.isArray(r.preguntas) || !r.preguntas.length || !Array.isArray(r.opciones)) {
      console.error("login: faltan datos del cuestionario", r);
      root.innerHTML = '<div class="panel-container"><p class="cuestionario-error">No se pudo cargar la configuración del cuestionario. Avisale al docente.</p></div>';
      return;
    }
    estudiante = r.estudiante;
    companeros = Array.isArray(r.companeros) ? r.companeros : [];
    preguntas  = r.preguntas;

    preguntas.forEach(p => preguntaPorNumero[p.numero] = p);
    r.opciones.forEach(op => {
      (opcionesPorNumero[op.numero_pregunta] = opcionesPorNumero[op.numero_pregunta] || []).push(op);
    });
    (r.flujos || []).forEach(f => {
      flujoPorPreguntaYOrden[`${f.numero_pregunta}|${f.opcion_orden}`] = f.siguiente_pregunta;
    });

    render();
  }

  function header() {
    return el("div", { class: "panel-estudiante-title" }, [
      `Estudiante: ${estudiante.nombre}`,
      el("span", { class: "clase" }, "Clase: " + (estudiante.clase || "—")),
    ]);
  }

  function render() {
    root.innerHTML = "";
    root.appendChild(header());
    if (estado.step === "instrucciones") return renderInstrucciones();
    if (estado.step === "afinidad")      return renderAfinidad();
    if (estado.step === "adicionales")   return renderAdicionales();
    if (estado.step === "finalizado")    return renderFinalizado();
  }

  // ---------- Pantalla 1: instrucciones ----------
  function renderInstrucciones() {
    const cont = el("div", { class: "panel-container" });
    cont.innerHTML = `
      <h2 class="panel-form-title">Introducción</h2>
      <div class="cuest-intro">
        <p class="mb-12">En esta encuesta vas a compartir cómo es trabajar con tus compañeros/as en actividades de clase.</p>
        <p class="mb-12">🎯 El objetivo es armar grupos donde todos puedan participar, aprender y sentirse cómodos.</p>
        <p class="mb-12">🔒 Tus respuestas son confidenciales y solo serán utilizadas por el equipo docente.</p>
        <p class="mb-12">⚠️ <b>Importante:</b> no estamos evaluando si te llevás bien o mal con alguien, sino cómo funciona el trabajo en grupo.</p>

        <h3 class="cuest-intro-title">Cómo completar la encuesta</h3>
        <p class="mb-12">🧠 Elegí una opción por cada compañero/a según cómo fue trabajar juntos/as en actividades reales. <b>No hay respuestas correctas o incorrectas.</b> Tus respuestas nos ayudan a pensar grupos más justos, cómodos y donde todos y todas puedan participar mejor.</p>
        <p class="mb-12">✅ Usá estos colores y leé bien lo que significa cada uno:</p>

        <div class="cuest-color cuest-color-verde">
          <div class="cuest-color-head">🟩 <b>VERDE</b> – Se trabaja muy bien con este/a compañero/a</div>
          <div>👉 Esta persona participa, escucha, propone ideas, cumple con las tareas, ayuda a otros y respeta los tiempos y espacios del grupo. Con ella el trabajo fluye, se avanza y es más fácil ponerse de acuerdo. Te sentís cómodo/a, incluido/a y hay respeto.</div>
        </div>
        <div class="cuest-color cuest-color-amarillo">
          <div class="cuest-color-head">🟨 <b>AMARILLO</b> – A veces se trabaja bien, otras no</div>
          <div>👉 Hay días o tareas en las que trabajar con esta persona funciona bien, pero otras veces se distrae, interrumpe o no cumple. Tal vez se pone las pilas si el grupo lo motiva, pero también puede hablar más de lo que trabaja, o dejar las cosas a medias. A veces te resulta fácil, otras veces, frustrante.</div>
        </div>
        <div class="cuest-color cuest-color-rojo">
          <div class="cuest-color-head">🟥 <b>ROJO</b> – Me resulta muy difícil trabajar con este/a compañero/a</div>
          <div>👉 Esta persona interrumpe, se queja sin ayudar, no cumple con las tareas, o incluso maltrata, critica sin aportar o ignora al grupo. Puede generar conflictos, desconcentración o tensión. Sentís que trabajar con ella te hace más difícil aprender o avanzar.</div>
        </div>
        <div class="cuest-color cuest-color-blanco">
          <div class="cuest-color-head">⚪ <b>BLANCO</b> – No tengo suficiente experiencia trabajando juntos/as</div>
          <div>👉 No trabajaste con esta persona en ningún grupo, o fue tan poco que no podés opinar con certeza. Tal vez te llevás bien o mal, pero no tuviste experiencia real trabajando juntos/as.</div>
        </div>

        <hr style="margin:18px 0" />
        <div class="text-center">
          <button class="btn" id="btn-comenzar">Comenzar</button>
        </div>
      </div>`;
    root.appendChild(cont);
    $("#btn-comenzar").addEventListener("click", () => {
      estado.step = "afinidad";
      persist(); render();
    });
  }

  // ---------- Pantalla 2: afinidad por compañero ----------
  function preguntasAfinidad() {
    return preguntas.filter(p => p.tipo === "AFINIDAD");
  }

  function renderAfinidad() {
    const preg = preguntasAfinidad()[0];
    if (!preg || !companeros.length) {
      estado.step = "adicionales";
      estado.indiceAdicional = 0;
      persist(); return render();
    }
    if (estado.indiceCompanero >= companeros.length) {
      estado.step = "adicionales";
      estado.indiceAdicional = 0;
      persist(); return render();
    }

    const compa = companeros[estado.indiceCompanero];
    const ops = opcionesPorNumero[preg.numero] || [];
    const dato = estado.afinidad[compa.codigo] || { opcionOrden: null, sub: {}, otroTexto: "" };

    const cont = el("div", { class: "panel-container" });
    cont.appendChild(progressBar(estado.indiceCompanero, companeros.length));
    // Soportamos {nombre} como placeholder en el texto de la pregunta para
    // que se pueda escribir "¿Cómo es trabajar con {nombre}?" en preguntas.csv.
    const tieneNombre = /\{nombre\}/i.test(preg.texto);
    const tituloFinal = preg.texto.replace(/\{nombre\}/gi, compa.nombre);
    cont.appendChild(el("p", { class: "cuestionario-pregunta-texto" }, tituloFinal));

    const centro = el("div", { class: "cuestionario-centro" });
    if (!tieneNombre) {
      centro.appendChild(el("div", { class: "cuestionario-nombre-estudiante" }, compa.nombre));
    }

    const selectorWrap = el("div", { class: "afi-cards" });
    ops.forEach(op => {
      const c = U.colorOpcionAfinidad(op.texto);
      const desc = AFINIDAD_DESC[c.key] || { short: op.texto, long: "" };
      const seleccionada = op.orden === dato.opcionOrden;
      const card = el("button", {
        type: "button",
        class: `afi-card afi-card-${c.key || "neutro"}` + (seleccionada ? " selected" : ""),
        "aria-pressed": seleccionada ? "true" : "false",
      });
      card.innerHTML = `
        <div class="afi-head">
          <span class="afi-icon">${c.icon}</span>
          <span class="afi-label">${U.escapeHtml(op.texto.toUpperCase())}</span>
          <span class="afi-short">${U.escapeHtml(desc.short)}</span>
          <span class="afi-check">✓</span>
        </div>
        ${desc.long ? `<div class="afi-desc">${desc.long}</div>` : ""}
      `;
      card.addEventListener("click", () => {
        dato.opcionOrden = op.orden;
        dato.sub = {};
        dato.otroTexto = "";
        estado.afinidad[compa.codigo] = dato;
        persist(); render();
      });
      selectorWrap.appendChild(card);
    });
    centro.appendChild(selectorWrap);

    // Sub-pregunta según flujo
    const siguiente = dato.opcionOrden
      ? flujoPorPreguntaYOrden[`${preg.numero}|${dato.opcionOrden}`]
      : null;
    if (siguiente) {
      const pSub = preguntaPorNumero[siguiente];
      if (pSub) {
        const subOps = opcionesPorNumero[pSub.numero] || [];
        const subWrap = el("div", { class: "cuestionario-pregunta-extra" }, pSub.texto);
        const ul = el("div", { class: "cuestionario-opciones-extra" });
        subOps.forEach(op => {
          const item = el("div", { class: "cuestionario-opcion-item" });
          const lbl = el("label", { class: "cuestionario-opcion-label" });
          const cb = el("input", { type: "checkbox", class: "cuestionario-checkbox" });
          cb.checked = !!dato.sub[op.orden];
          cb.addEventListener("change", () => {
            if (cb.checked) dato.sub[op.orden] = true;
            else delete dato.sub[op.orden];
            estado.afinidad[compa.codigo] = dato;
            persist(); render();
          });
          lbl.appendChild(cb);
          lbl.appendChild(document.createTextNode(" " + op.texto));
          item.appendChild(lbl);
          if (/otro motivo/i.test(op.texto) && dato.sub[op.orden]) {
            const inp = el("input", {
              type: "text",
              placeholder: "Especificá el motivo…",
              class: "cuestionario-otro-motivo",
              value: dato.otroTexto || "",
            });
            inp.addEventListener("input", () => {
              dato.otroTexto = inp.value;
              estado.afinidad[compa.codigo] = dato;
              persist();
            });
            item.appendChild(inp);
          }
          ul.appendChild(item);
        });
        subWrap.appendChild(ul);
        centro.appendChild(subWrap);
      }
    }

    const error = el("div", { id: "err", class: "cuestionario-error hidden" });
    centro.appendChild(error);

    const navBtns = el("div", { class: "flex-row", style: "justify-content:center" });
    if (estado.indiceCompanero > 0) {
      navBtns.appendChild(el("button", {
        class: "btn btn-gray",
        onclick: () => { estado.indiceCompanero--; persist(); render(); },
      }, "Atrás"));
    }
    const ultimo = estado.indiceCompanero >= companeros.length - 1;
    navBtns.appendChild(el("button", {
      class: "btn",
      onclick: () => avanzarAfinidad(error, ultimo),
    }, ultimo ? "Continuar" : "Siguiente"));
    centro.appendChild(navBtns);
    centro.appendChild(el("div", { class: "cuestionario-contador" },
      `${estado.indiceCompanero + 1} de ${companeros.length}`));

    cont.appendChild(centro);
    root.appendChild(cont);
  }

  function avanzarAfinidad(errEl, ultimo) {
    const compa = companeros[estado.indiceCompanero];
    const dato = estado.afinidad[compa.codigo];
    if (!dato || !dato.opcionOrden) {
      errEl.textContent = "Tenés que seleccionar una opción.";
      errEl.classList.remove("hidden");
      return;
    }
    const preg = preguntasAfinidad()[0];
    const opsAfi = opcionesPorNumero[preg.numero] || [];
    const opElegida = opsAfi.find(o => o.orden === dato.opcionOrden);
    const colorElegido = opElegida ? U.colorOpcionAfinidad(opElegida.texto).key : "";
    const siguiente = flujoPorPreguntaYOrden[`${preg.numero}|${dato.opcionOrden}`];
    if (siguiente) {
      const pSub = preguntaPorNumero[siguiente];
      const subOps = opcionesPorNumero[pSub.numero] || [];
      const algunaMarcada = subOps.some(o => dato.sub[o.orden]);
      // Para verde / amarillo / rojo es obligatorio marcar al menos un motivo.
      // El blanco se puede pasar sin marcar nada (acabás de decir que no hay
      // experiencia suficiente para opinar).
      if (!algunaMarcada && colorElegido !== "blanco") {
        errEl.textContent = "Marcá al menos una opción para poder continuar.";
        errEl.classList.remove("hidden");
        return;
      }
      const otraMarcada = subOps.find(o => /otro motivo/i.test(o.texto) && dato.sub[o.orden]);
      if (otraMarcada && !(dato.otroTexto || "").trim()) {
        errEl.textContent = "Especificá el motivo si seleccionaste 'Otro motivo'.";
        errEl.classList.remove("hidden");
        return;
      }
    }
    if (ultimo) {
      estado.step = "adicionales";
      estado.indiceAdicional = 0;
    } else {
      estado.indiceCompanero++;
    }
    persist(); render();
  }

  // ---------- Pantalla 3: preguntas adicionales (SELECCION_COMPANEROS) ----------
  function preguntasAdicionales() {
    return preguntas.filter(p =>
      p.tipo === "SELECCION_COMPANEROS" ||
      p.tipo === "SI_NO"
    );
  }

  // ¿Esta pregunta debería saltarse según el meta `requiere=N=valor`?
  function debeSaltar(preg) {
    const meta = parseMeta(preg.meta);
    if (!meta.requiere) return false;
    const partes = meta.requiere.split("=");
    if (partes.length < 2) return false;
    const numRef = parseInt(partes[0], 10);
    const esperado = (partes[1] || "").trim().toLowerCase();
    const respuesta = String((estado.siNo || {})[numRef] || "").trim().toLowerCase();
    return respuesta !== esperado;
  }

  // Navegación con salto bidireccional sobre preguntas condicionales.
  function avanzarIndice(arr, delta) {
    const partida = estado.indiceAdicional;
    let idx = partida + delta;
    const saltadas = [];
    while (idx >= 0 && idx < arr.length && debeSaltar(arr[idx])) {
      saltadas.push(arr[idx].numero);
      idx += delta;
    }
    estado.indiceAdicional = idx;
    if (saltadas.length) {
      console.debug(`[cuestionario] desde índice ${partida} → ${idx}; saltadas (preg.numero): ${saltadas.join(", ")} · siNo:`, estado.siNo);
    }
  }
  function irAtras(arr) {
    avanzarIndice(arr, -1);
    if (estado.indiceAdicional < 0) {
      // Volvemos al último compañero del paso de afinidad.
      estado.indiceAdicional = 0;
      estado.step = "afinidad";
      estado.indiceCompanero = Math.max(0, companeros.length - 1);
    }
    persist(); render();
  }
  function irAdelante(arr) {
    avanzarIndice(arr, 1);
    persist(); render();
  }

  function renderAdicionales() {
    const arr = preguntasAdicionales();
    if (!arr.length) return submitAll();
    // Saltar preguntas condicionales que no aplican.
    while (estado.indiceAdicional < arr.length && debeSaltar(arr[estado.indiceAdicional])) {
      estado.indiceAdicional++;
    }
    if (estado.indiceAdicional >= arr.length) return submitAll();

    const preg = arr[estado.indiceAdicional];
    if (preg.tipo === "SI_NO") return renderAdicionalSiNo(preg, arr);

    const seleccionados = estado.adicionales[preg.numero] || [];
    estado.bloqueantes = estado.bloqueantes || {};
    const bloqueantesActivas = estado.bloqueantes[preg.numero] || [];

    // Meta de la pregunta (max=N, desde=N, etc.)
    const meta = parseMeta(preg.meta);
    const maxN = parseInt(meta.max, 10) || 0;
    const desdePreg = parseInt(meta.desde, 10) || 0;
    // Si hay desde=N, mostramos sólo los compañeros que el alumno seleccionó
    // en la pregunta N (ej: Q7 elige uno solo de los marcados en Q6).
    const desdeCods = desdePreg ? new Set(estado.adicionales[desdePreg] || []) : null;
    const companerosFiltrados = desdeCods
      ? companeros.filter(c => desdeCods.has(c.codigo))
      : companeros;

    // Opciones de la pregunta marcadas como bloqueantes (texto con prefijo
    // "[BLOQ]" en data/opciones.csv).
    const opcionesPreg = (opcionesPorNumero[preg.numero] || []);
    const bloqueantes = opcionesPreg.filter(o => /^\[BLOQ\]/i.test(o.texto)).map(o => ({
      orden: o.orden,
      texto: o.texto.replace(/^\[BLOQ\]\s*/i, ""),
    }));
    const hayBloqueante = bloqueantesActivas.length > 0;

    const cont = el("div", { class: "panel-container" });
    cont.appendChild(progressBar(estado.indiceAdicional, arr.length));
    cont.appendChild(el("div", { class: "cuestionario-pregunta-titulo" }, preg.texto));

    const wrap = el("div", { class: "cuestionario-estudiantes-lista" });
    let ayuda;
    if (desdePreg && maxN === 1) ayuda = "Elegí uno (o tildá la opción “Me da igual” si no podés decidir).";
    else if (maxN) ayuda = `Podés elegir hasta ${maxN} compañero(s).`;
    else ayuda = "Seleccioná a los compañeros que cumplen con esto (podés elegir varios o ninguno).";
    wrap.appendChild(el("p", { class: "muted mb-12" }, ayuda));

    const errEl = el("div", { class: "cuestionario-error hidden", id: "ad-err" });
    wrap.appendChild(errEl);

    function setError(msg) { errEl.textContent = msg; errEl.classList.remove("hidden"); }
    function clearError() { errEl.classList.add("hidden"); errEl.textContent = ""; }

    function refrescar() { render(); }

    function setBloqueante(orden, on) {
      const cur = new Set(estado.bloqueantes[preg.numero] || []);
      if (on) {
        // Las bloqueantes son mutuamente exclusivas + limpian las selecciones.
        cur.clear(); cur.add(orden);
        estado.adicionales[preg.numero] = [];
      } else {
        cur.delete(orden);
      }
      estado.bloqueantes[preg.numero] = Array.from(cur);
      persist(); refrescar();
    }

    function setPeer(codigo, on) {
      let cur = estado.adicionales[preg.numero] || [];
      if (on) {
        if (maxN && cur.length >= maxN) {
          setError(`Ya seleccionaste ${maxN}. Quitá uno antes de agregar otro.`);
          return false;
        }
        cur = Array.from(new Set([...cur, codigo]));
        // Tildar un compañero limpia las bloqueantes activas.
        if (estado.bloqueantes[preg.numero] && estado.bloqueantes[preg.numero].length) {
          estado.bloqueantes[preg.numero] = [];
        }
        clearError();
      } else {
        cur = cur.filter(x => x !== codigo);
      }
      estado.adicionales[preg.numero] = cur;
      persist(); refrescar();
      return true;
    }

    // 1. Bloque de opciones bloqueantes (si las hay).
    if (bloqueantes.length) {
      const blk = el("div", { class: "cuestionario-bloqueantes" });
      bloqueantes.forEach(b => {
        const item = el("div", { class: "cuestionario-estudiante-item" });
        const cb = el("input", {
          type: "checkbox",
          class: "cuestionario-estudiante-checkbox",
          id: "bloq-" + b.orden,
        });
        cb.checked = bloqueantesActivas.includes(b.orden);
        cb.addEventListener("change", () => setBloqueante(b.orden, cb.checked));
        const lbl = el("label", {
          for: "bloq-" + b.orden,
          class: "cuestionario-estudiante-label",
        }, b.texto);
        item.appendChild(cb); item.appendChild(lbl);
        blk.appendChild(item);
      });
      wrap.appendChild(blk);
    }

    // 2. Lista de compañeros (deshabilitada si hay bloqueante activa).
    const list = el("div", { class: "cuestionario-estudiantes-container" + (hayBloqueante ? " disabled" : "") });
    if (!companerosFiltrados.length) {
      const msg = desdePreg
        ? "No marcaste ningún compañero en la pregunta anterior; tildá “Me da igual” para continuar."
        : "No hay compañeros para evaluar.";
      list.appendChild(el("p", { class: "muted" }, msg));
    } else {
      companerosFiltrados.forEach(c => {
        const item = el("div", { class: "cuestionario-estudiante-item" });
        const cb = el("input", {
          type: maxN === 1 ? "radio" : "checkbox",
          class: "cuestionario-estudiante-checkbox",
          name: "ad-" + preg.numero,
          id: "ad-" + c.codigo,
        });
        cb.checked = seleccionados.includes(c.codigo);
        cb.disabled = hayBloqueante;
        cb.addEventListener("change", () => {
          if (maxN === 1) {
            // Radio: limpiar y setear este.
            estado.adicionales[preg.numero] = [];
            const ok = setPeer(c.codigo, true);
            if (!ok) cb.checked = false;
          } else if (!setPeer(c.codigo, cb.checked)) cb.checked = !cb.checked;
        });
        const lbl = el("label", {
          for: "ad-" + c.codigo,
          class: "cuestionario-estudiante-label",
        }, c.nombre);
        item.appendChild(cb); item.appendChild(lbl);
        list.appendChild(item);
      });
    }
    wrap.appendChild(list);
    cont.appendChild(wrap);

    const navBtns = el("div", { class: "flex-row mt-16", style: "justify-content:center" });
    navBtns.appendChild(el("button", {
      class: "btn btn-gray",
      onclick: () => irAtras(arr),
    }, "Atrás"));
    const esUltima = estado.indiceAdicional >= arr.length - 1;
    navBtns.appendChild(el("button", {
      class: "btn",
      onclick: () => {
        // Toda SELECCION_COMPANEROS es obligatoria: debe haber al menos un
        // compañero seleccionado o una opción bloqueante (ej. "Ninguno").
        const cods = estado.adicionales[preg.numero] || [];
        const blo = (estado.bloqueantes && estado.bloqueantes[preg.numero]) || [];
        if (!cods.length && !blo.length) {
          const tieneNinguno = bloqueantes.length > 0;
          const msg = tieneNinguno
            ? 'Tenés que elegir al menos un compañero o tildar "Ninguno" para seguir.'
            : "Tenés que elegir al menos una opción para seguir.";
          setError(msg);
          return;
        }
        clearError();
        if (esUltima) confirmarFinalizar();
        else irAdelante(arr);
      },
    }, esUltima ? "Finalizar y enviar" : "Siguiente"));
    cont.appendChild(navBtns);
    cont.appendChild(el("div", { class: "cuestionario-contador text-center" },
      `Pregunta ${estado.indiceAdicional + 1} de ${arr.length}`));

    root.appendChild(cont);
  }

  // Parsea cosas como "max=3" o "max=3;extra=foo" del campo meta de preguntas.csv.
  function parseMeta(m) {
    const out = {};
    if (!m) return out;
    String(m).split(";").forEach(p => {
      const [k, v] = p.split("=").map(s => (s || "").trim());
      if (k) out[k] = (v == null ? "" : v);
    });
    return out;
  }

  // ---------- Pregunta tipo SI_NO ----------
  function renderAdicionalSiNo(preg, arr) {
    estado.siNo = estado.siNo || {};
    const valor = estado.siNo[preg.numero] || "";
    const cont = el("div", { class: "panel-container" });
    cont.appendChild(progressBar(estado.indiceAdicional, arr.length));
    cont.appendChild(el("div", { class: "cuestionario-pregunta-titulo" }, preg.texto));

    const errEl = el("div", { class: "cuestionario-error hidden text-center" });
    cont.appendChild(errEl);

    const opciones = (opcionesPorNumero[preg.numero] || []).slice().sort((a,b) => a.orden - b.orden);
    const wrap = el("div", { class: "cuest-sino-wrap" });
    opciones.forEach(op => {
      const seleccionada = valor === op.texto;
      const btn = el("button", {
        class: "cuest-sino-btn" + (seleccionada ? " selected" : ""),
      }, op.texto);
      btn.addEventListener("click", () => {
        estado.siNo[preg.numero] = op.texto;
        persist(); render();
      });
      wrap.appendChild(btn);
    });
    cont.appendChild(wrap);

    const navBtns = el("div", { class: "flex-row mt-16", style: "justify-content:center" });
    navBtns.appendChild(el("button", {
      class: "btn btn-gray",
      onclick: () => irAtras(arr),
    }, "Atrás"));
    const esUltima = estado.indiceAdicional >= arr.length - 1;
    navBtns.appendChild(el("button", {
      class: "btn",
      onclick: () => {
        if (!estado.siNo[preg.numero]) {
          errEl.textContent = "Tenés que elegir Sí o No.";
          errEl.classList.remove("hidden");
          return;
        }
        if (esUltima) confirmarFinalizar();
        else irAdelante(arr);
      },
    }, esUltima ? "Finalizar y enviar" : "Siguiente"));
    cont.appendChild(navBtns);
    cont.appendChild(el("div", { class: "cuestionario-contador text-center" },
      `Pregunta ${estado.indiceAdicional + 1} de ${arr.length}`));
    root.appendChild(cont);
  }

  function progressBar(i, n) {
    const pct = Math.round((i / Math.max(1, n)) * 100);
    const bar = el("div", { class: "progress-bar" });
    bar.appendChild(el("span", { style: `width:${pct}%` }));
    return bar;
  }

  function confirmarFinalizar() {
    if (!confirm("Una vez enviado no vas a poder modificar tus respuestas. ¿Continuar?")) return;
    submitAll();
  }

  // ---------- Submit al Apps Script ----------
  async function submitAll() {
    root.innerHTML = "";
    root.appendChild(header());
    root.appendChild(el("div", { class: "panel-container text-center" },
      el("p", null, "Enviando respuestas…")));

    const respuestas = [];
    const pregAfi = preguntasAfinidad()[0];
    const companerosPorCodigo = {};
    companeros.forEach(c => companerosPorCodigo[c.codigo] = c);

    // Afinidad + sub-preguntas
    if (pregAfi) {
      const opsAfi = opcionesPorNumero[pregAfi.numero] || [];
      Object.entries(estado.afinidad || {}).forEach(([compaCod, d]) => {
        if (!d || !d.opcionOrden) return;
        const op = opsAfi.find(o => o.orden === d.opcionOrden);
        if (!op) return;
        const compa = companerosPorCodigo[compaCod];
        if (!compa) return;
        respuestas.push({
          numero_pregunta: pregAfi.numero,
          texto_pregunta: pregAfi.texto,
          evaluado_codigo: compa.codigo,
          evaluado_nombre: compa.nombre,
          opcion_texto: op.texto,
          otro_texto: "",
        });
        const siguiente = flujoPorPreguntaYOrden[`${pregAfi.numero}|${d.opcionOrden}`];
        if (!siguiente) return;
        const pSub = preguntaPorNumero[siguiente];
        if (!pSub) return;
        const subOps = opcionesPorNumero[pSub.numero] || [];
        Object.keys(d.sub || {}).forEach(ordenStr => {
          if (!d.sub[ordenStr]) return;
          const op2 = subOps.find(o => String(o.orden) === String(ordenStr));
          if (!op2) return;
          let otroTxt = "";
          if (/otro motivo/i.test(op2.texto)) {
            otroTxt = (d.otroTexto || "").trim();
            if (!otroTxt) return;
          }
          respuestas.push({
            numero_pregunta: pSub.numero,
            texto_pregunta: pSub.texto,
            evaluado_codigo: compa.codigo,
            evaluado_nombre: compa.nombre,
            opcion_texto: op2.texto,
            otro_texto: otroTxt,
          });
        });
      });
    }

    // Adicionales (SELECCION_COMPANEROS)
    Object.entries(estado.adicionales || {}).forEach(([numStr, cods]) => {
      const preg = preguntaPorNumero[parseInt(numStr, 10)];
      if (!preg) return;
      (cods || []).forEach(compaCod => {
        const compa = companerosPorCodigo[compaCod];
        if (!compa) return;
        respuestas.push({
          numero_pregunta: preg.numero,
          texto_pregunta: preg.texto,
          evaluado_codigo: compa.codigo,
          evaluado_nombre: compa.nombre,
          opcion_texto: "",
          otro_texto: "",
        });
      });
    });

    // Bloqueantes (opciones tipo "Ninguno/a en particular" en SELECCION_COMPANEROS).
    // Se guardan como filas sin evaluado, con la opción en opcion_texto.
    Object.entries(estado.bloqueantes || {}).forEach(([numStr, ordenes]) => {
      const preg = preguntaPorNumero[parseInt(numStr, 10)];
      if (!preg) return;
      const opciones = opcionesPorNumero[preg.numero] || [];
      (ordenes || []).forEach(orden => {
        const op = opciones.find(o => o.orden === orden);
        if (!op) return;
        respuestas.push({
          numero_pregunta: preg.numero,
          texto_pregunta: preg.texto,
          evaluado_codigo: "",
          evaluado_nombre: "",
          opcion_texto: op.texto.replace(/^\[BLOQ\]\s*/i, ""),
          otro_texto: "",
        });
      });
    });

    // Respuestas SI_NO (Sí/No globales). Cada una se guarda como una fila con
    // opcion_texto = "Si" | "No" y sin evaluado.
    Object.entries(estado.siNo || {}).forEach(([numStr, valor]) => {
      const preg = preguntaPorNumero[parseInt(numStr, 10)];
      if (!preg || !valor) return;
      respuestas.push({
        numero_pregunta: preg.numero,
        texto_pregunta: preg.texto,
        evaluado_codigo: "",
        evaluado_nombre: "",
        opcion_texto: valor,
        otro_texto: "",
      });
    });

    try {
      const res = await API.submitRespuestas({ estudiante, respuestas });
      if (res && res.ok) {
        U.lsDel(STATE_KEY);
        estado.step = "finalizado";
        renderFinalizado();
        return;
      }
      // Errores del servidor: distinguimos los recuperables (que reintentamos
      // en background) de los terminales (que mostramos al alumno).
      const codigoErr = res && res.error;
      const recuperables = new Set(["lock_timeout", "server_error", "empty_body", "invalid_json", "respuesta_no_json"]);
      if (codigoErr && recuperables.has(codigoErr)) {
        encolarYMostrar({ estudiante, respuestas }, "El servidor está ocupado. Tus respuestas quedan en cola y se reintentan solas.");
        return;
      }
      const map = {
        ya_completado: "Este código ya envió sus respuestas.",
        codigo_invalido: "Código de estudiante inválido.",
        forbidden: "El token del front no coincide con el del Apps Script.",
        sin_respuestas: "No hay respuestas para enviar.",
      };
      const msg = map[codigoErr] || `No se pudieron guardar las respuestas (${codigoErr || "error desconocido"}).`;
      root.querySelector(".panel-container").innerHTML =
        `<p class="cuestionario-error">${U.escapeHtml(msg)}</p>
         <div class="text-center mt-16"><a class="btn" href="./index.html">Volver al inicio</a></div>`;
    } catch (err) {
      console.error("submitRespuestas red:", err);
      // Sin internet o el endpoint no responde → cola persistente.
      encolarYMostrar({ estudiante, respuestas }, "No hay conexión a internet. Tus respuestas quedaron guardadas en este dispositivo y se enviarán solas en cuanto vuelva la conexión.");
    }
  }

  // ---------- Cola persistente para envíos sin internet ----------
  // La cola vive en localStorage como un array de { codigo, payload, intentos,
  // primerError, lastError, encoladoEn }. Un único timer + el evento
  // window.online disparan flushQueue() en cuanto haya conexión.
  let flushTimer = null;
  let flushing = false;

  function getQueue() { return U.lsGet(QUEUE_KEY, []) || []; }
  function setQueue(q) { U.lsSet(QUEUE_KEY, q); }
  function pendienteParaCodigo(cod) { return getQueue().find(it => it.codigo === cod); }

  function encolarYMostrar(payload, mensaje) {
    const q = getQueue();
    // Evitar duplicados para el mismo código.
    const existente = q.findIndex(it => it.codigo === payload.estudiante.codigo);
    const item = {
      codigo: payload.estudiante.codigo,
      nombre: payload.estudiante.nombre,
      payload,
      intentos: 0,
      lastError: "",
      encoladoEn: new Date().toISOString(),
    };
    if (existente >= 0) q[existente] = Object.assign({}, q[existente], item);
    else q.push(item);
    setQueue(q);
    U.lsDel(STATE_KEY);
    estado.step = "pendiente";
    renderPendiente(mensaje);
    programarReintento();
    flushQueue(); // intento inmediato
  }

  function programarReintento() {
    if (flushTimer) return;
    if (!getQueue().length) return;
    flushTimer = setInterval(() => {
      if (!getQueue().length) {
        clearInterval(flushTimer); flushTimer = null;
        return;
      }
      flushQueue();
    }, 30000);
  }

  async function flushQueue() {
    if (flushing) return;
    flushing = true;
    try {
      let q = getQueue();
      if (!q.length) return;
      const restantes = [];
      for (const item of q) {
        try {
          const r = await API.submitRespuestas(item.payload);
          if (r && r.ok) continue;                 // enviado OK
          if (r && r.error === "ya_completado") continue; // backend ya tiene la respuesta
          // Errores no reintentables: los marcamos pero los sacamos para no quedar
          // pegados (codigo_invalido, forbidden, sin_respuestas).
          if (r && ["codigo_invalido", "forbidden", "sin_respuestas"].includes(r.error)) {
            console.warn(`[cola] descarto ${item.codigo}: ${r.error}`);
            continue;
          }
          item.intentos = (item.intentos || 0) + 1;
          item.lastError = (r && r.error) || "respuesta_invalida";
          restantes.push(item);
        } catch (err) {
          item.intentos = (item.intentos || 0) + 1;
          item.lastError = "red:" + (err.message || err);
          restantes.push(item);
        }
      }
      setQueue(restantes);
      // Si la cola del estudiante actual quedó vacía, pasamos a "finalizado".
      if (estado.step === "pendiente" && !pendienteParaCodigo(codigo)) {
        estado.step = "finalizado";
        renderFinalizado();
      } else if (estado.step === "pendiente") {
        // Re-renderizar el panel con la info actualizada.
        const it = pendienteParaCodigo(codigo);
        if (it) actualizarPanelPendiente(it);
      }
      if (!restantes.length && flushTimer) {
        clearInterval(flushTimer); flushTimer = null;
      }
    } finally {
      flushing = false;
    }
  }

  function renderPendiente(mensajePrincipal) {
    root.innerHTML = "";
    root.appendChild(header());
    const cont = el("div", { class: "panel-container cuestionario-finalizado" });
    cont.innerHTML = `
      <h2 class="cuestionario-titulo-finalizado">⏳ Respuestas pendientes</h2>
      <p class="mb-16">${U.escapeHtml(mensajePrincipal || "Tus respuestas están guardadas en este dispositivo.")}</p>
      <div class="cuest-pendiente-info" id="pend-info"></div>
      <p class="muted mt-16">Podés cerrar la página: cuando vuelva la conexión y abras el cuestionario de nuevo se reintenta automáticamente.</p>
      <div class="flex-row mt-16" style="gap:8px;justify-content:center">
        <button class="btn" id="btn-reintentar-ya">Reintentar ahora</button>
        <a class="btn btn-gray" href="./index.html">Volver al inicio</a>
      </div>`;
    root.appendChild(cont);
    cont.querySelector("#btn-reintentar-ya").addEventListener("click", async () => {
      const btn = cont.querySelector("#btn-reintentar-ya");
      btn.disabled = true; btn.textContent = "Enviando…";
      await flushQueue();
      btn.disabled = false; btn.textContent = "Reintentar ahora";
    });
    const it = pendienteParaCodigo(codigo);
    if (it) actualizarPanelPendiente(it);
  }

  function actualizarPanelPendiente(it) {
    const info = document.getElementById("pend-info");
    if (!info) return;
    const online = navigator.onLine;
    info.innerHTML = `
      <div class="cuest-pend-row"><span>Estado de la red</span><b style="color:${online ? "#2e7d32" : "#c62828"}">${online ? "✅ Online" : "❌ Sin conexión"}</b></div>
      <div class="cuest-pend-row"><span>Encolado</span><b>${new Date(it.encoladoEn).toLocaleString()}</b></div>
      <div class="cuest-pend-row"><span>Intentos</span><b>${it.intentos || 0}</b></div>
      ${it.lastError ? `<div class="cuest-pend-row"><span>Último error</span><b>${U.escapeHtml(it.lastError)}</b></div>` : ""}
    `;
  }

  function renderFinalizado() {
    root.innerHTML = "";
    root.appendChild(header());
    const cont = el("div", { class: "panel-container cuestionario-finalizado" });
    cont.innerHTML = `
      <h2 class="cuestionario-titulo-finalizado">¡Completaste el cuestionario!</h2>
      <p class="mb-16">Gracias por tu participación. Tus respuestas se enviaron correctamente.</p>
      <a class="btn" href="./index.html">Volver al inicio</a>`;
    root.appendChild(cont);
  }

  // Triggers de flush automáticos: cuando vuelve la conexión + un boot
  // diferido si hay algo en la cola al arrancar.
  window.addEventListener("online", () => { flushQueue(); programarReintento(); });
  if (getQueue().length) { setTimeout(flushQueue, 800); programarReintento(); }
})();
