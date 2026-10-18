import { REPO_URL } from '../components/Layout.tsx';
import { EXAMPLE_SEGMENTS } from '../content/example.ts';
import { formatEUR, formatRate } from '../lib/format.ts';

const LEGAL_SOURCES_URL = `${REPO_URL}/blob/main/docs/LEGAL-SOURCES.md`;
const LAW_URL = 'https://www.boe.es/buscar/act.php?id=BOE-A-2004-21830';

export function Method() {
  const first = EXAMPLE_SEGMENTS[0];
  return (
    <div className="wrap prose">
      <title>Método de cálculo · Reclama</title>
      <h1>Cómo se calculan los intereses de demora</h1>
      <p className="lede">
        Reclama aplica la{' '}
        <a href={LAW_URL}>Ley 3/2004, de lucha contra la morosidad</a> en las
        operaciones comerciales. Esta página explica el cálculo paso a paso para
        que puedas repetirlo a mano.
      </p>

      <h2>El tipo de interés</h2>
      <p>
        El tipo legal de demora es el tipo del Banco Central Europeo en su
        última operación principal de financiación del semestre anterior, más 8
        puntos porcentuales. Se fija por semestre natural (de enero a junio y de
        julio a diciembre) y se publica en el BOE. En el segundo semestre de
        2026, por ejemplo, es del {formatRate(1040)}: {formatRate(240)} del BCE
        más 8 puntos.
      </p>

      <h2>Un tramo por semestre y por cambio de saldo</h2>
      <p>
        El cálculo se divide en tramos. Empieza uno nuevo cuando cambia el tipo
        (el 1 de enero y el 1 de julio) y cuando cambia el saldo pendiente, por
        ejemplo con un cobro parcial. Los intereses empiezan a contar el día
        siguiente al vencimiento, y un cobro reduce el saldo desde el día
        siguiente.
      </p>

      <h2>Cuenta de días</h2>
      <p>
        En cada tramo el interés es simple (no hay intereses sobre intereses) y
        se calcula así: saldo × tipo × días del tramo ÷ días del año. Los días
        son los reales del calendario y el año es el de ese tramo: 365 días, o
        366 si es bisiesto.
      </p>
      {first ? (
        <p className="worked">
          Ejemplo con el primer tramo de la portada:{' '}
          <span className="amt">
            {formatEUR(first.balance)} × {formatRate(first.rateBp)} ×{' '}
            {first.days} ÷ 365 = {formatEUR(first.interest)}
          </span>
        </p>
      ) : null}

      <h2>Céntimos y redondeo</h2>
      <p>
        Todos los importes se guardan como números enteros de céntimos, nunca
        con decimales de coma flotante, para que no aparezcan errores de
        redondeo. Cada tramo se redondea al céntimo (la mitad se redondea hacia
        arriba) y el total es la suma de los tramos ya redondeados: lo que ves
        en el desglose suma exactamente el total.
      </p>

      <h2>La compensación de 40 euros</h2>
      <p>
        El artículo 8 de la ley da derecho al acreedor a reclamar, además de los
        intereses, una cantidad fija de 40 euros por los costes de cobro cuando
        el deudor incurre en mora. Los tribunales no aplican siempre el mismo
        criterio sobre si son 40 euros por factura o una sola vez por
        reclamación, así que Reclama lo deja a tu elección:
      </p>
      <ul>
        <li>
          <b>Ninguna:</b> no se añade compensación.
        </li>
        <li>
          <b>Por factura:</b> 40 euros por cada factura vencida de la
          reclamación.
        </li>
        <li>
          <b>Por reclamación:</b> 40 euros una sola vez, aunque incluya varias
          facturas.
        </li>
      </ul>

      <h2>A quién se aplica</h2>
      <p>
        Reclama es para cobrar deudas entre empresas y profesionales. Las deudas
        de consumidores quedan fuera de esta ley, y las de administraciones
        públicas se rigen por reglas propias que Reclama no trata.
      </p>

      <h2>Límites</h2>
      <ul>
        <li>
          La tabla de tipos cubre desde el primer semestre de 2018 hasta el
          segundo de 2026. Hay que ampliarla cuando el BOE publique los tipos
          nuevos; hasta entonces, un cálculo con días de 2027 se rechaza en
          lugar de inventar un tipo.
        </li>
        <li>
          Reclama es una herramienta informativa, no asesoramiento jurídico.
          Ante una deuda importante, consulta a un abogado.
        </li>
      </ul>

      <h2>Fuentes</h2>
      <ul>
        <li>
          <a href={LAW_URL}>Texto consolidado de la Ley 3/2004 en el BOE</a>
        </li>
        <li>
          <a href={LEGAL_SOURCES_URL}>
            Fuentes legales de Reclama: cada tipo con su resolución del BOE
          </a>
        </li>
      </ul>
    </div>
  );
}
