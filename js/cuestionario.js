// Cuestionario del estudiante.
//
// Flujo:
//   1. Login por código → carga compañeros, cuestionario y preguntas
//   2. Pantalla de instrucciones
//   3. Pregunta de afinidad (1) por cada compañero, con sub-pregunta
//      (2/3/4 según verde/amarillo/rojo, ninguna para blanco)
//   4. Preguntas adicionales (5..10) seleccionando compañeros
//   5. Submit atómico vía RPC → bloquea al estudiante
//
// Las respuestas parciales se guardan en localStorage con la clave
// "cuest:" + codigo, así si el navegador se cierra el alumno retoma.

(function () {
  const codigo = U.getQueryParam("codigo");
  const $ = U.$, $$ = U.$$, el = U.el;
  const STATE_KEY = codigo ? `cuest:${codigo}` : null;

  const root = $("#cuestionario-root");

  if (!codigo) {
    root.innerHTML = '<div class="panel-container"><p>Falta el código del estudiante. <a href="./index.html">Volver al inicio</a>.</p></div>';
    return;
  }

  // ------- Estado en memoria -------
  let session = null;          // { estudiante, clase, cuestionario, companeros }
  let preguntas = [];          // todas las preguntas (1..10)
  let opciones = [];           // todas las opciones
  let opcionesPorPregunta = {};
  let preguntaPorNumero = {};

  // Estado del cuestionario (persistido en localStorage)
  // {
  //   step: "instrucciones" | "afinidad" | "adicionales" | "finalizado",
  //   indiceCompanero: 0,
  //   indiceAdicional: 0,
  //   afinidad: { [companeroId]: { opcionId, sub: { [opcionExtraId]: true }, otroTexto } },
  //   adicionales: { [preguntaId]: [companeroId, ...] }
  // }
  let estado = U.lsGet(STATE_KEY, null) || {
    step: "instrucciones",
    indiceCompanero: 0,
    indiceAdicional: 0,
    afinidad: {},
    adicionales: {}
  };

  function persist() { U.lsSet(STATE_KEY, estado); }

  // ------- Boot -------
  init().catch(err => {
    console.error(err);
    root.innerHTML = '<div class="panel-container"><p>Error cargando el cuestionario. Intentá de nuevo.</p></div>';
  });

  async function init() {
    root.innerHTML = '<div class="panel-container"><p>Cargando…</p></div>';
    const [loginRes, prRes] = await Promise.all([
      SB.rpc("login_estudiante", { p_codigo: codigo }),
      SB.loadPreguntas()
    ]);
    if (!loginRes || !loginRes.ok) {
      root.innerHTML = '<div class="panel-container"><p>Estudiante no encontrado o sin cuestionario asignado. <a href="./index.html">Volver al inicio</a>.</p></div>';
      return;
    }
    session = loginRes;
    preguntas = prRes.preguntas;
    opciones = prRes.opciones;

    preguntas.forEach(p => preguntaPorNumero[p.numero_pregunta] = p);
    opciones.forEach(op => {
      (opcionesPorPregunta[op.pregunta_id] = opcionesPorPregunta[op.pregunta_id] || []).push(op);
    });
    Object.values(opcionesPorPregunta).forEach(arr => arr.sort((a,b)=>(a.orden||0)-(b.orden||0)));

    if (session.estudiante.completado) {
      U.lsDel(STATE_KEY);
      renderFinalizado(true);
      return;
    }
    if (!session.cuestionario || session.cuestionario.estado !== "ACTIVA") {
      root.innerHTML = '<div class="panel-container"><p>El cuestionario está cerrado.</p></div>';
      return;
    }
    render();
  }

  // ------- Render principal -------
  function header() {
    return el("div", { class: "panel-estudiante-title" }, [
      `Estudiante: ${session.estudiante.nombre}`,
      el("span", { class: "clase" }, "Clase: " + (session.clase?.identificador || "—"))
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

  // ------- Pantalla 1: instrucciones -------
  function renderInstrucciones() {
    const cont = el("div", { class: "panel-container" }, []);
    cont.innerHTML = `
      <h2 class="panel-form-title">Instrucciones</h2>
      <div style="margin-top:12px;line-height:1.5">
        <p class="mb-12">✅ La información es confidencial y solo será leída por tu referente.</p>
        <p class="mb-12">🎯 El objetivo es armar grupos de trabajo donde todos se sientan cómodos, puedan colaborar, aprender y participar.</p>
        <p class="mb-12">✋ No estamos preguntando si te llevás bien o mal con alguien, ni si son amigos. Respondé según tu experiencia real al trabajar en grupo.</p>
        <h3 class="mb-12 mt-24">Cómo completar la encuesta</h3>
        <p class="mb-12">🟩 <b>VERDE</b> – Me gusta trabajar con esta persona</p>
        <p class="mb-12">🟨 <b>AMARILLO</b> – A veces sí, a veces no</p>
        <p class="mb-12">🟥 <b>ROJO</b> – Me resulta muy difícil trabajar con esta persona</p>
        <p class="mb-12">⚪ <b>BLANCO</b> – No tengo suficientes experiencias de trabajo con esta persona</p>
        <p class="mb-12">🧠 No hay respuestas correctas o incorrectas. Tus respuestas nos ayudan a pensar grupos más justos.</p>
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

  // ------- Pantalla 2: afinidad por compañero -------
  function renderAfinidad() {
    const companeros = session.companeros;
    if (!companeros.length) {
      // Saltear directamente a adicionales
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
    const preg1 = preguntaPorNumero[1];
    const ops1 = opcionesPorPregunta[preg1.id] || [];
    const datoCompa = estado.afinidad[compa.id] || { opcionId: "", sub: {}, otroTexto: "" };

    const cont = el("div", { class: "panel-container" });
    cont.appendChild(progressBar(estado.indiceCompanero, companeros.length));
    cont.appendChild(el("p", { class: "cuestionario-pregunta-texto" }, preg1.texto));

    const centro = el("div", { class: "cuestionario-centro" });
    centro.appendChild(el("div", { class: "cuestionario-nombre-estudiante" }, compa.nombre));

    const selectorWrap = el("div", { class: "cuestionario-opciones-container" });
    const select = el("select", { class: "cuestionario-select" });
    select.appendChild(el("option", { value: "" }, "Seleccioná una opción"));
    ops1.forEach(op => {
      const c = U.colorOpcionAfinidad(op.texto_opcion);
      const o = el("option", { value: op.id, class: c.cls }, `${c.icon} ${op.texto_opcion}`);
      if (op.id === datoCompa.opcionId) o.selected = true;
      select.appendChild(o);
    });
    select.addEventListener("change", () => {
      datoCompa.opcionId = select.value;
      datoCompa.sub = {};
      datoCompa.otroTexto = "";
      estado.afinidad[compa.id] = datoCompa;
      persist(); renderAfinidad();
    });
    selectorWrap.appendChild(select);
    centro.appendChild(selectorWrap);

    // Sub-pregunta según color
    const opSeleccionada = ops1.find(o => o.id === datoCompa.opcionId);
    let subNumero = null;
    if (opSeleccionada) {
      const c = U.colorOpcionAfinidad(opSeleccionada.texto_opcion).key;
      if (c === "verde")    subNumero = 2;
      if (c === "amarillo") subNumero = 3;
      if (c === "rojo")     subNumero = 4;
    }
    if (subNumero) {
      const pSub = preguntaPorNumero[subNumero];
      if (pSub) {
        const subOps = opcionesPorPregunta[pSub.id] || [];
        const subWrap = el("div", { class: "cuestionario-pregunta-extra" }, pSub.texto);
        const ul = el("div", { class: "cuestionario-opciones-extra" });
        subOps.forEach(op => {
          const item = el("div", { class: "cuestionario-opcion-item" });
          const lbl = el("label", { class: "cuestionario-opcion-label" });
          const cb = el("input", {
            type: "checkbox",
            class: "cuestionario-checkbox"
          });
          cb.checked = !!datoCompa.sub[op.id];
          cb.addEventListener("change", () => {
            if (cb.checked) datoCompa.sub[op.id] = true;
            else delete datoCompa.sub[op.id];
            estado.afinidad[compa.id] = datoCompa;
            persist();
            // re-render por si "Otro motivo" cambió
            renderAfinidad();
          });
          lbl.appendChild(cb);
          lbl.appendChild(document.createTextNode(" " + op.texto_opcion));
          item.appendChild(lbl);
          if (/otro motivo/i.test(op.texto_opcion) && datoCompa.sub[op.id]) {
            const inp = el("input", {
              type: "text",
              placeholder: "Especificá el motivo…",
              class: "cuestionario-otro-motivo",
              value: datoCompa.otroTexto || ""
            });
            inp.addEventListener("input", () => {
              datoCompa.otroTexto = inp.value;
              estado.afinidad[compa.id] = datoCompa;
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
      navBtns.appendChild(el("button", { class: "btn btn-gray", onclick: () => {
        estado.indiceCompanero--; persist(); render();
      }}, "Atrás"));
    }
    const ultimo = estado.indiceCompanero >= companeros.length - 1;
    navBtns.appendChild(el("button", { class: "btn", onclick: () => avanzarAfinidad(error, ultimo) },
      ultimo ? "Continuar" : "Siguiente"));
    centro.appendChild(navBtns);
    centro.appendChild(el("div", { class: "cuestionario-contador" },
      `${estado.indiceCompanero + 1} de ${companeros.length}`));

    cont.appendChild(centro);
    root.appendChild(cont);
  }

  function avanzarAfinidad(errEl, ultimo) {
    const compa = session.companeros[estado.indiceCompanero];
    const dato = estado.afinidad[compa.id];
    if (!dato || !dato.opcionId) {
      errEl.textContent = "Tenés que seleccionar una opción.";
      errEl.classList.remove("hidden");
      return;
    }
    // Validar sub-pregunta si tiene "Otro motivo" marcado sin texto
    const op1 = (opcionesPorPregunta[preguntaPorNumero[1].id] || []).find(o => o.id === dato.opcionId);
    const c = op1 ? U.colorOpcionAfinidad(op1.texto_opcion).key : "";
    let subNum = null;
    if (c === "verde") subNum = 2;
    if (c === "amarillo") subNum = 3;
    if (c === "rojo") subNum = 4;
    if (subNum) {
      const pSub = preguntaPorNumero[subNum];
      const subOps = opcionesPorPregunta[pSub.id] || [];
      const otraMarcada = subOps.find(o => /otro motivo/i.test(o.texto_opcion) && dato.sub[o.id]);
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

  // ------- Pantalla 3: preguntas adicionales (5..10) -------
  function preguntasAdicionales() {
    return preguntas
      .filter(p => p.numero_pregunta >= 5 && p.tipo_pregunta === "MULTIPLE_SELECCION")
      .sort((a,b) => a.numero_pregunta - b.numero_pregunta);
  }

  function renderAdicionales() {
    const arr = preguntasAdicionales();
    if (!arr.length) {
      // Si no hay preguntas adicionales, finalizamos directamente
      return submitAll();
    }
    if (estado.indiceAdicional >= arr.length) {
      return submitAll();
    }
    const preg = arr[estado.indiceAdicional];
    const seleccionados = estado.adicionales[preg.id] || [];
    const companeros = session.companeros;

    const cont = el("div", { class: "panel-container" });
    cont.appendChild(progressBar(estado.indiceAdicional, arr.length));
    cont.appendChild(el("div", { class: "cuestionario-pregunta-titulo" }, preg.texto));

    const wrap = el("div", { class: "cuestionario-estudiantes-lista" });
    wrap.appendChild(el("p", { class: "muted mb-12" },
      "Seleccioná a los compañeros que cumplen con esta característica (podés elegir varios o ninguno)."));
    const list = el("div", { class: "cuestionario-estudiantes-container" });
    if (!companeros.length) {
      list.appendChild(el("p", { class: "muted" }, "No hay compañeros para evaluar."));
    } else {
      companeros.forEach(c => {
        const item = el("div", { class: "cuestionario-estudiante-item" });
        const cb = el("input", {
          type: "checkbox",
          class: "cuestionario-estudiante-checkbox",
          id: "ad-" + c.id
        });
        cb.checked = seleccionados.includes(c.id);
        cb.addEventListener("change", () => {
          let cur = estado.adicionales[preg.id] || [];
          if (cb.checked) cur = Array.from(new Set([...cur, c.id]));
          else cur = cur.filter(id => id !== c.id);
          estado.adicionales[preg.id] = cur;
          persist();
        });
        const lbl = el("label", {
          for: "ad-" + c.id,
          class: "cuestionario-estudiante-label"
        }, c.nombre);
        item.appendChild(cb); item.appendChild(lbl);
        list.appendChild(item);
      });
    }
    wrap.appendChild(list);
    cont.appendChild(wrap);

    const navBtns = el("div", { class: "flex-row mt-16", style: "justify-content:center" });
    if (estado.indiceAdicional > 0) {
      navBtns.appendChild(el("button", { class: "btn btn-gray", onclick: () => {
        estado.indiceAdicional--; persist(); render();
      }}, "Atrás"));
    } else {
      navBtns.appendChild(el("button", { class: "btn btn-gray", onclick: () => {
        estado.step = "afinidad";
        estado.indiceCompanero = Math.max(0, session.companeros.length - 1);
        persist(); render();
      }}, "Atrás"));
    }
    const esUltima = estado.indiceAdicional >= arr.length - 1;
    navBtns.appendChild(el("button", { class: esUltima ? "btn" : "btn", onclick: () => {
      if (esUltima) confirmarFinalizar();
      else { estado.indiceAdicional++; persist(); render(); }
    }}, esUltima ? "Finalizar y enviar" : "Siguiente"));
    cont.appendChild(navBtns);
    cont.appendChild(el("div", { class: "cuestionario-contador text-center" },
      `Pregunta ${estado.indiceAdicional + 1} de ${arr.length}`));

    root.appendChild(cont);
  }

  function progressBar(i, n) {
    const pct = Math.round(((i) / Math.max(1, n)) * 100);
    const bar = el("div", { class: "progress-bar" });
    bar.appendChild(el("span", { style: `width:${pct}%` }));
    return bar;
  }

  function confirmarFinalizar() {
    if (!confirm("Una vez enviado no vas a poder modificar tus respuestas. ¿Continuar?")) return;
    submitAll();
  }

  // ------- Submit atómico -------
  async function submitAll() {
    root.innerHTML = "";
    root.appendChild(header());
    root.appendChild(el("div", { class: "panel-container text-center" },
      el("p", null, "Enviando respuestas…")));

    // Construir array de respuestas
    const respuestas = [];
    const preg1 = preguntaPorNumero[1];

    Object.entries(estado.afinidad || {}).forEach(([compaId, d]) => {
      if (!d || !d.opcionId) return;
      respuestas.push({
        pregunta_id: preg1.id,
        estudiante_evaluado_id: compaId,
        opcion_pregunta_id: d.opcionId,
        otro_texto: null
      });
      // sub-pregunta
      const op1 = (opcionesPorPregunta[preg1.id] || []).find(o => o.id === d.opcionId);
      if (!op1) return;
      const c = U.colorOpcionAfinidad(op1.texto_opcion).key;
      let subNum = null;
      if (c === "verde") subNum = 2;
      if (c === "amarillo") subNum = 3;
      if (c === "rojo") subNum = 4;
      if (!subNum) return;
      const pSub = preguntaPorNumero[subNum];
      if (!pSub) return;
      const subOps = opcionesPorPregunta[pSub.id] || [];
      Object.keys(d.sub || {}).forEach(opId => {
        if (!d.sub[opId]) return;
        const op = subOps.find(o => o.id === opId);
        if (!op) return;
        let otroTxt = null;
        if (/otro motivo/i.test(op.texto_opcion)) {
          otroTxt = (d.otroTexto || "").trim() || null;
          if (!otroTxt) return; // no guardamos "otro motivo" sin texto
        }
        respuestas.push({
          pregunta_id: pSub.id,
          estudiante_evaluado_id: compaId,
          opcion_pregunta_id: opId,
          otro_texto: otroTxt
        });
      });
    });

    Object.entries(estado.adicionales || {}).forEach(([pregId, ids]) => {
      (ids || []).forEach(compaId => {
        respuestas.push({
          pregunta_id: pregId,
          estudiante_evaluado_id: compaId,
          opcion_pregunta_id: null,
          otro_texto: null
        });
      });
    });

    try {
      const res = await SB.rpc("submit_respuestas", {
        p_codigo: codigo,
        p_respuestas: respuestas
      });
      if (!res || !res.ok) {
        const map = {
          ya_completado: "Este código ya envió sus respuestas.",
          cuestionario_cerrado: "El cuestionario ya está cerrado.",
          codigo_invalido: "Código de estudiante inválido.",
          sin_cuestionario: "No tenés cuestionario asignado."
        };
        const msg = map[res && res.error] || "No se pudieron guardar las respuestas.";
        root.querySelector(".panel-container").innerHTML =
          `<p class="cuestionario-error">${U.escapeHtml(msg)}</p>
           <div class="text-center mt-16"><a class="btn" href="./index.html">Volver al inicio</a></div>`;
        return;
      }
      U.lsDel(STATE_KEY);
      estado.step = "finalizado";
      renderFinalizado();
    } catch (err) {
      console.error(err);
      root.querySelector(".panel-container").innerHTML =
        `<p class="cuestionario-error">Hubo un error de conexión. Probá de nuevo en unos minutos.</p>
         <div class="text-center mt-16"><button class="btn" onclick="location.reload()">Reintentar</button></div>`;
    }
  }

  function renderFinalizado(yaEstaba) {
    root.innerHTML = "";
    root.appendChild(header());
    const cont = el("div", { class: "panel-container cuestionario-finalizado" });
    cont.innerHTML = yaEstaba
      ? `<h2 class="cuestionario-titulo-finalizado">Ya completaste este cuestionario</h2>
         <p class="mb-16">Tus respuestas fueron registradas el
           ${new Date(session.estudiante.completado_at).toLocaleString()}.</p>
         <a class="btn" href="./index.html">Volver al inicio</a>`
      : `<h2 class="cuestionario-titulo-finalizado">¡Completaste el cuestionario!</h2>
         <p class="mb-16">Gracias por tu participación. Tus respuestas se enviaron correctamente.</p>
         <a class="btn" href="./index.html">Volver al inicio</a>`;
    root.appendChild(cont);
  }
})();
