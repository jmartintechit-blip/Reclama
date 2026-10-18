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
- **La redacción exacta de la Ley 3/2004 art. 7** se cita del texto de las propias resoluciones, no de la Ley consolidada. (Actualización 2026-10-18: el art. 7 sí se leyó después del texto consolidado; véase la sección de la Ley 3/2004 más abajo.)
- **No hay verificación automática contra el BOE.** `rates:verify` es offline: comprueba la coherencia interna del JSON, no que coincida con el BOE. Si alguien edita un tipo y su BCE a la vez de forma coherente, no lo detecta.
- **El tipo de 2027-H1 no existe todavía** y no está en la tabla.

# Fuentes legales: guía de escalado (requerimiento, burofax, monitorio)

Este apartado registra en qué se apoya el texto de `server/domain/escalation-guide.ts` y del motor `server/domain/escalation.ts`, y qué no está comprobado. No es asesoría legal. Todo lo que la guía afirma sobre la ley sale de aquí; si se añade una afirmación legal a la guía, hay que anotar aquí su fuente.

## Cómo y cuándo se verificó

- **Fecha:** 2026-10-18.
- **Cómo:** se descargó de `boe.es` el texto consolidado de cada norma (`https://www.boe.es/buscar/act.php?id=...`) y un script extrajo el texto de cada artículo, que se leyó entero. Es una lectura con script, no una consulta a mano de cada página: el riesgo de un fallo de extracción es bajo pero no nulo.
- **Qué versión:** la última redacción consolidada que mostraba el BOE ese día. La fecha de "en vigor desde" de cada artículo figura en las tablas.

| Norma                                                                          | Id BOE                                                                    |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Ley 1/2000, de 7 de enero, de Enjuiciamiento Civil (LEC)                       | [BOE-A-2000-323](https://www.boe.es/buscar/act.php?id=BOE-A-2000-323)     |
| Real Decreto de 24 de julio de 1889 por el que se publica el Código Civil (CC) | [BOE-A-1889-4763](https://www.boe.es/buscar/act.php?id=BOE-A-1889-4763)   |
| Ley 3/2004, de 29 de diciembre, de lucha contra la morosidad (Ley 3/2004)      | [BOE-A-2004-21830](https://www.boe.es/buscar/act.php?id=BOE-A-2004-21830) |

## Lo que sí está verificado (texto leído el 2026-10-18)

### Ley 3/2004

| Artículo | Qué dice (con palabras propias)                                                                                                                                                                               | Redacción vigente desde |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 3.1      | Se aplica a los pagos entre empresas, **y también entre empresas y la Administración** (conforme a la ley de contratos del sector público), y entre contratistas principales y sus proveedores.               | 2010-07-07              |
| 3.2.a    | Quedan fuera los pagos en operaciones en las que intervienen **consumidores**.                                                                                                                                | 2010-07-07              |
| 4.1      | Sin plazo pactado, el plazo de pago es de treinta días naturales desde la **recepción de las mercancías o la prestación de los servicios**, aunque la factura llegara antes.                                  | 2013-07-28              |
| 4.3      | Por pacto se puede ampliar el plazo, pero nunca por encima de 60 días naturales.                                                                                                                              | 2013-07-28              |
| 5        | El deudor incurre en mora, y debe el interés pactado o el legal, automáticamente por el mero incumplimiento del plazo, **sin aviso de vencimiento ni intimación** del acreedor.                               | (sin modificaciones)    |
| 7.1-7.3  | Interés de demora: el del contrato o, si no hay pacto, el legal (BCE más ocho puntos en la operación principal de financiación más reciente anterior al semestre), que se publica cada semestre en el BOE.    | 2013-07-28              |
| 8.1      | Si el deudor incurre en mora, el acreedor tiene derecho a una cantidad fija de 40 euros que se añade a la deuda sin petición expresa, y puede reclamar además los costes de cobro acreditados que la superen. | 2013-07-28              |
| 8.2      | El deudor no debe esa indemnización si no es responsable del retraso.                                                                                                                                         | 2013-07-28              |

**Consecuencias para el producto:**

- Los art. 4, 5, 7 y 8 coinciden con lo que cita el requerimiento en PDF (`server/services/letter.ts`), con las dos salvedades de abajo.
- Como el art. 5 dice que los intereses corren sin aviso, **el recordatorio, el requerimiento y el burofax no son requisitos legales** para reclamar intereses. Los art. 812-814 de la LEC tampoco piden un requerimiento previo al monitorio (no aparece en el texto leído). La guía los presenta como pasos prácticos y opcionales, y los plazos de espera del motor son una pauta de la aplicación, no plazos legales.
- **Discrepancia 1 (administraciones públicas).** El art. 3.1 incluye a la Administración como deudora. Que Reclama no admita deudores `PUBLIC_ADMIN` (`ClaimError DEBTOR_NOT_B2B` y los comentarios de `server/domain/claim.ts`) es una **decisión de producto**, no una exclusión de la ley: la deuda de una administración sigue las reglas de la contratación pública, que no se han leído. Por eso el motor y la guía dicen que Reclama no cubre ese caso, y no que la ley no se aplique. Resuelto el 2026-10-18: el comentario y el mensaje de `claim.ts` ya lo dicen así.
- **Discrepancia 2 (plazo estimado).** La nota del PDF "30 días naturales desde la fecha de emisión de la factura (art. 4)" es una aproximación: el art. 4.1 cuenta desde la recepción de las mercancías o la prestación del servicio, no desde la emisión de la factura. No se ha cambiado el PDF en esta tarea. Resuelto el 2026-10-18: la nota del PDF ahora dice que el vencimiento se estima en 30 días desde la emisión y que el plazo legal se cuenta desde la recepción.

### Código Civil

| Artículo | Qué dice (con palabras propias)                                                                                                                                                          | Redacción vigente desde        |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 1964.2   | Las acciones personales que no tienen plazo especial prescriben a los cinco años desde que puede exigirse el cumplimiento de la obligación (reforma de la Ley 42/2015).                  | 2015-10-07                     |
| 1973     | La prescripción de las acciones se interrumpe por su ejercicio ante los tribunales, por reclamación extrajudicial del acreedor y por cualquier reconocimiento de la deuda por el deudor. | (sin modificaciones indicadas) |

**Aviso de prescripción del motor:** avisa cuando la fecha de vencimiento más antigua de la reclamación es anterior a hoy menos cuatro años y medio (54 meses naturales). Los cuatro años y medio son una **elección de la aplicación** (medio año de margen sobre los cinco años del art. 1964.2), no un plazo legal. La fecha de vencimiento se toma de la primera franja de intereses de cada factura (el día anterior a su inicio), igual que el requerimiento en PDF.

### Ley de Enjuiciamiento Civil, procedimiento monitorio (arts. 812 a 818)

| Artículo | Qué dice (con palabras propias)                                                                                                                                                                                                                                                                                                                                                                                                    | Redacción vigente desde |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 812      | Puede usarse para pedir el pago de una deuda de dinero **de cualquier importe** (el texto no fija tope), líquida, determinada, vencida y exigible, acreditada con documentos firmados por el deudor o con su sello o marca, o con facturas, albaranes y otros documentos que habitualmente recogen ese tipo de deudas.                                                                                                             | 2011-10-31              |
| 813      | Es competente en exclusiva el Juzgado de Primera Instancia del domicilio o residencia del deudor (o, si no se conocen, donde pueda ser hallado). Si las averiguaciones sobre el domicilio fracasan o el deudor está en otro partido judicial, el juez da por terminado el proceso y el acreedor puede volver a instarlo ante el juzgado competente.                                                                                | 2015-10-01              |
| 814      | La petición inicial debe indicar la identidad del deudor, los domicilios del acreedor y del deudor (o dónde pueden ser hallados), el origen y la cuantía de la deuda, y acompañar los documentos. Puede hacerse en impreso o formulario, en papel o por sede electrónica. **No hace falta abogado ni procurador** para presentarla.                                                                                                | 2024-03-20              |
| 815      | Si los documentos bastan, el letrado de la Administración de Justicia requiere al deudor para que en **veinte días** pague o se oponga por escrito. Si de los documentos resulta que la cantidad no es correcta, el juez puede proponer reclamar una cantidad menor: el acreedor tiene diez días, se entiende aceptada si calla y, si la rechaza, se le tiene por desistido y solo puede reclamar en el procedimiento declarativo. | 2024-03-20              |
| 816      | Si el deudor ni paga ni comparece, el proceso monitorio termina y el acreedor puede pedir que se despache ejecución con la mera solicitud.                                                                                                                                                                                                                                                                                         | 2015-10-07              |
| 817      | Si el deudor paga y lo acredita, se archivan las actuaciones.                                                                                                                                                                                                                                                                                                                                                                      | 2015-10-01              |
| 818      | Si el deudor se opone a tiempo, el asunto se resuelve en el juicio que corresponda, con fuerza de cosa juzgada. Si la cuantía supera la del juicio verbal, el acreedor debe presentar demanda en un mes desde el traslado de la oposición o se sobresee el asunto con condena en costas al acreedor.                                                                                                                               | 2025-04-03              |

La guía de `FILE_MONITORIO` solo afirma cosas de esta tabla. Donde hace falta un dato que no se pudo verificar (tope de cuantía del juicio verbal, tasas, modelos oficiales, juzgados concretos), dice "comprueba el límite vigente" o equivalente y no escribe ninguna cifra.

## El burofax: solo guía, la aplicación nunca lo envía

Reclama **no envía burofaxes**: da el texto de la plantilla y los pasos para que el usuario lo contrate por su cuenta. La guía lo dice de forma explícita. Además, ninguna de las normas leídas regula el burofax, así que lo que la guía dice de él (que es un envío postal con el que suele poder acreditarse el contenido y la entrega, y que conviene pedir certificación de contenido y acuse de recibo) es **práctica habitual, no verificada** contra ninguna fuente oficial.

## Lo que NO está verificado en este apartado

- **Valor probatorio del burofax** y qué servicio concreto ofrece Correos u otros proveedores, plazos y precios. No se han consultado.
- **Tope de cuantía del juicio verbal** (el art. 818.2 lo usa como umbral; la guía no lo cita), **tasas judiciales, modelos oficiales, nombres de sedes electrónicas y juzgados concretos.**
- **Si hace falta abogado y procurador** cuando el deudor se opone y hay que presentar demanda: depende de reglas generales (otros artículos de la LEC) que no se han leído.
- **Otros artículos de la LEC citados dentro de los 812-818** (21, 161, 164, 381, 404, 438, 548, 576): solo se leyó el art. 161 de pasada; no se contrastó su contenido.
- **Si el importe con intereses y la indemnización de 40 euros se consideran "líquidos y determinados"** en un monitorio concreto. El art. 815.3 se cita tal cual, sin valorar cuándo se aplica.
- **Prescripción:** no se ha verificado si algún plazo especial aplica a cada tipo de deuda (el art. 1964.2 solo cubre las acciones sin plazo especial), la disposición transitoria 5 de la Ley 42/2015 para relaciones anteriores a 2015, si el derecho civil foral o autonómico fija otros plazos, ni los requisitos de prueba de la reclamación extrajudicial del art. 1973 ni la doctrina de los tribunales sobre ellos.
- **Deudores que son administraciones públicas:** las reglas aplicables (contratación pública) no se han leído; solo se sabe por el art. 3.1 que la Ley 3/2004 no las excluye.
- **La lectura se hizo con un script** que extrae el texto del HTML consolidado del BOE, y el texto consolidado puede cambiar: conviene repetir la lectura cada vez que se toque la guía y antes de cada entrega importante.
- **Ninguna de las pautas de espera** (7, 10 y 10 días) ni los cuatro años y medio del aviso de prescripción tienen base legal: son heurísticas de la aplicación.
