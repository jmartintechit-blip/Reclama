// Static guide content for every next action of the escalation ladder. The texts are Spanish
// because the freelancer reads them and sends the templates to Spanish debtors. What the legal
// statements rest on, and what was NOT checked, is recorded in docs/LEGAL-SOURCES.md: do not add a
// legal claim here without recording its source there. No amounts or percentages are written in
// the texts (they go stale): the figures come from the claim.
import type { NextActionKind } from './escalation.ts';

export const PLACEHOLDERS = [
  'debtor_name',
  'invoice_numbers',
  'total',
  'deadline',
  'sender_name',
  'demand_date',
] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

export interface GuideTemplate {
  text: string;
  // The placeholders used in `text`, each once, in order of first appearance.
  placeholders: readonly Placeholder[];
}

export interface ActionGuide {
  title: string;
  why: string;
  steps: readonly string[]; // shown as a numbered list
  prepare: readonly string[];
  outcomes: readonly string[]; // what can happen next (only the court step has them)
  notes: readonly string[];
  template: GuideTemplate | null;
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

// The placeholders of a text, each once, in order of first appearance. Refuses a name that is not
// allowed and any `{{` or `}}` that does not belong to a well-formed placeholder.
export function placeholdersOf(text: string): Placeholder[] {
  if (/\{\{|\}\}/.test(text.replace(PLACEHOLDER, ''))) {
    throw new Error('The template has an unbalanced {{ or }}');
  }
  const found: Placeholder[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1] ?? '';
    if (!(PLACEHOLDERS as readonly string[]).includes(name)) {
      throw new Error(`Unknown placeholder {{${name}}}`);
    }
    if (!found.includes(name as Placeholder)) found.push(name as Placeholder);
  }
  return found;
}

// Replaces every placeholder in one pass (a value is never read again, so a value that holds
// `{{total}}` stays as it is). Throws for an unknown placeholder and for one without a value:
// a letter must never leave with a hole in it.
export function renderTemplate(
  template: string,
  values: Partial<Record<Placeholder, string>>,
): string {
  placeholdersOf(template);
  return template.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = values[name as Placeholder];
    if (value === undefined) throw new Error(`No value for {{${name}}}`);
    return value;
  });
}

const REMINDER_TEXT = `Asunto: Recordatorio de pago pendiente

Hola {{debtor_name}}:

Te escribo para recordarte que siguen pendientes de pago las facturas {{invoice_numbers}}, por un importe total de {{total}}. Seguro que ha sido un descuido. ¿Puedes revisarlo y confirmarme cuándo las pagarás?

Si ya las has pagado, te agradecería que me enviaras el justificante.

Un saludo,
{{sender_name}}`;

const DEMAND_TEXT = `Asunto: Requerimiento formal de pago de las facturas {{invoice_numbers}}

Estimado/a {{debtor_name}}:

Adjunto encontrará el requerimiento formal de pago de las facturas {{invoice_numbers}}, vencidas y no pagadas. El importe total reclamado, con los intereses de demora de la Ley 3/2004, es de {{total}}.

Le requiero que abone esa cantidad antes del {{deadline}}. Transcurrido ese plazo sin que se haya atendido el pago, el acreedor podrá acudir a las vías de reclamación que procedan, incluida la judicial.

Atentamente,
{{sender_name}}`;

const BUROFAX_TEXT = `{{sender_name}} le comunica que, mediante requerimiento de fecha {{demand_date}}, le reclamó el pago de las facturas {{invoice_numbers}}, y que a día de hoy no consta que ese pago se haya realizado.

El importe total reclamado a la fecha de este escrito es de {{total}}, sin perjuicio de los intereses que sigan devengándose hasta el pago efectivo.

Se le concede un último plazo, hasta el {{deadline}}, para efectuar el pago. Transcurrido ese plazo sin que se haya atendido, {{sender_name}} acudirá a las vías de reclamación que procedan, incluida la judicial, sin necesidad de nuevo aviso.`;

export const ESCALATION_GUIDE: Record<NextActionKind, ActionGuide> = {
  SEND_REMINDER: {
    title: 'Envía un recordatorio amable',
    why: 'Muchos impagos son descuidos. Un mensaje cordial suele bastar y cuida la relación con tu cliente. Es un paso opcional: la ley no exige ningún aviso para que se devenguen intereses de demora (art. 5 de la Ley 3/2004), así que puedes saltártelo e ir al requerimiento formal.',
    steps: [
      'Comprueba que las facturas siguen sin pagar y que el cliente no te ha enviado ya un justificante.',
      'Copia el texto de abajo, ajústalo a tu forma de hablar con ese cliente y envíalo por email o por el canal que uséis.',
      'Cuando lo hayas enviado, regístralo en Reclama como «recordatorio enviado» con la fecha de envío.',
    ],
    prepare: [
      'Los números y las fechas de vencimiento de las facturas.',
      'El importe total que reclamas.',
      'El email o el contacto de la persona que paga las facturas.',
    ],
    outcomes: [],
    notes: ['Guarda una copia del mensaje y la prueba de que lo enviaste.'],
    template: {
      text: REMINDER_TEXT,
      placeholders: ['debtor_name', 'invoice_numbers', 'total', 'sender_name'],
    },
  },

  SEND_DEMAND: {
    title: 'Envía el requerimiento formal de pago',
    why: 'El requerimiento deja por escrito qué se debe, cuánto y hasta cuándo, con una fecha. No es un requisito legal para que corran los intereses de demora (art. 5 de la Ley 3/2004), pero es una reclamación extrajudicial del acreedor, y esas interrumpen la prescripción (art. 1973 del Código Civil). Además, te da un documento que podrás aportar si hay que ir más lejos.',
    steps: [
      'Genera el requerimiento en PDF con Reclama: usa los números de la reclamación, sin recalcular nada a mano.',
      'Revisa que tus datos y los del deudor son correctos.',
      'Envíalo al deudor de forma que puedas demostrar que lo ha recibido, y guarda la prueba del envío.',
      'Copia el texto de abajo como mensaje de acompañamiento, con la fecha límite de pago que hayas fijado.',
      'Regístralo en Reclama como «requerimiento enviado» con la fecha de envío.',
    ],
    prepare: [
      'El requerimiento en PDF.',
      'El contrato, el pedido o los albaranes que respaldan las facturas.',
      'El email o la dirección a la que enviarlo.',
    ],
    outcomes: [],
    notes: [
      'La fecha límite de pago es una decisión tuya: elige un plazo razonable y escríbelo en el mensaje.',
    ],
    template: {
      text: DEMAND_TEXT,
      placeholders: [
        'invoice_numbers',
        'debtor_name',
        'total',
        'deadline',
        'sender_name',
      ],
    },
  },

  SEND_BUROFAX: {
    title: 'Prepara un burofax',
    why: 'Si el requerimiento no ha dado resultado, un burofax es un envío postal con el que se suele poder acreditar el contenido del mensaje y la fecha de entrega. Es un paso opcional que se usa para dejar constancia antes de acudir al juzgado.',
    steps: [
      'Copia el texto de abajo y completa los datos que faltan.',
      'Contrata tú el envío del burofax (en una oficina de correos o con un servicio de burofax en línea) y pide que se certifique el contenido y el acuse de recibo.',
      'Guarda el justificante de envío y, cuando llegue, el acuse de recibo.',
      'Regístralo en Reclama como «burofax enviado» con la fecha de envío.',
    ],
    prepare: [
      'El texto de abajo, con los datos completados.',
      'El nombre y la dirección postal completos del destinatario.',
      'El importe total actualizado a la fecha del envío.',
      'La fecha del requerimiento anterior.',
    ],
    outcomes: [],
    notes: [
      'Reclama no envía burofaxes: solo te da el texto y esta guía. El envío lo contratas tú.',
      'El precio y las condiciones del servicio dependen del proveedor: compruébalos antes de contratar.',
    ],
    template: {
      text: BUROFAX_TEXT,
      placeholders: [
        'sender_name',
        'demand_date',
        'invoice_numbers',
        'total',
        'deadline',
      ],
    },
  },

  FILE_MONITORIO: {
    title: 'Presenta una petición de procedimiento monitorio',
    why: 'Si el deudor no ha pagado tras el requerimiento (y el burofax, si lo enviaste), el procedimiento monitorio es una vía judicial especial para reclamar deudas de dinero. Sirve para deudas dinerarias de cualquier importe que sean líquidas, determinadas, vencidas y exigibles, y que puedas acreditar con documentos, por ejemplo facturas o albaranes (art. 812 de la Ley de Enjuiciamiento Civil). La petición inicial es sencilla: no hace falta abogado ni procurador para presentarla (art. 814).',
    steps: [
      'Comprueba que la deuda cumple lo anterior: es dinero, está vencida, su importe está determinado y tienes documentos que la acreditan (documentos firmados por el deudor o con su sello o marca, o facturas, albaranes y otros documentos que suelen recoger las deudas entre empresas como las vuestras).',
      'Averigua el juzgado competente: es el Juzgado de Primera Instancia del domicilio o la residencia del deudor o, si no los conoces, el del lugar donde pueda ser hallado (art. 813). Si el deudor resulta estar en otro partido judicial, el juez puede dar por terminado el proceso y tendrías que presentarlo de nuevo ante el juzgado correcto.',
      'Redacta la petición inicial. Debe indicar quién es el deudor, los domicilios del acreedor y del deudor (o dónde pueden ser hallados), el origen y la cuantía de la deuda, y acompañar los documentos que la acreditan (art. 814). Puede hacerse en un impreso o formulario, en papel o por la sede electrónica: comprueba cuál admite tu juzgado.',
      'Como cuantía, usa el importe que te da Reclama (principal, intereses y, si lo reclamas, la indemnización por costes de cobro) e indica la fecha hasta la que se han calculado los intereses.',
      'Presenta la petición. Reclama no presenta nada ante el juzgado: lo haces tú o tu abogado. Comprueba antes si hay que pagar alguna tasa.',
      'Anota la fecha de presentación en Reclama como «monitorio presentado».',
    ],
    prepare: [
      'Facturas y albaranes, contrato o pedido y cualquier documento firmado por el deudor.',
      'El requerimiento de pago y, si lo enviaste, el burofax, con sus justificantes, por si quieres aportarlos (los artículos revisados no los exigen).',
      'Los datos del deudor: nombre o razón social, NIF y domicilio donde pueda ser hallado.',
      'Tus datos y tu domicilio.',
      'El cálculo de los intereses (anexo del requerimiento) y el importe total actualizado.',
      'La forma de presentación que admite el juzgado (papel o electrónica) y las tasas vigentes: compruébalo antes.',
    ],
    outcomes: [
      'Si el juzgado admite la petición, requerirá al deudor para que, en el plazo de veinte días, pague o se oponga por escrito explicando por qué no debe, en todo o en parte, la cantidad reclamada (art. 815).',
      'Si de los documentos se desprende que la cantidad no es correcta, el juez puede proponerte reclamar una cantidad menor. Tienes diez días para aceptar o rechazar, y si no respondes se entiende aceptada; si la rechazas, se te tiene por desistido y solo podrás reclamar por el procedimiento declarativo que corresponda (art. 815.3).',
      'El deudor paga: cuando lo acredite, el juzgado archiva las actuaciones (art. 817).',
      'El deudor se opone dentro del plazo: el asunto se resuelve en el juicio que corresponda y la sentencia tiene fuerza de cosa juzgada (art. 818). Si la cuantía supera la propia del juicio verbal, tendrás que presentar una demanda en el plazo de un mes desde que se te dé traslado de la oposición; si no lo haces, se sobresee el asunto y puedes ser condenado en costas (art. 818.2). Comprueba el límite vigente de cuantía del juicio verbal y si en ese caso necesitas abogado y procurador.',
      'El deudor no paga ni se opone: el procedimiento monitorio termina y puedes pedir que se despache ejecución contra el deudor, bastando para ello con tu solicitud (art. 816).',
    ],
    notes: [
      'Valora consultar a un abogado antes de presentar la petición, y sobre todo si el deudor se opone: el procedimiento tiene consecuencias (por ejemplo, las costas) y esta guía es solo orientativa.',
      'Esta guía resume los artículos 812 a 818 de la Ley de Enjuiciamiento Civil según el texto consolidado del BOE consultado el 18/10/2026. Las leyes cambian: comprueba la versión vigente.',
      'No incluye modelos oficiales, tasas ni nombres de juzgados concretos porque no se han podido verificar. Compruébalos en la web de la Administración de Justicia o en tu juzgado.',
    ],
    template: null,
  },

  DONE: {
    title: 'No quedan pasos pendientes',
    why: 'La reclamación está marcada como pagada o ya has presentado la petición de procedimiento monitorio.',
    steps: [
      'Si está pagada: comprueba que el cobro coincide con el importe reclamado y archiva los justificantes.',
      'Si has presentado el monitorio: atiende las comunicaciones del juzgado y responde dentro de los plazos que te indiquen.',
    ],
    prepare: [],
    outcomes: [],
    notes: [],
    template: null,
  },

  BLOCKED: {
    title: 'Antes de seguir, revisa el tipo de deudor',
    why: 'Reclama solo guía reclamaciones de morosidad entre empresas y profesionales (Ley 3/2004), y para este deudor no puede seguir.',
    steps: [
      'Abre la ficha del deudor y comprueba si es una empresa o un profesional, un consumidor o una administración pública.',
      'Si es una empresa o un profesional, márcalo como empresa y la guía continuará.',
      'Si es un consumidor o una administración pública, esta guía no aplica: consulta a un abogado o a un asesor sobre cómo reclamar.',
    ],
    prepare: [],
    outcomes: [],
    notes: [],
    template: null,
  },
};
