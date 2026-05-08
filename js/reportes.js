// Módulo de reportes.
//
// Toma estudiantes + respuestas + opciones del cuestionario y produce
// estadísticas agregadas para el dashboard:
//   - Tabla pregunta × opción (conteo y %)
//   - Rankings (más elegidos verde, aislados, recíprocas, conflictos)
//   - Ficha por alumno (nominaciones emitidas y recibidas, por color y por
//     pregunta)
//   - Reporte de grupos armados (afinidad interna y alertas) sobre los
//     `gruposLocal` que el docente tenga guardados/borrador.
//
// Todo el código asume el shape del Sheet (ver api.js / Apps Script):
//   respuesta: { codigo, nombre, clase, numero_pregunta, texto_pregunta,
//                evaluado_codigo, evaluado_nombre, opcion_texto, otro_texto }

(function () {
  const $ = U.$, el = U.el;

  // ---------- Cómputo ----------

  // Construye una matriz por par (i,j) con el color que i le asignó a j en
  // la pregunta 1, junto con métricas crudas por alumno (q5..q14). Es el
  // mismo modelo que usa groups.js, pero acá lo necesitamos para reportes.
  function calcularAnalytics(ests, respuestas) {
    const N = ests.length;
    const idx = {}; ests.forEach((e, i) => { idx[String(e.codigo).trim()] = i; });
    const colorPair = Array.from({ length: N }, () => new Array(N).fill(""));
    const recibidos = ests.map(() => ({
      verde: 0, amarillo: 0, rojo: 0, blanco: 0,
      q5: 0, q6: 0, q7: 0, q8: 0, q9: 0, q10: 0, q12: 0, q13: 0, q14: 0,
      total_positivo: 0, total_negativo: 0,
    }));
    const emitidos = ests.map(() => ({
      verde: [], amarillo: [], rojo: [], blanco: [],
      q5: [], q6: [], q7: [], q8: [], q9: [], q10: [], q12: [], q13: [], q14: [],
    }));

    (respuestas || []).forEach((r) => {
      const i = idx[String(r.codigo || "").trim()];
      const j = idx[String(r.evaluado_codigo || "").trim()];
      const q = Number(r.numero_pregunta);
      if (i == null || j == null || i === j) return;
      if (q === 1) {
        const c = U.colorOpcionAfinidad(r.opcion_texto).key;
        if (!c) return;
        colorPair[i][j] = c;
        recibidos[j][c] += 1;
        if (c === "verde" || c === "amarillo") recibidos[j].total_positivo += 1;
        else if (c === "rojo") recibidos[j].total_negativo += 1;
        emitidos[i][c].push(j);
      } else {
        const k = `q${q}`;
        if (recibidos[j][k] != null) {
          recibidos[j][k] += 1;
          if (q === 14 || q === 12 || q === 13) recibidos[j].total_negativo += 1;
          else recibidos[j].total_positivo += 1;
          emitidos[i][k].push(j);
        }
      }
    });

    return { idx, N, colorPair, recibidos, emitidos };
  }

  // ---------- Tabla pregunta × opción ----------

  function statsPreguntas(preguntas, opciones, respuestas) {
    const porPregunta = {};
    (preguntas || []).forEach((p) => {
      porPregunta[p.numero] = {
        numero: p.numero,
        texto: p.texto,
        tipo: p.tipo,
        opciones: (opciones || [])
          .filter((o) => o.numero_pregunta === p.numero)
          .map((o) => ({ texto: o.texto, count: 0 })),
        total: 0,
        otros: [],   // textos libres en "otro"
      };
    });
    (respuestas || []).forEach((r) => {
      const q = Number(r.numero_pregunta);
      const P = porPregunta[q];
      if (!P) return;
      P.total += 1;
      const t = (r.opcion_texto || "").trim();
      const op = P.opciones.find((o) => o.texto === t);
      if (op) op.count += 1;
      const otro = (r.otro_texto || "").trim();
      if (otro) P.otros.push(otro);
    });
    Object.values(porPregunta).forEach((P) => {
      P.opciones.forEach((o) => { o.pct = P.total ? Math.round((o.count / P.total) * 1000) / 10 : 0; });
    });
    return Object.values(porPregunta).sort((a, b) => a.numero - b.numero);
  }

  function renderTablaPreguntas(stats) {
    const wrap = el("div", { class: "rep-card" });
    wrap.innerHTML = `
      <div class="rep-card-head">
        <h4>Estadísticas por pregunta</h4>
        <div class="muted">Conteo y porcentaje de cada opción elegida</div>
      </div>
    `;
    if (!stats.length) {
      wrap.appendChild(el("p", { class: "muted" }, "Todavía no hay respuestas."));
      return wrap;
    }
    stats.forEach((P) => {
      const card = el("div", { class: "rep-pregunta" });
      const header = el("div", { class: "rep-pregunta-head" });
      header.innerHTML = `
        <div class="rep-pregunta-num">P${P.numero}</div>
        <div class="rep-pregunta-texto">
          <div class="rep-pregunta-titulo">${U.escapeHtml(P.texto)}</div>
          <div class="muted" style="font-size:0.85em">${P.total} respuesta(s)</div>
        </div>
      `;
      card.appendChild(header);
      if (P.opciones.length) {
        const tabla = el("table", { class: "rep-tabla" });
        tabla.innerHTML = `
          <thead>
            <tr><th>Opción</th><th class="num">Cantidad</th><th class="num">%</th><th>Distribución</th></tr>
          </thead>
          <tbody>
            ${P.opciones.map((o) => `
              <tr>
                <td>${badgeOpcion(o.texto)}</td>
                <td class="num">${o.count}</td>
                <td class="num">${o.pct}%</td>
                <td><div class="rep-bar"><div class="rep-bar-fill" style="width:${o.pct}%"></div></div></td>
              </tr>
            `).join("")}
          </tbody>
        `;
        card.appendChild(tabla);
      }
      if (P.otros.length) {
        const det = el("details", { class: "rep-otros" });
        det.innerHTML = `<summary>${P.otros.length} respuesta(s) con texto libre</summary>` +
          `<ul>${P.otros.slice(0, 200).map((t) => `<li>${U.escapeHtml(t)}</li>`).join("")}</ul>`;
        card.appendChild(det);
      }
      wrap.appendChild(card);
    });
    return wrap;
  }

  function badgeOpcion(texto) {
    const c = U.colorOpcionAfinidad(texto);
    if (c.cls) return `<span class="${c.cls}">${c.icon} ${U.escapeHtml(texto)}</span>`;
    return U.escapeHtml(texto);
  }

  // ---------- Ranking ----------

  function rankings(ests, analytics) {
    const { N, colorPair, recibidos } = analytics;
    const filas = ests.map((e, i) => ({
      i, codigo: e.codigo, nombre: e.nombre,
      verdes: recibidos[i].verde,
      amarillos: recibidos[i].amarillo,
      rojos: recibidos[i].rojo,
      blancos: recibidos[i].blanco,
      positivos: recibidos[i].total_positivo,
      negativos: recibidos[i].total_negativo,
    }));

    const masElegidos = filas.slice().sort((a, b) =>
      b.verdes - a.verdes || b.positivos - a.positivos || a.nombre.localeCompare(b.nombre, "es"));

    // Aislados: 0 verdes recibidos y 0 positivos en preguntas Q5..Q9.
    const aislados = filas
      .filter((f) => f.verdes === 0 && f.positivos === 0)
      .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));

    const reciprocas = [];
    const conflictos = [];
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const a = colorPair[i][j], b = colorPair[j][i];
        if (a === "verde" && b === "verde") {
          reciprocas.push({ a: ests[i].nombre, b: ests[j].nombre });
        } else if (a === "rojo" && b === "rojo") {
          conflictos.push({ a: ests[i].nombre, b: ests[j].nombre });
        }
      }
    }
    reciprocas.sort((x, y) => x.a.localeCompare(y.a, "es"));
    conflictos.sort((x, y) => x.a.localeCompare(y.a, "es"));

    return { masElegidos, aislados, reciprocas, conflictos };
  }

  function renderRankings(rk) {
    const wrap = el("div", { class: "rep-card" });
    wrap.innerHTML = `
      <div class="rep-card-head">
        <h4>Rankings y vínculos destacados</h4>
        <div class="muted">Quién es elegido, quién queda aislado y los pares mutuos</div>
      </div>
    `;
    const grid = el("div", { class: "rep-rank-grid" });

    grid.appendChild(rankColumna("Más elegidos (verdes)",
      rk.masElegidos.slice(0, 12),
      (f) => `<span class="rep-pill rep-pill-verde">${f.verdes} verde(s)</span>`,
      (f) => U.escapeHtml(f.nombre),
      "rep-rank-verde"
    ));
    grid.appendChild(rankColumna("Aislados (sin nominaciones positivas)",
      rk.aislados.slice(0, 30),
      () => `<span class="rep-pill rep-pill-blanco">sin votos</span>`,
      (f) => U.escapeHtml(f.nombre),
      "rep-rank-blanco",
      rk.aislados.length === 0 ? "Ningún alumno aislado 🎉" : null
    ));
    grid.appendChild(rankColumna("Vínculos recíprocos (verde mutuo)",
      rk.reciprocas.slice(0, 30),
      () => `<span class="rep-pill rep-pill-verde">↔</span>`,
      (p) => `${U.escapeHtml(p.a)} <span class="muted">↔</span> ${U.escapeHtml(p.b)}`,
      "rep-rank-verde",
      rk.reciprocas.length === 0 ? "Sin pares con verde mutuo declarado." : null
    ));
    grid.appendChild(rankColumna("Conflictos (rojo mutuo)",
      rk.conflictos.slice(0, 30),
      () => `<span class="rep-pill rep-pill-rojo">↯</span>`,
      (p) => `${U.escapeHtml(p.a)} <span class="muted">↯</span> ${U.escapeHtml(p.b)}`,
      "rep-rank-rojo",
      rk.conflictos.length === 0 ? "Sin rojos mutuos declarados." : null
    ));

    wrap.appendChild(grid);
    return wrap;
  }

  function rankColumna(titulo, items, derecha, izquierda, clsExtra, vacioMsg) {
    const c = el("div", { class: "rep-rank-col " + (clsExtra || "") });
    const head = el("div", { class: "rep-rank-titulo" }, titulo);
    c.appendChild(head);
    if (!items.length) {
      c.appendChild(el("div", { class: "rep-rank-vacio muted" }, vacioMsg || "—"));
      return c;
    }
    const list = el("ol", { class: "rep-rank-lista" });
    items.forEach((it) => {
      const li = el("li", null, null);
      li.innerHTML = `<span class="rep-rank-nombre">${izquierda(it)}</span>${derecha(it)}`;
      list.appendChild(li);
    });
    c.appendChild(list);
    return c;
  }

  // ---------- Ficha por alumno ----------

  function renderFichas(ests, analytics, preguntas) {
    const wrap = el("div", { class: "rep-card" });
    wrap.innerHTML = `
      <div class="rep-card-head">
        <h4>Ficha por alumno</h4>
        <div class="muted">Una página por estudiante: emitidas y recibidas, por color y por pregunta.</div>
      </div>
    `;

    const ordenados = ests.slice().sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    if (!ordenados.length) {
      wrap.appendChild(el("p", { class: "muted" }, "No hay alumnos para mostrar."));
      return wrap;
    }

    // Selector de alumno + contenedor donde se renderiza la ficha.
    const head = el("div", { class: "rep-fichas-head" });
    head.innerHTML = `
      <label class="rep-label">Alumno
        <select id="ficha-select" class="cuestionario-select">
          ${ordenados.map((e) => `<option value="${U.escapeHtml(e.codigo)}">${U.escapeHtml(e.nombre)}</option>`).join("")}
        </select>
      </label>
      <button class="btn btn-gray btn-sm" id="ficha-todas" title="Renderiza todas las fichas para imprimir o exportar a PDF desde la barra de la sección">Ver todas</button>
    `;
    wrap.appendChild(head);
    const cont = el("div", { class: "rep-ficha-cont", id: "rep-ficha-cont" });
    wrap.appendChild(cont);

    function pintarFicha(codigo) {
      const e = ordenados.find((x) => x.codigo === codigo) || ordenados[0];
      cont.innerHTML = "";
      cont.appendChild(fichaAlumno(e, ests, analytics, preguntas));
    }

    head.querySelector("#ficha-select").addEventListener("change", (ev) => pintarFicha(ev.target.value));
    head.querySelector("#ficha-todas").addEventListener("click", () => {
      cont.innerHTML = "";
      ordenados.forEach((e) => cont.appendChild(fichaAlumno(e, ests, analytics, preguntas)));
    });

    pintarFicha(ordenados[0].codigo);
    return wrap;
  }

  function fichaAlumno(estudiante, ests, analytics, preguntas) {
    const i = analytics.idx[estudiante.codigo];
    const rec = analytics.recibidos[i] || {};
    const emi = analytics.emitidos[i] || {};
    const nombreDe = (j) => (ests[j] && ests[j].nombre) || "?";

    const card = el("div", { class: "rep-ficha pdf-page" });
    card.dataset.alumno = estudiante.codigo;
    card.innerHTML = `
      <div class="rep-ficha-titulo">
        <div>
          <div class="rep-ficha-nombre">${U.escapeHtml(estudiante.nombre)}</div>
          <div class="muted">Cédula ${U.escapeHtml(estudiante.codigo || "—")}${estudiante.fecha_nacimiento ? " · Nac. " + U.escapeHtml(estudiante.fecha_nacimiento) : ""} · Clase ${U.escapeHtml(estudiante.clase || "")}</div>
        </div>
        <div class="rep-ficha-resumen">
          <span class="rep-pill rep-pill-verde">${rec.verde || 0} verdes</span>
          <span class="rep-pill rep-pill-amarillo">${rec.amarillo || 0} amarillos</span>
          <span class="rep-pill rep-pill-rojo">${rec.rojo || 0} rojos</span>
          <span class="rep-pill rep-pill-blanco">${rec.blanco || 0} blancos</span>
        </div>
      </div>
      <div class="rep-ficha-grid">
        <div>
          <h5>Eligió a (Pregunta 1)</h5>
          ${bloqueColores(emi, nombreDe)}
        </div>
        <div>
          <h5>Lo eligieron (Pregunta 1)</h5>
          ${bloqueColoresRecibidos(estudiante, ests, analytics)}
        </div>
      </div>
      <h5 style="margin-top:12px">Otras preguntas</h5>
      ${tablaOtrasPreguntas(preguntas, emi, rec, nombreDe)}
    `;
    return card;
  }

  function bloqueColores(emi, nombreDe) {
    const linea = (k, label, cls) => {
      const ids = emi[k] || [];
      if (!ids.length) return `<div class="rep-ficha-linea"><span class="${cls}">${label}</span><span class="muted">— ninguno —</span></div>`;
      return `<div class="rep-ficha-linea"><span class="${cls}">${label}</span><span>${ids.map((j) => U.escapeHtml(nombreDe(j))).join(", ")}</span></div>`;
    };
    return linea("verde", "🟩 Verde", "opcion-verde") +
           linea("amarillo", "🟨 Amarillo", "opcion-amarillo") +
           linea("rojo", "🟥 Rojo", "opcion-rojo") +
           linea("blanco", "⚪ Blanco", "opcion-blanco");
  }

  function bloqueColoresRecibidos(estudiante, ests, analytics) {
    const j = analytics.idx[estudiante.codigo];
    const por = { verde: [], amarillo: [], rojo: [], blanco: [] };
    for (let i = 0; i < analytics.N; i++) {
      const c = analytics.colorPair[i][j];
      if (por[c]) por[c].push(ests[i].nombre);
    }
    const linea = (k, label, cls) => {
      const arr = por[k];
      if (!arr.length) return `<div class="rep-ficha-linea"><span class="${cls}">${label}</span><span class="muted">— nadie —</span></div>`;
      return `<div class="rep-ficha-linea"><span class="${cls}">${label}</span><span>${arr.map(U.escapeHtml).join(", ")}</span></div>`;
    };
    return linea("verde", "🟩 Verde", "opcion-verde") +
           linea("amarillo", "🟨 Amarillo", "opcion-amarillo") +
           linea("rojo", "🟥 Rojo", "opcion-rojo") +
           linea("blanco", "⚪ Blanco", "opcion-blanco");
  }

  function tablaOtrasPreguntas(preguntas, emi, rec, nombreDe) {
    const otras = (preguntas || []).filter((p) => p.numero !== 1);
    if (!otras.length) return `<p class="muted">No hay otras preguntas configuradas.</p>`;
    const filas = otras.map((p) => {
      const k = `q${p.numero}`;
      const emit = (emi[k] || []).map((j) => U.escapeHtml(nombreDe(j))).join(", ");
      const recCnt = rec[k] || 0;
      return `<tr>
        <td>P${p.numero}</td>
        <td>${U.escapeHtml(p.texto)}</td>
        <td>${emit || '<span class="muted">—</span>'}</td>
        <td class="num">${recCnt}</td>
      </tr>`;
    });
    return `<table class="rep-tabla rep-tabla-pregs">
      <thead><tr><th>#</th><th>Pregunta</th><th>Eligió a</th><th class="num">Veces nombrado</th></tr></thead>
      <tbody>${filas.join("")}</tbody>
    </table>`;
  }

  // ---------- Reporte de grupos ----------

  function reporteGrupos(ests, gruposLocal, analytics) {
    if (!gruposLocal || !gruposLocal.length) return [];
    const { idx, colorPair, recibidos } = analytics;
    return gruposLocal.map((g, gi) => {
      const codigos = (g.codigos || []).filter(Boolean);
      const miembros = codigos.map((c) => ests.find((e) => e.codigo === c)).filter(Boolean);

      let verdeMutuo = 0, verdeUni = 0, amarillo = 0, rojo = 0, rojoMutuo = 0, blanco = 0;
      const alertas = [];
      for (let a = 0; a < miembros.length; a++) {
        for (let b = a + 1; b < miembros.length; b++) {
          const i = idx[miembros[a].codigo], j = idx[miembros[b].codigo];
          if (i == null || j == null) continue;
          const ca = colorPair[i][j], cb = colorPair[j][i];
          if (ca === "rojo" && cb === "rojo") {
            rojo++; rojoMutuo++;
            alertas.push(`Rojo mutuo: ${miembros[a].nombre} ↯ ${miembros[b].nombre}`);
          } else if (ca === "rojo" || cb === "rojo") {
            rojo++;
          } else if (ca === "verde" && cb === "verde") {
            verdeMutuo++;
          } else if (ca === "verde" || cb === "verde") {
            verdeUni++;
          } else if (ca === "amarillo" || cb === "amarillo") {
            amarillo++;
          } else {
            blanco++;
          }
        }
      }
      const total = verdeMutuo + verdeUni + amarillo + rojo + blanco;

      // Líder declarado (más nominaciones Q8 + Q10 en el grupo).
      const ranking = miembros.map((m) => {
        const r = recibidos[idx[m.codigo]] || {};
        return {
          codigo: m.codigo, nombre: m.nombre,
          lider: (r.q8 || 0) + (r.q10 || 0),
          verdes: r.verde || 0, rojos: r.rojo || 0,
          apoyo: r.q13 || 0, aislado: r.q12 || 0,
        };
      });
      const lider = ranking.slice().sort((a, b) => b.lider - a.lider || b.verdes - a.verdes)[0];
      if (!lider || lider.lider === 0) alertas.push("Sin líder declarado claramente");
      if (ranking.filter((r) => r.apoyo > 0).length >= 2) alertas.push("Concentración de alumnos que necesitan apoyo");

      return {
        nombre: g.nombre || `Grupo ${gi + 1}`,
        miembros: ranking,
        relaciones: { verdeMutuo, verdeUni, amarillo, rojo, rojoMutuo, blanco, total },
        alertas,
        lider: lider && lider.lider > 0 ? lider : null,
      };
    });
  }

  function renderReporteGrupos(rep) {
    const wrap = el("div", { class: "rep-card" });
    wrap.innerHTML = `
      <div class="rep-card-head">
        <h4>Reporte de grupos armados</h4>
        <div class="muted">Composición, afinidad interna y alertas para cada equipo.</div>
      </div>
    `;
    if (!rep.length) {
      wrap.appendChild(el("p", { class: "muted" }, "Todavía no armaste grupos. Generalos en el paso 3 y volvé acá."));
      return wrap;
    }
    rep.forEach((g) => {
      const card = el("div", { class: "rep-grupo pdf-page" });
      const pct = (n) => g.relaciones.total ? Math.round((n / g.relaciones.total) * 100) : 0;
      card.innerHTML = `
        <div class="rep-grupo-head">
          <h4>${U.escapeHtml(g.nombre)}</h4>
          <div class="rep-grupo-meta">${g.miembros.length} integrante(s)${g.lider ? ` · Líder: <b>${U.escapeHtml(g.lider.nombre)}</b>` : ""}</div>
        </div>
        <div class="rep-grupo-bars">
          ${barRel("Verde mutuo",   g.relaciones.verdeMutuo, pct(g.relaciones.verdeMutuo), "verde")}
          ${barRel("Verde unilateral", g.relaciones.verdeUni, pct(g.relaciones.verdeUni), "verde-uni")}
          ${barRel("Amarillo",      g.relaciones.amarillo,   pct(g.relaciones.amarillo), "amarillo")}
          ${barRel("Sin opinión",   g.relaciones.blanco,     pct(g.relaciones.blanco), "blanco")}
          ${barRel("Rojo",          g.relaciones.rojo,       pct(g.relaciones.rojo), "rojo")}
        </div>
        <table class="rep-tabla">
          <thead><tr><th>Integrante</th><th class="num">Verdes</th><th class="num">Rojos</th><th class="num">Líder</th><th class="num">Apoyo</th></tr></thead>
          <tbody>${g.miembros.map((m) => `
            <tr>
              <td>${U.escapeHtml(m.nombre)}</td>
              <td class="num">${m.verdes}</td>
              <td class="num">${m.rojos}</td>
              <td class="num">${m.lider}</td>
              <td class="num">${m.apoyo}</td>
            </tr>`).join("")}
          </tbody>
        </table>
        ${g.alertas.length ? `<div class="rep-grupo-alertas"><b>Alertas:</b><ul>${g.alertas.map((a) => `<li>${U.escapeHtml(a)}</li>`).join("")}</ul></div>` : ""}
      `;
      wrap.appendChild(card);
    });
    return wrap;
  }

  function barRel(label, count, pct, cls) {
    return `<div class="rep-grupo-bar">
      <div class="rep-grupo-bar-lbl"><span>${label}</span><span>${count} · ${pct}%</span></div>
      <div class="rep-bar"><div class="rep-bar-fill rep-bar-${cls}" style="width:${pct}%"></div></div>
    </div>`;
  }

  window.REPORTES = {
    calcularAnalytics,
    statsPreguntas,
    rankings,
    reporteGrupos,
    renderTablaPreguntas,
    renderRankings,
    renderFichas,
    renderFichaAlumno: fichaAlumno,
    renderReporteGrupos,
  };
})();
