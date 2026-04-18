-- =========================================================================
-- Sociogramas - Schema completo para Supabase
--
-- Pegá este archivo entero en SQL Editor de Supabase y ejecutalo.
-- Crea tablas, índices, RLS, RPC, semilla de preguntas y la contraseña
-- inicial del administrador.
--
-- Para cambiar la contraseña del administrador después: ver el bloque
-- "set admin password" al final.
-- =========================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- TABLAS
-- ---------------------------------------------------------------------

create table if not exists clase (
  id            uuid primary key default gen_random_uuid(),
  identificador text not null,
  created_at    timestamptz not null default now()
);

create table if not exists cuestionario (
  id          uuid primary key default gen_random_uuid(),
  clase_id    uuid not null references clase(id) on delete cascade,
  estado      text not null default 'ACTIVA' check (estado in ('ACTIVA','CERRADA')),
  created_at  timestamptz not null default now(),
  closed_at   timestamptz
);

create table if not exists estudiante (
  id                uuid primary key default gen_random_uuid(),
  clase_id          uuid not null references clase(id) on delete cascade,
  cuestionario_id   uuid references cuestionario(id) on delete set null,
  nombre            text not null,
  codigo_estudiante text not null unique,
  completado        boolean not null default false,
  completado_at     timestamptz,
  created_at        timestamptz not null default now()
);

create table if not exists pregunta (
  id              uuid primary key default gen_random_uuid(),
  numero_pregunta integer not null unique,
  texto           text not null,
  tipo_pregunta   text not null check (tipo_pregunta in
                    ('AFINIDAD_ESTUDIANTE','MULTIPLE_SELECCION',
                     'MULTIPLE_OPCION','SELECCION_ESTUDIANTE')),
  es_obligatoria  boolean not null default true
);

create table if not exists opcion_pregunta (
  id           uuid primary key default gen_random_uuid(),
  pregunta_id  uuid not null references pregunta(id) on delete cascade,
  texto_opcion text not null,
  orden        integer not null default 0
);

create table if not exists respuesta (
  id                     uuid primary key default gen_random_uuid(),
  cuestionario_id        uuid not null references cuestionario(id) on delete cascade,
  estudiante_id          uuid not null references estudiante(id) on delete cascade,
  estudiante_evaluado_id uuid references estudiante(id) on delete cascade,
  pregunta_id            uuid not null references pregunta(id) on delete cascade,
  opcion_pregunta_id     uuid references opcion_pregunta(id) on delete set null,
  otro_texto             text,
  created_at             timestamptz not null default now()
);

create table if not exists app_config (
  key   text primary key,
  value text not null
);

create table if not exists grupo_armado (
  id              uuid primary key default gen_random_uuid(),
  cuestionario_id uuid not null references cuestionario(id) on delete cascade,
  nombre          text not null,
  estudiantes_ids uuid[] not null default '{}',
  created_at      timestamptz not null default now()
);

create index if not exists idx_estudiante_codigo       on estudiante(codigo_estudiante);
create index if not exists idx_estudiante_clase        on estudiante(clase_id);
create index if not exists idx_estudiante_cuestionario on estudiante(cuestionario_id);
create index if not exists idx_respuesta_estudiante    on respuesta(estudiante_id);
create index if not exists idx_respuesta_cuestionario  on respuesta(cuestionario_id);
create index if not exists idx_opcion_por_pregunta     on opcion_pregunta(pregunta_id);

-- ---------------------------------------------------------------------
-- RLS (todo bloqueado por defecto, se accede vía RPC SECURITY DEFINER)
-- ---------------------------------------------------------------------

alter table clase           enable row level security;
alter table cuestionario    enable row level security;
alter table estudiante      enable row level security;
alter table pregunta        enable row level security;
alter table opcion_pregunta enable row level security;
alter table respuesta       enable row level security;
alter table app_config      enable row level security;
alter table grupo_armado    enable row level security;

-- Permitimos lectura pública de las preguntas y opciones (no son sensibles).
drop policy if exists "preguntas son públicas"        on pregunta;
drop policy if exists "opciones son públicas"         on opcion_pregunta;
create policy "preguntas son públicas"
  on pregunta for select using (true);
create policy "opciones son públicas"
  on opcion_pregunta for select using (true);

-- Para el resto de las tablas no se crean políticas: anon queda bloqueado.
-- Todo el acceso ocurre a través de funciones SECURITY DEFINER.

-- ---------------------------------------------------------------------
-- HELPER: validar contraseña de admin
-- ---------------------------------------------------------------------

create or replace function _check_admin_password(p_password text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  stored text;
begin
  select value into stored from app_config where key = 'admin_password_hash';
  if stored is null then
    raise exception 'Admin password not configured';
  end if;
  return crypt(p_password, stored) = stored;
end;
$$;

-- ---------------------------------------------------------------------
-- RPC: login del estudiante
-- Devuelve datos del estudiante + lista de compañeros + estado del cuestionario.
-- ---------------------------------------------------------------------

create or replace function login_estudiante(p_codigo text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_est            estudiante%rowtype;
  v_clase          clase%rowtype;
  v_cuestionario   cuestionario%rowtype;
  v_companeros     jsonb;
begin
  select * into v_est from estudiante where codigo_estudiante = p_codigo;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'codigo_invalido');
  end if;

  select * into v_clase from clase where id = v_est.clase_id;

  if v_est.cuestionario_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'sin_cuestionario',
      'estudiante', jsonb_build_object('nombre', v_est.nombre),
      'clase', to_jsonb(v_clase)
    );
  end if;

  select * into v_cuestionario from cuestionario where id = v_est.cuestionario_id;

  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'nombre', e.nombre)
                              order by e.nombre), '[]'::jsonb)
    into v_companeros
    from estudiante e
   where e.cuestionario_id = v_est.cuestionario_id
     and e.id <> v_est.id;

  return jsonb_build_object(
    'ok', true,
    'estudiante', jsonb_build_object(
      'id', v_est.id,
      'nombre', v_est.nombre,
      'codigo_estudiante', v_est.codigo_estudiante,
      'completado', v_est.completado,
      'completado_at', v_est.completado_at
    ),
    'clase', to_jsonb(v_clase),
    'cuestionario', to_jsonb(v_cuestionario),
    'companeros', v_companeros
  );
end;
$$;

grant execute on function login_estudiante(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- RPC: submit_respuestas
--
-- Recibe el código del estudiante y un array de respuestas, todas dentro
-- de una transacción. Si el estudiante ya completó o el cuestionario está
-- cerrado, falla. Al terminar marca al estudiante como completado.
--
-- Formato esperado de p_respuestas:
-- [
--   {
--     "pregunta_id": "...uuid...",
--     "estudiante_evaluado_id": "...uuid..." | null,
--     "opcion_pregunta_id": "...uuid..." | null,
--     "otro_texto": "texto" | null
--   },
--   ...
-- ]
-- ---------------------------------------------------------------------

create or replace function submit_respuestas(p_codigo text, p_respuestas jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_est           estudiante%rowtype;
  v_cuestionario  cuestionario%rowtype;
  v_item          jsonb;
begin
  if p_respuestas is null or jsonb_typeof(p_respuestas) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'respuestas_invalidas');
  end if;

  select * into v_est from estudiante
   where codigo_estudiante = p_codigo
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'codigo_invalido');
  end if;
  if v_est.completado then
    return jsonb_build_object('ok', false, 'error', 'ya_completado');
  end if;
  if v_est.cuestionario_id is null then
    return jsonb_build_object('ok', false, 'error', 'sin_cuestionario');
  end if;

  select * into v_cuestionario from cuestionario where id = v_est.cuestionario_id;
  if v_cuestionario.estado <> 'ACTIVA' then
    return jsonb_build_object('ok', false, 'error', 'cuestionario_cerrado');
  end if;

  -- Borrar cualquier respuesta previa por las dudas (no debería haber)
  delete from respuesta where estudiante_id = v_est.id;

  for v_item in select * from jsonb_array_elements(p_respuestas) loop
    insert into respuesta (
      cuestionario_id, estudiante_id, estudiante_evaluado_id,
      pregunta_id, opcion_pregunta_id, otro_texto
    ) values (
      v_est.cuestionario_id,
      v_est.id,
      nullif(v_item->>'estudiante_evaluado_id','')::uuid,
      (v_item->>'pregunta_id')::uuid,
      nullif(v_item->>'opcion_pregunta_id','')::uuid,
      nullif(v_item->>'otro_texto','')
    );
  end loop;

  update estudiante
     set completado = true,
         completado_at = now()
   where id = v_est.id;

  return jsonb_build_object('ok', true, 'count', jsonb_array_length(p_respuestas));
end;
$$;

grant execute on function submit_respuestas(text, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------
-- RPC ADMIN
-- Todas reciben la contraseña como primer argumento.
-- ---------------------------------------------------------------------

create or replace function admin_check(p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not _check_admin_password(p_password) then
    return jsonb_build_object('ok', false);
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function admin_check(text) to anon, authenticated;

create or replace function admin_listar_clases(p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not _check_admin_password(p_password) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  select coalesce(jsonb_agg(row_to_json(t) order by created_at desc), '[]'::jsonb)
    into v_result
    from (
      select c.id, c.identificador, c.created_at,
             (select count(*) from estudiante e where e.clase_id = c.id) as estudiantes,
             (select id from cuestionario q
               where q.clase_id = c.id and q.estado='ACTIVA'
               order by created_at desc limit 1) as cuestionario_activo_id
        from clase c
    ) t;

  return jsonb_build_object('ok', true, 'data', v_result);
end;
$$;
grant execute on function admin_listar_clases(text) to anon, authenticated;

create or replace function admin_crear_clase(p_password text, p_identificador text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not _check_admin_password(p_password) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  insert into clase(identificador) values (p_identificador) returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;
grant execute on function admin_crear_clase(text, text) to anon, authenticated;

create or replace function admin_eliminar_clase(p_password text, p_clase_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not _check_admin_password(p_password) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  delete from clase where id = p_clase_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function admin_eliminar_clase(text, uuid) to anon, authenticated;

-- Carga estudiantes desde un JSON [{"nombre":"...", "codigo_estudiante":"..."}]
-- Si reset = true, borra los estudiantes previos de la clase.
create or replace function admin_importar_estudiantes(
  p_password   text,
  p_clase_id   uuid,
  p_estudiantes jsonb,
  p_reset      boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_count integer := 0;
  v_skipped integer := 0;
  v_codigo text;
  v_nombre text;
begin
  if not _check_admin_password(p_password) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  if p_reset then
    delete from estudiante where clase_id = p_clase_id;
  end if;

  for v_item in select * from jsonb_array_elements(p_estudiantes) loop
    v_nombre := trim(v_item->>'nombre');
    v_codigo := trim(v_item->>'codigo_estudiante');
    if v_nombre is null or v_nombre = '' or v_codigo is null or v_codigo = '' then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    begin
      insert into estudiante(clase_id, nombre, codigo_estudiante)
      values (p_clase_id, v_nombre, v_codigo);
      v_count := v_count + 1;
    exception when unique_violation then
      v_skipped := v_skipped + 1;
    end;
  end loop;

  return jsonb_build_object('ok', true, 'creados', v_count, 'omitidos', v_skipped);
end;
$$;
grant execute on function admin_importar_estudiantes(text, uuid, jsonb, boolean) to anon, authenticated;

create or replace function admin_eliminar_estudiante(p_password text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not _check_admin_password(p_password) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  delete from estudiante where id = p_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function admin_eliminar_estudiante(text, uuid) to anon, authenticated;

-- Permite "desbloquear" a un estudiante (lo marca como no completado y
-- borra sus respuestas) por si terminó por error o necesita rehacerlo.
create or replace function admin_resetear_estudiante(p_password text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not _check_admin_password(p_password) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  delete from respuesta where estudiante_id = p_id;
  update estudiante set completado = false, completado_at = null where id = p_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function admin_resetear_estudiante(text, uuid) to anon, authenticated;

-- Crear cuestionario y asignar a todos los estudiantes de la clase
create or replace function admin_crear_cuestionario(p_password text, p_clase_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not _check_admin_password(p_password) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  insert into cuestionario(clase_id, estado) values (p_clase_id, 'ACTIVA') returning id into v_id;
  update estudiante
     set cuestionario_id = v_id, completado = false, completado_at = null
   where clase_id = p_clase_id;
  delete from respuesta where cuestionario_id in
    (select id from cuestionario where clase_id = p_clase_id and id <> v_id);
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;
grant execute on function admin_crear_cuestionario(text, uuid) to anon, authenticated;

create or replace function admin_cerrar_cuestionario(p_password text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not _check_admin_password(p_password) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  update cuestionario set estado='CERRADA', closed_at=now() where id = p_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function admin_cerrar_cuestionario(text, uuid) to anon, authenticated;

create or replace function admin_reabrir_cuestionario(p_password text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not _check_admin_password(p_password) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  update cuestionario set estado='ACTIVA', closed_at=null where id = p_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function admin_reabrir_cuestionario(text, uuid) to anon, authenticated;

-- Devuelve TODO lo necesario para el dashboard de una clase.
create or replace function admin_dashboard(p_password text, p_clase_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_estudiantes jsonb;
  v_cuestionario cuestionario%rowtype;
  v_respuestas  jsonb;
  v_grupos      jsonb;
begin
  if not _check_admin_password(p_password) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  select * into v_cuestionario
    from cuestionario
   where clase_id = p_clase_id
   order by created_at desc limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'nombre', nombre,
           'codigo_estudiante', codigo_estudiante,
           'cuestionario_id', cuestionario_id,
           'completado', completado,
           'completado_at', completado_at
         ) order by nombre), '[]'::jsonb)
    into v_estudiantes
    from estudiante
   where clase_id = p_clase_id;

  if v_cuestionario.id is null then
    v_respuestas := '[]'::jsonb;
    v_grupos     := '[]'::jsonb;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', id,
             'estudiante_id', estudiante_id,
             'estudiante_evaluado_id', estudiante_evaluado_id,
             'pregunta_id', pregunta_id,
             'opcion_pregunta_id', opcion_pregunta_id,
             'otro_texto', otro_texto
           )), '[]'::jsonb)
      into v_respuestas
      from respuesta
     where cuestionario_id = v_cuestionario.id;

    select coalesce(jsonb_agg(to_jsonb(g) order by g.created_at), '[]'::jsonb)
      into v_grupos
      from grupo_armado g
     where g.cuestionario_id = v_cuestionario.id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'cuestionario', case when v_cuestionario.id is null then null else to_jsonb(v_cuestionario) end,
    'estudiantes',  v_estudiantes,
    'respuestas',   v_respuestas,
    'grupos',       v_grupos
  );
end;
$$;
grant execute on function admin_dashboard(text, uuid) to anon, authenticated;

-- Guardar grupos armados por el docente
create or replace function admin_guardar_grupos(
  p_password        text,
  p_cuestionario_id uuid,
  p_grupos          jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_ids  uuid[];
begin
  if not _check_admin_password(p_password) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  delete from grupo_armado where cuestionario_id = p_cuestionario_id;
  for v_item in select * from jsonb_array_elements(p_grupos) loop
    select array_agg((x)::uuid) into v_ids
      from jsonb_array_elements_text(v_item->'estudiantes_ids') as x;
    insert into grupo_armado(cuestionario_id, nombre, estudiantes_ids)
    values (p_cuestionario_id, v_item->>'nombre', coalesce(v_ids,'{}'));
  end loop;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function admin_guardar_grupos(text, uuid, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------
-- SEMILLA DE PREGUNTAS Y OPCIONES (idéntica al sistema anterior)
-- ---------------------------------------------------------------------

insert into pregunta (numero_pregunta, texto, tipo_pregunta, es_obligatoria) values
  (1,  '¿Cómo es trabajar con esta persona?',                                                                           'AFINIDAD_ESTUDIANTE', true),
  (2,  '¿Por qué te gusta trabajar con esta persona?',                                                                  'MULTIPLE_SELECCION',  true),
  (3,  '¿Qué hace que a veces funcione y otras no?',                                                                    'MULTIPLE_SELECCION',  true),
  (4,  '¿Qué te dificulta al trabajar con esta persona?',                                                               'MULTIPLE_SELECCION',  true),
  (5,  '¿Quiénes ayudan a que el grupo funcione bien?',                                                                  'MULTIPLE_SELECCION',  true),
  (6,  '¿Quiénes te hacen sentir parte del grupo cuando trabajan juntos/as?',                                            'MULTIPLE_SELECCION',  true),
  (7,  '¿Quiénes suelen tomar el rol de líder cuando trabajan en grupo?',                                                'MULTIPLE_SELECCION',  true),
  (8,  '¿Quiénes suelen quedarse sin grupo o no ser elegidos/as cuando hay que formar equipos?',                         'MULTIPLE_SELECCION',  true),
  (9,  '¿Quiénes creés que necesitan más apoyo para poder trabajar mejor en grupo?',                                     'MULTIPLE_SELECCION',  true),
  (10, '¿Con quién te cuesta más trabajar en grupo?',                                                                    'MULTIPLE_SELECCION',  true)
on conflict (numero_pregunta) do nothing;

-- Opciones de la pregunta 1 (afinidad: colores)
do $$
declare
  q1 uuid; q2 uuid; q3 uuid; q4 uuid;
begin
  select id into q1 from pregunta where numero_pregunta = 1;
  select id into q2 from pregunta where numero_pregunta = 2;
  select id into q3 from pregunta where numero_pregunta = 3;
  select id into q4 from pregunta where numero_pregunta = 4;

  if not exists (select 1 from opcion_pregunta where pregunta_id = q1) then
    insert into opcion_pregunta(pregunta_id, texto_opcion, orden) values
      (q1, 'Verde',    1),
      (q1, 'Amarillo', 2),
      (q1, 'Rojo',     3),
      (q1, 'Blanco',   4);
  end if;

  if not exists (select 1 from opcion_pregunta where pregunta_id = q2) then
    insert into opcion_pregunta(pregunta_id, texto_opcion, orden) values
      (q2, 'Participa en todo momento del trabajo',      1),
      (q2, 'Escucha cuando otros hablan',                2),
      (q2, 'Siempre cumple con lo que le toca',          3),
      (q2, 'Ayuda cuando alguien se tranca',             4),
      (q2, 'Me hace sentir cómodo/a en el grupo',        5),
      (q2, 'Propone ideas claras para avanzar',          6),
      (q2, 'Se mantiene tranquilo/a y respeta a todos',  7),
      (q2, 'Motiva a los demás a seguir o concentrarse', 8),
      (q2, 'Deja participar a todos sin imponerse',      9),
      (q2, 'Otro motivo',                                10);
  end if;

  if not exists (select 1 from opcion_pregunta where pregunta_id = q3) then
    insert into opcion_pregunta(pregunta_id, texto_opcion, orden) values
      (q3, 'Hace lo que le toca solo si se lo dicen',         1),
      (q3, 'Se dispersa mucho',                                2),
      (q3, 'Le cuesta tomar decisiones o hablar en grupo',     3),
      (q3, 'Depende de su humor o del día',                    4),
      (q3, 'A veces domina demasiado pero igual trabajamos bien', 5),
      (q3, 'Otro motivo',                                       6);
  end if;

  if not exists (select 1 from opcion_pregunta where pregunta_id = q4) then
    insert into opcion_pregunta(pregunta_id, texto_opcion, orden) values
      (q4, 'No cumple con lo que le toca',     1),
      (q4, 'Interrumpe o desconcentra',        2),
      (q4, 'No respeta opiniones ajenas',      3),
      (q4, 'Genera conflictos',                4),
      (q4, 'No participa',                     5),
      (q4, 'Otro motivo',                      6);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- SET ADMIN PASSWORD
-- ---------------------------------------------------------------------
-- Cambiá 'cambiame' por la contraseña que quieras antes de ejecutar.
insert into app_config (key, value)
values ('admin_password_hash', crypt('cambiame', gen_salt('bf')))
on conflict (key) do update set value = excluded.value;

-- Para cambiar la contraseña después:
--
--   update app_config
--      set value = crypt('NUEVA_PASSWORD', gen_salt('bf'))
--    where key = 'admin_password_hash';
