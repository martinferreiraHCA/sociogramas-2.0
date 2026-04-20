# Datos del sistema (CSVs)

Estos CSVs son la configuración del cuestionario (preguntas/opciones/flujos).
Editalos con Excel / Google Sheets / cualquier editor de texto y hacé commit.

> **Nota:** el listado de estudiantes y sus códigos **ya no está acá**.
> Ahora vive en la Google Sheet: una hoja por clase (nombre del tab = nombre
> de la clase) con columnas `Nombre` y `Código`. Desde el dashboard, el
> botón **Generar códigos** completa los códigos vacíos. El archivo
> `estudiantes.csv` queda en el repo sólo como ejemplo histórico.

## `preguntas.csv`
Lista de preguntas, ordenadas por `numero`. Columnas:

| columna | descripción |
|---------|-------------|
| `numero` | Orden de la pregunta (entero, único). |
| `texto`  | Enunciado que ve el alumno. |
| `tipo`   | `AFINIDAD` (una por compañero, con sub-pregunta), `MULTIPLE` (checkboxes, se muestra como sub-pregunta) o `SELECCION_COMPANEROS` (marcar varios compañeros). |

## `opciones.csv`
Opciones de las preguntas `AFINIDAD` y `MULTIPLE`. Columnas:

| columna | descripción |
|---------|-------------|
| `numero_pregunta` | Referencia a `preguntas.csv`. |
| `orden` | Orden dentro de la pregunta. |
| `texto` | Texto de la opción. Si contiene "Otro motivo", se pide texto libre. |

La pregunta de tipo `AFINIDAD` detecta los colores por el texto de la opción
(`Verde`, `Amarillo`, `Rojo`, `Blanco`).

## `flujos.csv`
Define qué sub-pregunta aparece según la opción elegida en la afinidad.
Columnas:

| columna | descripción |
|---------|-------------|
| `numero_pregunta` | Pregunta que dispara el flujo (típicamente 1). |
| `opcion_orden` | `orden` de la opción elegida en `opciones.csv`. |
| `siguiente_pregunta` | `numero` de la sub-pregunta a mostrar. Vacío = no se muestra nada. |

## `estudiantes.csv` (legado)
Formato original antes de la migración a Google Sheets. Se mantiene como
referencia de los datos de prueba, pero el sistema **no** lo lee.
