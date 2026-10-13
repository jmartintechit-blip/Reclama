# Fuentes legales: tipo legal de interés de demora

Este documento registra de dónde sale cada tipo de la tabla `data/legal-interest-rates.json` y qué está (y qué no está) comprobado. No es asesoría legal.

## Base legal

- **Ley 3/2004, de 29 de diciembre**, por la que se establecen medidas de lucha contra la morosidad en las operaciones comerciales, artículo 7.2: el tipo legal de interés de demora es el tipo del Banco Central Europeo en su última operación principal de financiación del semestre anterior, más ocho puntos porcentuales, y se aplica durante los seis meses siguientes.
- **Artículo 7.3:** el tipo se publica en el BOE cada semestre. Cada resolución de la Secretaría General del Tesoro que enlaza la tabla es esa publicación.

En la base de datos y en el JSON los tipos van en puntos básicos (pb): 10,40 % = 1040 pb. Se cumple siempre `tipo = BCE + 800 pb`.

## Tabla verificada (18 semestres)

| Semestre | Periodo de aplicación   | BCE % | Tipo % | Resolución BOE                                                                | Publicada en el BOE |
| -------- | ----------------------- | ----- | ------ | ----------------------------------------------------------------------------- | ------------------- |
| 2018-H1  | 2018-01-01 a 2018-06-30 | 0,00  | 8,00   | [BOE-A-2017-15428](https://www.boe.es/diario_boe/txt.php?id=BOE-A-2017-15428) | 2017-12-23          |
| 2018-H2  | 2018-07-01 a 2018-12-31 | 0,00  | 8,00   | [BOE-A-2018-9001](https://www.boe.es/diario_boe/txt.php?id=BOE-A-2018-9001)   | 2018-06-29          |
| 2019-H1  | 2019-01-01 a 2019-06-30 | 0,00  | 8,00   | [BOE-A-2018-17661](https://www.boe.es/diario_boe/txt.php?id=BOE-A-2018-17661) | 2018-12-22          |
| 2019-H2  | 2019-07-01 a 2019-12-31 | 0,00  | 8,00   | [BOE-A-2019-9730](https://www.boe.es/diario_boe/txt.php?id=BOE-A-2019-9730)   | 2019-06-28          |
| 2020-H1  | 2020-01-01 a 2020-06-30 | 0,00  | 8,00   | [BOE-A-2019-18736](https://www.boe.es/diario_boe/txt.php?id=BOE-A-2019-18736) | 2019-12-30          |
| 2020-H2  | 2020-07-01 a 2020-12-31 | 0,00  | 8,00   | [BOE-A-2020-6848](https://www.boe.es/diario_boe/txt.php?id=BOE-A-2020-6848)   | 2020-06-27          |
| 2021-H1  | 2021-01-01 a 2021-06-30 | 0,00  | 8,00   | [BOE-A-2020-17415](https://www.boe.es/diario_boe/txt.php?id=BOE-A-2020-17415) | 2020-12-31          |
| 2021-H2  | 2021-07-01 a 2021-12-31 | 0,00  | 8,00   | [BOE-A-2021-10869](https://www.boe.es/diario_boe/txt.php?id=BOE-A-2021-10869) | 2021-06-30          |
| 2022-H1  | 2022-01-01 a 2022-06-30 | 0,00  | 8,00   | [BOE-A-2021-21959](https://www.boe.es/diario_boe/txt.php?id=BOE-A-2021-21959) | 2021-12-31          |
| 2022-H2  | 2022-07-01 a 2022-12-31 | 0,00  | 8,00   | [BOE-A-2022-10844](https://www.boe.es/diario_boe/txt.php?id=BOE-A-2022-10844) | 2022-06-30          |
| 2023-H1  | 2023-01-01 a 2023-06-30 | 2,50  | 10,50  | [BOE-A-2022-24416](https://www.boe.es/diario_boe/txt.php?id=BOE-A-2022-24416) | 2022-12-30          |
| 2023-H2  | 2023-07-01 a 2023-12-31 | 4,00  | 12,00  | [BOE-A-2023-15221](https://www.boe.es/diario_boe/txt.php?id=BOE-A-2023-15221) | 2023-06-29          |
| 2024-H1  | 2024-01-01 a 2024-06-30 | 4,50  | 12,50  | [BOE-A-2023-26709](https://www.boe.es/diario_boe/txt.php?id=BOE-A-2023-26709) | 2023-12-29          |
| 2024-H2  | 2024-07-01 a 2024-12-31 | 4,25  | 12,25  | [BOE-A-2024-13089](https://www.boe.es/diario_boe/txt.php?id=BOE-A-2024-13089) | 2024-06-28          |
| 2025-H1  | 2025-01-01 a 2025-06-30 | 3,15  | 11,15  | [BOE-A-2024-27618](https://www.boe.es/diario_boe/txt.php?id=BOE-A-2024-27618) | 2024-12-31          |
| 2025-H2  | 2025-07-01 a 2025-12-31 | 2,15  | 10,15  | [BOE-A-2025-13217](https://www.boe.es/diario_boe/txt.php?id=BOE-A-2025-13217) | 2025-06-28          |
| 2026-H1  | 2026-01-01 a 2026-06-30 | 2,15  | 10,15  | [BOE-A-2025-27201](https://www.boe.es/diario_boe/txt.php?id=BOE-A-2025-27201) | 2025-12-31          |
| 2026-H2  | 2026-07-01 a 2026-12-31 | 2,40  | 10,40  | [BOE-A-2026-14327](https://www.boe.es/diario_boe/txt.php?id=BOE-A-2026-14327) | 2026-07-01          |

## Cómo y cuándo se verificó

- **Fecha:** 2026-10-14.
- **Cómo:** para cada una de las 18 resoluciones se descargaron de `boe.es` la página de texto (`txt.php?id=...`) y los metadatos XML (`xml.php?id=...`). De cada una se leyó: el tipo del BCE que cita, el tipo legal que declara, el semestre natural al que se aplica (en el título) y la fecha de publicación en el BOE. Se comprobó que la fecha de publicación del XML coincide con la de la página de texto y que el tipo del BCE y el tipo legal son los mismos en ambas.
- **Resultado:** en las 18 filas, tipo legal = BCE + 8,00 y el semestre coincide con el de la tabla. El código lo vuelve a comprobar en cada push (`npm run rates:verify`, sin red): semestres contiguos desde 2018-01-01 hasta 2026-12-31, cada uno empieza el 1 de enero o el 1 de julio, `semester_end` correcto, `tipo = BCE + 800`, formato y unicidad de `boe_ref`, y que una fila `VERIFIED` tiene referencia y fecha.

## Ventana soportada y caducidad

- **Ventana soportada: 2018-H1 a 2026-H2** (2018-01-01 a 2026-12-31).
- **Caduca el 2027-01-01.** Hasta que el BOE publique la resolución de 2027-H1 (se espera a finales de diciembre de 2026), un cálculo con días de 2027 devuelve `RATE_WINDOW`. Nunca se extrapola un tipo.
- **Mantenimiento cada semestre:** cuando el BOE publique la resolución, añadir una fila al JSON con `status: "VERIFIED"`, su `boe_ref` y `published_on`, leídos de la propia resolución, y pasar `npm run rates:verify`. Despliegue: `npm run build` ejecuta `rates:seed`, que hace _upsert_ de la tabla.

## Lo que NO está verificado

- **El tipo del BCE no se contrastó con el BCE.** Se toma tal como lo cita cada resolución del BOE, que es la fuente legal. No se comprobó contra la web del BCE.
- **La lectura de las 18 páginas se hizo con un script** que extrae los números del texto (no a mano página por página). Las comprobaciones cruzadas entre `txt.php` y `xml.php` y el invariante `BCE + 8,00` reducen el riesgo, pero no lo eliminan.
- **No se comprobó que estas resoluciones no hayan sido corregidas o sustituidas** (correcciones de errores del BOE) después de su publicación. Los metadatos XML de las 18 indican `estatus_derogacion = N` y `judicialmente_anulada = N`, pero eso no sustituye a una revisión en el BOE.
- **La redacción exacta de la Ley 3/2004 art. 7** se cita del texto de las propias resoluciones, no de la Ley consolidada.
- **No hay verificación automática contra el BOE.** `rates:verify` es offline: comprueba la coherencia interna del JSON, no que coincida con el BOE. Si alguien edita un tipo y su BCE a la vez de forma coherente, no lo detecta.
- **El tipo de 2027-H1 no existe todavía** y no está en la tabla.
