// Algoritmo de formación de grupos sociométricamente informado.
//
// Base teórica (resumen, referencias al final):
//   - Test sociométrico de Moreno (1934): relaciones declaradas (quién
//     elige a quién) predicen cohesión y conflicto en el grupo real.
//   - Peer nomination (Coie & Dodge, 1988): categorizar a los alumnos por
//     aceptación/rechazo ayuda a detectar "aislados", "rechazados",
//     "controvertidos" y "populares". Cada categoría necesita distinto
//     tratamiento en el armado.
//   - Cooperative learning (Johnson & Johnson, 1999): los grupos
//     heterogéneos (habilidad, rol, vínculo) funcionan mejor que los
//     homogéneos cuando la tarea exige interdependencia.
//   - Team composition (Salas, Stagl & Burke, 2004): el tamaño óptimo
//     para tareas colaborativas escolares cae entre 3 y 5 miembros.
//   - Optimización combinatoria: el problema es NP-duro
//     (maximum-weight k-clustering con restricciones). Se aborda con un
//     esquema heurístico en 4 fases que combina inserción greedy con
//     búsqueda local por swaps, análogo a los algoritmos de partición
//     de grafos con restricciones (Kernighan-Lin, 1970).
//
// Inputs:
//   students:   [{ codigo, nombre, clase }, ...]
//   responses:  array de respuestas (shape del Sheet: numero_pregunta,
//               opcion_texto, codigo, evaluado_codigo, ...)
//   opciones:   opciones de preguntas (para identificar colores de la 1).
//   params:     { tamGrupo = 4, permitirRojoMutuo = false,
//                 distribuirLideres = true, distribuirApoyo = true,
//                 estrategia = 'automatico',
//                 prioridad   = 'evitar_conflictos' }
//
//   estrategia (cómo se eligen semillas y el orden de inserción):
//     - 'automatico': semillas = alumnos más vulnerables (default histórico).
//     - 'liderazgo' : semillas = referentes (pregunta 7) para que cada grupo
//                     tenga al menos un líder declarado.
//     - 'inclusion' : semillas = aislados / rechazados, para distribuirlos.
//     - 'balanceado': semillas alternadas entre líderes y vulnerables.
//     - 'homogeneo' : semillas por cuartiles de "recibido positivo", y el
//                     candidato preferido es el más parecido al grupo.
//
//   prioridad (ajusta la función objetivo para insertar y hacer swaps):
//     - 'evitar_conflictos'    : penaliza fuerte cualquier arista negativa.
//     - 'maximizar_colaboracion': premia aristas verdes, sobre todo mutuas.
//     - 'desarrollar_liderazgo': premia agregar un líder a grupos sin líder.
//     - 'integrar_aislados'    : premia poner aislados junto a populares.
//
// Output:
//   {
//     grupos: [ { nombre, codigos:[], score, warnings:[] } ],
//     resumen: { scoreTotal, rojosMutuosInternos, aislados, lideresPorGrupo },
//     pares:   matriz simétrica normalizada útil para el sociograma,
//     estudiantes: lista de students (ref).
//   }

(function () {
  // Pesos de afinidad (pregunta 1, directa).
  const W = {
    VERDE: +3,
    AMARILLO: +1,
    ROJO: -5,
    BLANCO: 0,
    // Bonificaciones por reciprocidad.
    MUTUO_POSITIVO: +2,
    MUTUO_NEGATIVO: -5,
    // Contribuciones de preguntas abiertas (5..10).
    Q_AYUDA: +1,        // Q5
    Q_SENTIR_PARTE: +1, // Q6
    Q_CUESTA: -2,       // Q10
  };

  // Umbral para considerar a alguien "líder" / "aislado" / "apoyo".
  // Se expresa como fracción de compañeros de la clase. Si N = 25 y
  // el umbral es 0.2, 5+ nominaciones en Q7 ya lo marcan como líder.
  const UMBRAL_TAG = 0.2;

  function formarGrupos(students, responses, opciones, params) {
    const P = Object.assign(
      {
        tamGrupo: 4,
        permitirRojoMutuo: false,
        distribuirLideres: true,
        distribuirApoyo: true,
        estrategia: "automatico",
        prioridad: "evitar_conflictos",
      },
      params || {}
    );

    const ids = students.map((s) => s.codigo);
    const idx = {};
    ids.forEach((c, i) => (idx[c] = i));
    const N = ids.length;
    if (N === 0) return { grupos: [], resumen: {}, pares: [], estudiantes: [] };

    // Matriz dirigida de afinidad: score[i][j] = valoración de i hacia j.
    const score = matriz(N, 0);
    // Tags acumulados por alumno.
    const tag = Array.from({ length: N }, () => ({
      lider: 0, aislado: 0, apoyo: 0, recibePositivo: 0, recibeNegativo: 0,
    }));

    // Identificar opciones verde/amarillo/rojo/blanco de la pregunta 1.
    const opcionesP1 = (opciones || []).filter((o) => o.numero_pregunta === 1);
    const colorDeOpcion = {};
    opcionesP1.forEach((o) => {
      const t = (o.texto || "").toLowerCase();
      if (t.includes("verde")) colorDeOpcion[o.texto] = "verde";
      else if (t.includes("amarillo")) colorDeOpcion[o.texto] = "amarillo";
      else if (t.includes("rojo")) colorDeOpcion[o.texto] = "rojo";
      else if (t.includes("blanco")) colorDeOpcion[o.texto] = "blanco";
    });

    (responses || []).forEach((r) => {
      const i = idx[String(r.codigo).trim()];
      const j = idx[String(r.evaluado_codigo).trim()];
      if (i == null || j == null || i === j) return;
      const q = Number(r.numero_pregunta);
      if (q === 1) {
        const c = colorDeOpcion[r.opcion_texto] ||
          (r.opcion_texto ? r.opcion_texto.toLowerCase() : "");
        if (c === "verde")    { score[i][j] += W.VERDE; tag[j].recibePositivo++; }
        else if (c === "amarillo") { score[i][j] += W.AMARILLO; }
        else if (c === "rojo")     { score[i][j] += W.ROJO; tag[j].recibeNegativo++; }
      } else if (q === 5) { score[i][j] += W.Q_AYUDA; tag[j].recibePositivo++; }
      else if (q === 6)   { score[i][j] += W.Q_SENTIR_PARTE; tag[j].recibePositivo++; }
      else if (q === 7)   { tag[j].lider++; }
      else if (q === 8)   { tag[j].aislado++; }
      else if (q === 9)   { tag[j].apoyo++; }
      else if (q === 10)  { score[i][j] += W.Q_CUESTA; tag[j].recibeNegativo++; }
    });

    // Matriz simétrica de pares (cohesión esperable en un grupo).
    const pares = matriz(N, 0);
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        let s = score[i][j] + score[j][i];
        if (score[i][j] > 0 && score[j][i] > 0) s += W.MUTUO_POSITIVO;
        if (score[i][j] < 0 && score[j][i] < 0) s += W.MUTUO_NEGATIVO;
        pares[i][j] = pares[j][i] = s;
      }
    }

    // Umbrales de tag.
    const thr = Math.max(1, Math.ceil(N * UMBRAL_TAG));
    const esLider = (k) => tag[k].lider >= thr;
    const esApoyo = (k) => tag[k].apoyo >= thr;
    const esAislado = (k) => tag[k].aislado >= Math.max(1, Math.ceil(thr / 2));

    // --- Fase 2: determinar número de grupos ---
    const numGrupos = Math.max(1, Math.round(N / P.tamGrupo));

    // --- Fase 3: seeds según estrategia ---
    const vulnerabilidad = (k) =>
      tag[k].aislado * 3 + tag[k].apoyo * 2 + tag[k].recibeNegativo - tag[k].recibePositivo;
    const popularidad = (k) => tag[k].recibePositivo - tag[k].recibeNegativo;
    const idsIdx = ids.map((_, i) => i);

    const seeds = elegirSemillas(idsIdx, numGrupos, P.estrategia, {
      vulnerabilidad, popularidad, esLider, esAislado,
    });

    const grupos = [];
    const asignado = new Array(N).fill(false);
    seeds.forEach((seed, g) => {
      grupos.push({ miembros: [seed], nombre: `Grupo ${g + 1}` });
      asignado[seed] = true;
    });

    // --- Fase 4: inserción greedy ---
    // Orden de candidatos según estrategia.
    const pendientes = [];
    for (let i = 0; i < N; i++) if (!asignado[i]) pendientes.push(i);
    ordenarPendientes(pendientes, pares, P.estrategia, { popularidad, vulnerabilidad });

    const tamMax = P.tamGrupo + 1;
    for (const cand of pendientes) {
      let mejor = -1, mejorScore = -Infinity;
      for (let g = 0; g < grupos.length; g++) {
        const G = grupos[g];
        if (G.miembros.length >= tamMax) continue;
        if (!P.permitirRojoMutuo && violaRojoMutuo(cand, G.miembros, score)) continue;
        const s = scoreInsercion(cand, G.miembros, pares, score, P, {
          esLider, esApoyo, popularidad, tag,
        });
        if (s > mejorScore) { mejorScore = s; mejor = g; }
      }
      if (mejor === -1) {
        // Fallback: grupo más chico ignorando restricciones duras.
        mejor = 0;
        for (let g = 1; g < grupos.length; g++) {
          if (grupos[g].miembros.length < grupos[mejor].miembros.length) mejor = g;
        }
      }
      grupos[mejor].miembros.push(cand);
    }

    // --- Fase 5: búsqueda local por swaps (Kernighan-Lin simplificado) ---
    const maxIter = 250;
    for (let it = 0; it < maxIter; it++) {
      let mejora = false;
      for (let g1 = 0; g1 < grupos.length; g1++) {
        for (let g2 = g1 + 1; g2 < grupos.length; g2++) {
          for (const a of grupos[g1].miembros.slice()) {
            for (const b of grupos[g2].miembros.slice()) {
              const delta = deltaSwap(a, b, grupos[g1].miembros, grupos[g2].miembros, pares, score, P, {
                esLider, esApoyo, popularidad, tag,
              });
              if (delta > 0.0001) {
                swap(a, b, grupos[g1], grupos[g2]);
                mejora = true;
              }
            }
          }
        }
      }
      if (!mejora) break;
    }

    // --- Reporte ---
    const gruposOut = grupos.map((G, gi) => {
      const codigos = G.miembros.map((m) => students[m].codigo);
      const scoreGrupo = cohesionGrupo(G.miembros, pares);
      const warnings = [];
      for (let i = 0; i < G.miembros.length; i++) {
        for (let j = i + 1; j < G.miembros.length; j++) {
          const a = G.miembros[i], b = G.miembros[j];
          if (score[a][b] < 0 && score[b][a] < 0) {
            warnings.push(`Rojo mutuo entre ${students[a].nombre} y ${students[b].nombre}`);
          }
        }
      }
      if (G.miembros.every((m) => !esLider(m))) warnings.push("Sin referentes claros (pregunta 7)");
      if (G.miembros.filter(esApoyo).length >= 2) warnings.push("Concentración de alumnos que necesitan más apoyo");
      return {
        nombre: G.nombre,
        codigos,
        nombres: G.miembros.map((m) => students[m].nombre),
        score: scoreGrupo,
        warnings,
      };
    });

    const scoreTotal = gruposOut.reduce((a, g) => a + g.score, 0);
    const rojosMutuos = gruposOut.reduce((a, g) => a + g.warnings.filter((w) => w.startsWith("Rojo mutuo")).length, 0);
    const aislados = [];
    for (let i = 0; i < N; i++) if (esAislado(i)) aislados.push(students[i].nombre);

    return {
      grupos: gruposOut,
      resumen: {
        scoreTotal,
        rojosMutuosInternos: rojosMutuos,
        aislados,
        tamanos: gruposOut.map((g) => g.codigos.length),
      },
      pares,
      estudiantes: students,
      scoreDirigido: score,
    };
  }

  // ---- Helpers ----
  function matriz(n, v) {
    const m = new Array(n);
    for (let i = 0; i < n; i++) m[i] = new Array(n).fill(v);
    return m;
  }

  function intensidad(pares, i) {
    let s = 0;
    for (let j = 0; j < pares.length; j++) s += Math.abs(pares[i][j]);
    return s;
  }

  function violaRojoMutuo(cand, miembros, score) {
    for (const m of miembros) {
      if (score[cand][m] < 0 && score[m][cand] < 0) return true;
    }
    return false;
  }

  function cohesionGrupo(mbros, pares) {
    let s = 0;
    for (let i = 0; i < mbros.length; i++) {
      for (let j = i + 1; j < mbros.length; j++) s += pares[mbros[i]][mbros[j]];
    }
    return s;
  }

  function deltaSwap(a, b, G1, G2, pares, score, P, ctx) {
    // Antes: a en G1, b en G2. Después: a en G2 (sin b), b en G1 (sin a).
    let antes = 0, despues = 0;
    for (const m of G1) if (m !== a) { antes += pares[a][m]; despues += pares[b][m]; }
    for (const m of G2) if (m !== b) { antes += pares[b][m]; despues += pares[a][m]; }
    if (!P.permitirRojoMutuo) {
      // Si el swap introduce un rojo mutuo nuevo, se veta.
      for (const m of G2) if (m !== b && score[a][m] < 0 && score[m][a] < 0) return -Infinity;
      for (const m of G1) if (m !== a && score[b][m] < 0 && score[m][b] < 0) return -Infinity;
    }
    // Ajustes por prioridad: recalcular componentes del score que dependen
    // del grupo (no sólo de aristas), como "presencia de líder".
    const g1Sin = G1.filter((x) => x !== a);
    const g2Sin = G2.filter((x) => x !== b);
    const bonoAntes =
      bonoGrupoPorPrioridad(g1Sin.concat(a), P.prioridad, ctx) +
      bonoGrupoPorPrioridad(g2Sin.concat(b), P.prioridad, ctx);
    const bonoDespues =
      bonoGrupoPorPrioridad(g1Sin.concat(b), P.prioridad, ctx) +
      bonoGrupoPorPrioridad(g2Sin.concat(a), P.prioridad, ctx);
    return (despues - antes) + (bonoDespues - bonoAntes);
  }

  // ---- Estrategia y prioridad ----
  function elegirSemillas(idxs, k, estrategia, h) {
    if (k <= 0) return [];
    const byVuln = idxs.slice().sort((a, b) => h.vulnerabilidad(b) - h.vulnerabilidad(a));
    const byLider = idxs.slice().sort((a, b) => (h.esLider(b) - h.esLider(a)) || (h.popularidad(b) - h.popularidad(a)));
    const byPop = idxs.slice().sort((a, b) => h.popularidad(a) - h.popularidad(b)); // menos popular primero
    if (estrategia === "liderazgo") {
      return byLider.slice(0, k);
    }
    if (estrategia === "inclusion") {
      // Aislados/rechazados primero como semillas, para separarlos.
      return byPop.slice(0, k);
    }
    if (estrategia === "balanceado") {
      // Alterna líderes y vulnerables.
      const out = [], used = new Set();
      let i = 0, j = 0;
      while (out.length < k) {
        if (out.length % 2 === 0) {
          while (i < byLider.length && used.has(byLider[i])) i++;
          if (i < byLider.length) { out.push(byLider[i]); used.add(byLider[i]); i++; }
          else break;
        } else {
          while (j < byVuln.length && used.has(byVuln[j])) j++;
          if (j < byVuln.length) { out.push(byVuln[j]); used.add(byVuln[j]); j++; }
          else break;
        }
      }
      return out;
    }
    if (estrategia === "homogeneo") {
      // Semillas por cuartiles de popularidad para que cada grupo tenga un
      // punto de partida representativo de un tramo.
      const sorted = idxs.slice().sort((a, b) => h.popularidad(b) - h.popularidad(a));
      const out = [];
      for (let q = 0; q < k; q++) {
        const pos = Math.min(sorted.length - 1, Math.floor((q + 0.5) * sorted.length / k));
        out.push(sorted[pos]);
      }
      return out;
    }
    // 'automatico'
    return byVuln.slice(0, k);
  }

  function ordenarPendientes(pendientes, pares, estrategia, h) {
    if (estrategia === "homogeneo") {
      // Primero los más polarizados (igual que antes) para respetar restricciones;
      // el scoring por similitud se encarga del encaje.
      pendientes.sort((a, b) => intensidad(pares, b) - intensidad(pares, a));
      return;
    }
    if (estrategia === "inclusion") {
      pendientes.sort((a, b) => h.vulnerabilidad(b) - h.vulnerabilidad(a));
      return;
    }
    if (estrategia === "liderazgo") {
      pendientes.sort((a, b) => h.popularidad(b) - h.popularidad(a));
      return;
    }
    // 'automatico' y 'balanceado': por intensidad de opiniones.
    pendientes.sort((a, b) => intensidad(pares, b) - intensidad(pares, a));
  }

  function scoreInsercion(cand, miembros, pares, score, P, ctx) {
    let s = 0;
    for (const m of miembros) s += pares[cand][m];

    // Distribución de roles (como antes).
    if (P.distribuirLideres && ctx.esLider(cand) && miembros.some(ctx.esLider)) s -= 3;
    if (P.distribuirApoyo  && ctx.esApoyo(cand)  && miembros.some(ctx.esApoyo))  s -= 2;

    // Ajuste por prioridad.
    switch (P.prioridad) {
      case "maximizar_colaboracion": {
        // Premio extra por cada lazo verde mutuo con algún miembro actual.
        for (const m of miembros) {
          if (score[cand][m] > 0 && score[m][cand] > 0) s += 2;
        }
        break;
      }
      case "desarrollar_liderazgo": {
        // Si el grupo todavía no tiene líder y el candidato sí, premio.
        if (ctx.esLider(cand) && !miembros.some(ctx.esLider)) s += 4;
        break;
      }
      case "integrar_aislados": {
        // Poner un aislado/rechazado con un grupo de populares suma.
        const candVuln = ctx.tag[cand].aislado + ctx.tag[cand].recibeNegativo;
        if (candVuln > 0) {
          const popularidadGrupo = miembros.reduce((a, m) => a + ctx.popularidad(m), 0);
          if (popularidadGrupo > 0) s += Math.min(4, popularidadGrupo);
        }
        // Y desalentar poner varios vulnerables juntos.
        const vulnEnGrupo = miembros.filter((m) => ctx.tag[m].aislado + ctx.tag[m].recibeNegativo > 0).length;
        if (candVuln > 0 && vulnEnGrupo >= 1) s -= 3;
        break;
      }
      case "evitar_conflictos":
      default: {
        // Ya está en pares[] (el rojo pesa -5). Refuerzo extra por cada arista
        // negativa (incluso unilateral) con miembros actuales.
        for (const m of miembros) {
          if (score[cand][m] < 0 || score[m][cand] < 0) s -= 1;
        }
      }
    }

    // Homogeneidad: si estrategia es 'homogeneo', favorece candidatos con
    // popularidad similar al promedio del grupo.
    if (P.estrategia === "homogeneo" && miembros.length) {
      const prom = miembros.reduce((a, m) => a + ctx.popularidad(m), 0) / miembros.length;
      s -= Math.abs(ctx.popularidad(cand) - prom) * 0.5;
    }
    return s;
  }

  function bonoGrupoPorPrioridad(miembros, prioridad, ctx) {
    if (!ctx) return 0;
    if (prioridad === "desarrollar_liderazgo") {
      return miembros.some(ctx.esLider) ? 3 : 0;
    }
    if (prioridad === "integrar_aislados") {
      const vulnCount = miembros.filter((m) => ctx.tag[m].aislado + ctx.tag[m].recibeNegativo > 0).length;
      // Premio si hay exactamente un vulnerable (queda integrado sin juntarse
      // con otros).
      if (vulnCount === 1) return 2;
      if (vulnCount >= 2) return -2;
      return 0;
    }
    return 0;
  }

  function swap(a, b, G1, G2) {
    G1.miembros = G1.miembros.filter((x) => x !== a);
    G2.miembros = G2.miembros.filter((x) => x !== b);
    G1.miembros.push(b);
    G2.miembros.push(a);
  }

  window.GROUPS = { formarGrupos };
})();
