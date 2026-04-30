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
  // Pesos del algoritmo. Las constantes Q_* se aplican en sentido i→j: si el
  // alumno i nominó al alumno j en esa pregunta, el lazo dirigido i→j suma
  // ese peso. Los positivos también acumulan tag[j].recibePositivo (sirve
  // para detectar populares); los negativos suman tag[j].recibeNegativo.
  const W = {
    // Pregunta 1 (afinidad por colores).
    VERDE: +3,
    AMARILLO: +1,
    ROJO: -5,
    BLANCO: 0,
    // Bonificaciones por reciprocidad.
    MUTUO_POSITIVO: +2,
    MUTUO_NEGATIVO: -5,
    // Q5 - ¿Con quiénes te gustaría trabajar?  (deseo explícito de trabajar)
    Q_DESEA_TRABAJAR: +2,
    // Q6 - Si tuvieras que elegir uno solo  (primera opción, lazo más fuerte)
    Q_PRIMERA_OPCION: +4,
    // Q7 - ¿Con quién creés que podrías trabajar bien aunque no lo hayas
    //      hecho mucho?  (apertura a nuevos vínculos, max 3)
    Q_PODRIA_TRABAJAR: +1,
    // Q8 - ¿Quiénes ayudan a que el grupo funcione?  (refuerzo positivo)
    Q_AYUDA: +1,
    // Q9 - ¿Quiénes te hacen sentir parte?  (refuerzo social)
    Q_SENTIR_PARTE: +1,
    // Q14 - ¿Con quién te cuesta más trabajar?  (fricción adicional al rojo)
    Q_CUESTA: -2,
  };

  // Umbral para considerar a alguien "líder" / "aislado" / "apoyo".
  // Se expresa como fracción de compañeros de la clase. Si N = 25 y
  // el umbral es 0.2, 5+ nominaciones en Q10 ya lo marcan como líder.
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
        // Si está activo, todos los grupos quedan con el mismo tamaño ±1
        // (no se permite ningún grupo con menos de tamMin ni más de tamMax).
        tamanoEstricto: true,
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
      lider: 0,            // Q8 + Q10
      aislado: 0,          // Q12 (¿a quién le cuesta integrarse?)
      apoyo: 0,            // Q13 (¿quién necesita más apoyo?)
      recibePositivo: 0,
      recibeNegativo: 0,
      // Métricas adicionales por pregunta para mostrar en el dashboard.
      verdesRecibidos: 0,
      rojosRecibidos: 0,
      deseado: 0,           // Q5 - cuántos lo quieren en su grupo
      primeraOpcion: 0,     // Q6 - cuántos lo eligieron como única persona
      podriaTrabajar: 0,    // Q7 - cuántos lo nominaron como apertura
      ayuda: 0,             // Q8 - cuántos lo ven como facilitador
      sentirParte: 0,       // Q9 - cuántos se sienten parte por su presencia
      cuestaTrabajar: 0,    // Q14 - cuántos dicen que les cuesta trabajar con él/ella
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
        if (c === "verde")        { score[i][j] += W.VERDE;    tag[j].recibePositivo++; tag[j].verdesRecibidos++; }
        else if (c === "amarillo"){ score[i][j] += W.AMARILLO; }
        else if (c === "rojo")    { score[i][j] += W.ROJO;     tag[j].recibeNegativo++; tag[j].rojosRecibidos++; }
      }
      else if (q === 5)  { score[i][j] += W.Q_DESEA_TRABAJAR;  tag[j].recibePositivo++; tag[j].deseado++; }
      else if (q === 6)  { score[i][j] += W.Q_PRIMERA_OPCION;  tag[j].recibePositivo++; tag[j].primeraOpcion++; }
      else if (q === 7)  { score[i][j] += W.Q_PODRIA_TRABAJAR; tag[j].recibePositivo++; tag[j].podriaTrabajar++; }
      else if (q === 8)  { score[i][j] += W.Q_AYUDA;           tag[j].recibePositivo++; tag[j].lider++; tag[j].ayuda++; }
      else if (q === 9)  { score[i][j] += W.Q_SENTIR_PARTE;    tag[j].recibePositivo++; tag[j].sentirParte++; }
      else if (q === 10) { tag[j].lider++; }
      else if (q === 12) { tag[j].aislado++; }
      else if (q === 13) { tag[j].apoyo++; }
      else if (q === 14) { score[i][j] += W.Q_CUESTA;          tag[j].recibeNegativo++; tag[j].cuestaTrabajar++; }
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

    // --- Fase 2: determinar número de grupos y rangos de tamaño ---
    // numGrupos = ceil(N/tamGrupo) si queremos respetar el tamaño "tope",
    //             round(N/tamGrupo) si queremos que la mayoría tenga
    //             exactamente ese tamaño. Optamos por el segundo (más
    //             cercano al pedido del docente).
    const numGrupos = Math.max(1, Math.round(N / P.tamGrupo));
    const tamMin = Math.floor(N / numGrupos);
    const tamMax = Math.ceil(N / numGrupos);
    // Cap superior efectivo durante el greedy (deja flexibilidad si el
    // docente desactivó la opción estricta).
    const capInsercion = P.tamanoEstricto ? tamMax : tamMax + 1;

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

    for (const cand of pendientes) {
      let mejor = -1, mejorScore = -Infinity;
      for (let g = 0; g < grupos.length; g++) {
        const G = grupos[g];
        if (G.miembros.length >= capInsercion) continue;
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

    // --- Fase 4.5: balanceo estricto de tamaños ---
    // Después del greedy puede haber grupos por debajo de tamMin (si nadie
    // quiso entrar ahí) o por arriba de tamMax. Movemos miembros desde los
    // sobre-llenos hacia los sub-llenos, eligiendo en el grupo donante al
    // miembro con peor fit (menor aporte al grupo) y en el grupo receptor
    // posicionándolo siempre que no rompa el rojo-mutuo.
    if (P.tamanoEstricto) {
      let moves = 0, maxMoves = N * 2;
      while (moves++ < maxMoves) {
        const sobre = grupos.filter(g => g.miembros.length > tamMax);
        const sub   = grupos.filter(g => g.miembros.length < tamMin);
        if (!sobre.length && !sub.length) break;
        // Si hay grupos por arriba y por debajo, transferir 1 miembro.
        if (sobre.length && sub.length) {
          const donador = sobre[0];
          const receptor = sub[0];
          const m = peorMiembroParaGrupo(donador.miembros, pares);
          donador.miembros = donador.miembros.filter(x => x !== m);
          receptor.miembros.push(m);
          continue;
        }
        // Sólo hay grupos sub-llenos (algún seed quedó casi vacío). Tomamos
        // del grupo que tenga > tamMin (no excede tamMax) un miembro.
        if (sub.length) {
          const donador = grupos
            .filter(g => g.miembros.length > tamMin)
            .sort((a, b) => b.miembros.length - a.miembros.length)[0];
          if (!donador) break;
          const m = peorMiembroParaGrupo(donador.miembros, pares);
          donador.miembros = donador.miembros.filter(x => x !== m);
          sub[0].miembros.push(m);
          continue;
        }
        // Sólo hay grupos sobre-llenos (raro). Mover a otro con margen.
        if (sobre.length) {
          const receptor = grupos
            .filter(g => g.miembros.length < tamMax)
            .sort((a, b) => a.miembros.length - b.miembros.length)[0];
          if (!receptor) break;
          const m = peorMiembroParaGrupo(sobre[0].miembros, pares);
          sobre[0].miembros = sobre[0].miembros.filter(x => x !== m);
          receptor.miembros.push(m);
        }
      }
    }

    // --- Fase 5: búsqueda local por swaps (Kernighan-Lin simplificado) ---
    // Buscamos la MEJOR mejora por pasada y la aplicamos una sola vez antes
    // de re-evaluar. Iterar snapshots stale y aplicar varios swaps en la
    // misma pasada producía duplicados cuando un mismo miembro entraba a un
    // grupo y la siguiente iteración intentaba reinserirlo.
    const maxIter = 250;
    for (let it = 0; it < maxIter; it++) {
      let mejorDelta = 0.0001, mejorPar = null;
      for (let g1 = 0; g1 < grupos.length; g1++) {
        for (let g2 = g1 + 1; g2 < grupos.length; g2++) {
          for (const a of grupos[g1].miembros) {
            for (const b of grupos[g2].miembros) {
              const delta = deltaSwap(a, b, grupos[g1].miembros, grupos[g2].miembros, pares, score, P, {
                esLider, esApoyo, popularidad, tag,
              });
              if (delta > mejorDelta) {
                mejorDelta = delta;
                mejorPar = { g1, g2, a, b };
              }
            }
          }
        }
      }
      if (!mejorPar) break;
      swap(mejorPar.a, mejorPar.b, grupos[mejorPar.g1], grupos[mejorPar.g2]);
    }

    // --- Reporte ---
    const gruposOut = grupos.map((G, gi) => {
      const codigos = G.miembros.map((m) => students[m].codigo);
      const scoreGrupo = cohesionGrupo(G.miembros, pares);
      const warnings = [];

      // Relaciones internas por par (para visualizaciones).
      let relVerdeMutuo = 0, relVerdeUni = 0, relAmarillo = 0, relRojo = 0, relBlanco = 0;
      for (let i = 0; i < G.miembros.length; i++) {
        for (let j = i + 1; j < G.miembros.length; j++) {
          const a = G.miembros[i], b = G.miembros[j];
          const sa = score[a][b], sb = score[b][a];
          if (sa < 0 && sb < 0) {
            relRojo++;
            warnings.push(`Rojo mutuo entre ${students[a].nombre} y ${students[b].nombre}`);
          } else if (sa < 0 || sb < 0) {
            relRojo++;
          } else if (sa > 0 && sb > 0) {
            relVerdeMutuo++;
          } else if (sa > 0 || sb > 0) {
            relVerdeUni++;
          } else if (esAmbivalente(a, b, score, students)) {
            relAmarillo++;
          } else {
            relBlanco++;
          }
        }
      }
      if (G.miembros.every((m) => !esLider(m))) warnings.push("Sin referentes claros (pregunta 7)");
      if (G.miembros.filter(esApoyo).length >= 2) warnings.push("Concentración de alumnos que necesitan más apoyo");

      // Fit por miembro: cuánto suma el alumno al grupo (sum de pares con el
      // resto / N-1). Sirve para identificar miembros bisagra o en el borde.
      const fitPorMiembro = G.miembros.map((m) => {
        let suma = 0, n = 0;
        G.miembros.forEach((o) => { if (o !== m) { suma += pares[m][o]; n++; } });
        const t = tag[m];
        return {
          codigo: students[m].codigo,
          nombre: students[m].nombre,
          fit: n ? suma / n : 0,
          lider: esLider(m),
          apoyo: esApoyo(m),
          aislado: esAislado(m),
          popularidad: t.recibePositivo,
          // Métricas crudas por pregunta (sirven para tooltips en dashboard).
          verdesRecibidos: t.verdesRecibidos,
          rojosRecibidos: t.rojosRecibidos,
          deseado: t.deseado,
          primeraOpcion: t.primeraOpcion,
          podriaTrabajar: t.podriaTrabajar,
          ayuda: t.ayuda,
          sentirParte: t.sentirParte,
          cuestaTrabajar: t.cuestaTrabajar,
        };
      }).sort((a, b) => b.fit - a.fit);

      // Líder del grupo: prefer esLider con mayor popularidad, si no hay,
      // el de mayor popularidad general.
      const lideresEnGrupo = fitPorMiembro.filter(m => m.lider).sort((a, b) => b.popularidad - a.popularidad);
      const masPopular = fitPorMiembro.slice().sort((a, b) => b.popularidad - a.popularidad)[0];
      const lider = lideresEnGrupo[0] || (masPopular && masPopular.popularidad > 0 ? masPopular : null);

      return {
        nombre: G.nombre,
        codigos,
        nombres: G.miembros.map((m) => students[m].nombre),
        score: scoreGrupo,
        warnings,
        lider: lider ? { codigo: lider.codigo, nombre: lider.nombre } : null,
        relacionesInternas: {
          verdeMutuo: relVerdeMutuo,
          verdeUnilateral: relVerdeUni,
          amarillo: relAmarillo,
          rojo: relRojo,
          blanco: relBlanco,
          total: relVerdeMutuo + relVerdeUni + relAmarillo + relRojo + relBlanco,
        },
        fitPorMiembro,
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
        tamGrupoPedido: P.tamGrupo,
        tamMin, tamMax, numGrupos,
        // ¿Quedó algún grupo fuera del rango pedido?
        respetaTamanio: gruposOut.every(g => g.codigos.length >= tamMin && g.codigos.length <= tamMax),
      },
      pares,
      estudiantes: students,
      scoreDirigido: score,
      tags: tag,    // Métricas crudas por alumno (índice = posición en `students`).
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

  // ¿El vínculo a↔b tiene al menos una evaluación amarilla (sin verde ni rojo)?
  // La matriz `score` no distingue colores (sólo el peso sumado), así que
  // aproximamos: si score[a][b] o score[b][a] está entre W.BLANCO y W.AMARILLO
  // sin ser 0 exacto, lo consideramos amarillo.
  function esAmbivalente(a, b, score) {
    const sa = score[a][b], sb = score[b][a];
    return (sa > 0 && sa <= 1) || (sb > 0 && sb <= 1);
  }

  // Devuelve el miembro del grupo cuyo aporte (suma de pares con el resto)
  // es el más bajo. Sirve para decidir a quién sacar cuando hay que
  // rebalancear tamaños.
  function peorMiembroParaGrupo(miembros, pares) {
    let peor = miembros[0], peorFit = Infinity;
    for (const m of miembros) {
      let s = 0;
      for (const o of miembros) if (o !== m) s += pares[m][o];
      if (s < peorFit) { peorFit = s; peor = m; }
    }
    return peor;
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
