// Cuestionario del estudiante (versión CSV + Google Apps Script).
//
// Flujo:
//   1. Login por código (contra data/estudiantes.csv) → compañeros de la misma clase.
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
  const root = $("#cuestionario-root");

  if (!codigo) {
    root.innerHTML = '<div class="panel-container"><p>Falta el código del estudiante. <a href="./index.html">Volver al inicio</a>.</p></div>';
    return;
  }

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

  init().catch(err => {
    console.error(err);
    root.innerHTML = '<div class="panel-container"><p>Error cargando el cuestionario. Revisá la consola.</p></div>';
  });

  async function init() {
    root.innerHTML = '<div class="panel-container"><p>Cargando…</p></div>';
    const r = await API.login(codigo);
    if (!r.ok) {
      root.innerHTML = '<div class="panel-container"><p>Estudiante no encontrado. <a href="./index.html">Volver al inicio</a>.</p></div>';
      return;
    }
    estudiante = r.estudiante;
    companeros = r.companeros;
    preguntas  = r.preguntas;

    preguntas.forEach(p => preguntaPorNumero[p.numero] = p);
    r.opciones.forEach(op => {
      (opcionesPorNumero[op.numero_pregunta] = opcionesPorNumero[op.numero_pregunta] || []).push(op);
    });
    r.flujos.forEach(f => {
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
    cont.appendChild(el("p", { class: "cuestionario-pregunta-texto" }, preg.texto));

    const centro = el("div", { class: "cuestionario-centro" });
    centro.appendChild(el("div", { class: "cuestionario-nombre-estudiante" }, compa.nombre));

    const selectorWrap = el("div", { class: "cuestionario-opciones-container" });
    const select = el("select", { class: "cuestionario-select" });
    select.appendChild(el("option", { value: "" }, "Seleccioná una opción"));
    ops.forEach(op => {
      const c = U.colorOpcionAfinidad(op.texto);
      const o = el("option", { value: String(op.orden), class: c.cls }, `${c.icon} ${op.texto}`);
      if (op.orden === dato.opcionOrden) o.selected = true;
      select.appendChild(o);
    });
    select.addEventListener("change", () => {
      dato.opcionOrden = select.value ? parseInt(select.value, 10) : null;
      dato.sub = {};
      dato.otroTexto = "";
      estado.afinidad[compa.codigo] = dato;
      persist(); render();
    });
    selectorWrap.appendChild(select);
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
    const siguiente = flujoPorPreguntaYOrden[`${preg.numero}|${dato.opcionOrden}`];
    if (siguiente) {
      const pSub = preguntaPorNumero[siguiente];
      const subOps = opcionesPorNumero[pSub.numero] || [];
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
    return preguntas.filter(p => p.tipo === "SELECCION_COMPANEROS");
  }

  function renderAdicionales() {
    const arr = preguntasAdicionales();
    if (!arr.length) return submitAll();
    if (estado.indiceAdicional >= arr.length) return submitAll();

    const preg = arr[estado.indiceAdicional];
    const seleccionados = estado.adicionales[preg.numero] || [];

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
          id: "ad-" + c.codigo,
        });
        cb.checked = seleccionados.includes(c.codigo);
        cb.addEventListener("change", () => {
          let cur = estado.adicionales[preg.numero] || [];
          if (cb.checked) cur = Array.from(new Set([...cur, c.codigo]));
          else cur = cur.filter(x => x !== c.codigo);
          estado.adicionales[preg.numero] = cur;
          persist();
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
    if (estado.indiceAdicional > 0) {
      navBtns.appendChild(el("button", {
        class: "btn btn-gray",
        onclick: () => { estado.indiceAdicional--; persist(); render(); },
      }, "Atrás"));
    } else {
      navBtns.appendChild(el("button", {
        class: "btn btn-gray",
        onclick: () => {
          estado.step = "afinidad";
          estado.indiceCompanero = Math.max(0, companeros.length - 1);
          persist(); render();
        },
      }, "Atrás"));
    }
    const esUltima = estado.indiceAdicional >= arr.length - 1;
    navBtns.appendChild(el("button", {
      class: "btn",
      onclick: () => {
        if (esUltima) confirmarFinalizar();
        else { estado.indiceAdicional++; persist(); render(); }
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

    try {
      const res = await API.submitRespuestas({ estudiante, respuestas });
      if (!res || !res.ok) {
        const map = {
          ya_completado: "Este código ya envió sus respuestas.",
          codigo_invalido: "Código de estudiante inválido.",
          forbidden: "El token del front no coincide con el del Apps Script.",
          sin_respuestas: "No hay respuestas para enviar.",
        };
        const msg = (res && map[res.error]) || "No se pudieron guardar las respuestas.";
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
})();
